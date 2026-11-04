import { execFile } from 'child_process';
import { promisify } from 'util';
import { NatsConnection } from 'nats';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { ErrorCode, Subjects } from '../src/contracts';
import { createLogger } from '../src/shared/logger';
import { RunningService, startPermissionsService } from '../src/permissions/service';
import { NATS_URL, connectClient, request } from './helpers';

const docker = promisify(execFile);
const KEY = 'sk_resilience_cached';
const OTHER_KEY = 'sk_resilience_uncached';

/**
 * Failure scenarios against a dedicated PostgreSQL container that the test can pause or interfere with,
 * without affecting the other suites.
 */
describe('resilience', () => {
  let postgres: StartedPostgreSqlContainer;
  let service: RunningService | undefined;
  let client: NatsConnection;
  let bucket = '';

  const start = async () => {
    bucket = `resilience_${Date.now()}`;
    service = await startPermissionsService(
      {
        databaseUrl: postgres.getConnectionUri(),
        natsUrl: NATS_URL,
        cacheBucket: bucket,
        cacheTtlSeconds: 60,
        dbQueryTimeoutMs: 500,
        metricsPort: 0,
      },
      createLogger('resilience-test'),
    );
  };

  const check = (apiKey: string) =>
    request<{ allowed?: boolean; error?: { code: string } }>(client, Subjects.CHECK, {
      apiKey,
      module: 'orders',
      action: 'read',
    });
  const grant = (apiKey: string) =>
    request(client, Subjects.GRANT, { apiKey, module: 'orders', action: 'read' });

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
    client = await connectClient();
  });

  beforeEach(start);

  afterEach(async () => {
    await service?.stop();
    service = undefined;
  });

  afterAll(async () => {
    await client.drain();
    await postgres.stop();
  });

  it('keeps answering from PostgreSQL when the cache bucket disappears', async () => {
    await grant(KEY);
    expect(await check(KEY)).toEqual({ allowed: true });

    // Simulate losing the cache: delete the JetStream stream that backs the KV bucket.
    const jsm = await client.jetstreamManager();
    await jsm.streams.delete(`KV_${bucket}`);

    expect(await check(KEY)).toEqual({ allowed: true });
    expect(await check(OTHER_KEY)).toEqual({ allowed: false });
  });

  it('serves cached permissions while PostgreSQL is unreachable, and recovers afterwards', async () => {
    await grant(KEY);
    await check(KEY); // cached now

    await docker('docker', ['pause', postgres.getId()]);
    try {
      // Cached key: still answered, without touching the database.
      expect(await check(KEY)).toEqual({ allowed: true });

      // Uncached key: fails fast with a clear error instead of hanging.
      const started = Date.now();
      const reply = await check(OTHER_KEY);
      expect(reply.error?.code).toBe(ErrorCode.DatabaseUnavailable);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await docker('docker', ['unpause', postgres.getId()]);
    }

    expect(await check(OTHER_KEY)).toEqual({ allowed: false });
    expect(await grant(OTHER_KEY)).toEqual({ status: 'ok' });
  });
});
