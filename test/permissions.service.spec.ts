import { Pool } from 'pg';
import { KV, NatsConnection } from 'nats';

import { ErrorCode, Subjects } from '../src/contracts';
import { hashApiKey } from '../src/shared/hash';
import { RunningService } from '../src/permissions/service';
import { connectClient, createPool, openCache, request, resetState, startService } from './helpers';

const BUCKET = 'service_spec_cache';
const KEY = 'sk_test_0123456789';

describe('permissions service over NATS', () => {
  let service: RunningService;
  let client: NatsConnection;
  let cache: KV;
  let pool: Pool;

  const grant = (module: string, action: string, apiKey = KEY) =>
    request(client, Subjects.GRANT, { apiKey, module, action });
  const check = (module: string, action: string, apiKey = KEY) =>
    request<{ allowed: boolean }>(client, Subjects.CHECK, { apiKey, module, action });
  const list = (apiKey = KEY) =>
    request<{ permissions: { module: string; action: string }[] }>(client, Subjects.LIST, { apiKey });

  beforeAll(async () => {
    service = await startService(BUCKET);
    client = await connectClient();
    cache = await openCache(client, BUCKET);
    pool = createPool();
  });

  beforeEach(() => resetState(pool, cache));

  afterAll(async () => {
    await client.drain();
    await service.stop();
    await pool.end();
  });

  describe('grant / check / list / revoke', () => {
    it('grants a permission and reports it as allowed', async () => {
      expect(await grant('orders', 'read')).toEqual({ status: 'ok' });
      expect(await check('orders', 'read')).toEqual({ allowed: true });
      expect(await check('orders', 'write')).toEqual({ allowed: false });
    });

    it('answers allowed: false for an unknown API key instead of failing', async () => {
      // The original implementation crashed here: it read `.length` of a null cache entry.
      expect(await check('orders', 'read', 'sk_never_seen_before')).toEqual({ allowed: false });
      expect(await list('sk_never_seen_before')).toEqual({ permissions: [] });
    });

    it('lists all permissions of a key in a stable order', async () => {
      await grant('orders', 'write');
      await grant('orders', 'read');
      await grant('billing', 'read');

      expect(await list()).toEqual({
        permissions: [
          { module: 'billing', action: 'read' },
          { module: 'orders', action: 'read' },
          { module: 'orders', action: 'write' },
        ],
      });
    });

    it('is idempotent and reports whether a revoke removed anything', async () => {
      await grant('orders', 'read');
      await grant('orders', 'read');
      expect((await list()).permissions).toHaveLength(1);

      expect(
        await request(client, Subjects.REVOKE, { apiKey: KEY, module: 'orders', action: 'read' }),
      ).toEqual({
        status: 'ok',
        removed: true,
      });
      expect(
        await request(client, Subjects.REVOKE, { apiKey: KEY, module: 'orders', action: 'read' }),
      ).toEqual({
        status: 'ok',
        removed: false,
      });
      expect(await check('orders', 'read')).toEqual({ allowed: false });
    });

    it('normalizes module and action names to lowercase', async () => {
      await grant('Orders', 'READ');
      expect(await check('orders', 'read')).toEqual({ allowed: true });
    });

    it('accepts API keys with characters that are not valid KV keys', async () => {
      const apiKey = 'key with spaces/and*wildcards>äö';
      await grant('orders', 'read', apiKey);
      expect(await check('orders', 'read', apiKey)).toEqual({ allowed: true });
    });
  });

  describe('cache', () => {
    it('caches the permission list under a hash of the key, never the raw key', async () => {
      await grant('orders', 'read');
      await check('orders', 'read');

      const entry = await cache.get(hashApiKey(KEY));
      expect(entry?.json()).toEqual([{ module: 'orders', action: 'read' }]);
      for await (const key of await cache.keys()) {
        expect(key).not.toContain(KEY);
      }
    });

    it('serves reads from the cache and invalidates the entry on writes', async () => {
      await grant('orders', 'read');
      expect(await check('orders', 'read')).toEqual({ allowed: true }); // populates the cache

      // Change the database behind the service's back: the cached answer is still served...
      await pool.query('TRUNCATE permissions');
      expect(await check('orders', 'read')).toEqual({ allowed: true });

      // ...until a write invalidates it.
      await grant('billing', 'read');
      expect(await check('orders', 'read')).toEqual({ allowed: false });
      expect(await check('billing', 'read')).toEqual({ allowed: true });
    });

    it('caches empty results for unknown keys', async () => {
      await check('orders', 'read', 'sk_unknown_key_123');
      const entry = await cache.get(hashApiKey('sk_unknown_key_123'));
      expect(entry?.json()).toEqual([]);
    });
  });

  describe('contract validation', () => {
    it('rejects a body that is not JSON', async () => {
      const reply = await request<{ error: { code: string } }>(client, Subjects.CHECK, 'not json');
      expect(reply.error.code).toBe(ErrorCode.InvalidPayload);
    });

    it('rejects missing, malformed and unknown fields with details', async () => {
      const missing = await request<{ error: { code: string; details: { path: string }[] } }>(
        client,
        Subjects.GRANT,
        { apiKey: KEY, module: 'orders' },
      );
      expect(missing.error.code).toBe(ErrorCode.InvalidPayload);
      expect(missing.error.details.map((d) => d.path)).toContain('action');

      const malformed = await request<{ error: { code: string } }>(client, Subjects.GRANT, {
        apiKey: 'short',
        module: 'orders; DROP TABLE',
        action: 'read',
      });
      expect(malformed.error.code).toBe(ErrorCode.InvalidPayload);

      const unknown = await request<{ error: { code: string } }>(client, Subjects.LIST, {
        apiKey: KEY,
        admin: true,
      });
      expect(unknown.error.code).toBe(ErrorCode.InvalidPayload);
    });
  });

  describe('scaling', () => {
    it('keeps answering when one of two replicas in the queue group stops', async () => {
      const second = await startService(BUCKET);
      await grant('orders', 'read');

      await service.stop();
      service = second; // afterAll stops the remaining replica

      expect(await check('orders', 'read')).toEqual({ allowed: true });
      expect(await request(client, Subjects.HEALTH, {})).toEqual({ status: 'ok' });
    });
  });
});
