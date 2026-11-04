import request from 'supertest';
import { Pool } from 'pg';
import { KV, NatsConnection } from 'nats';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/gateway/app.module';
import { configureApp } from '../src/gateway/app.setup';
import { RunningService } from '../src/permissions/service';
import { NATS_URL, connectClient, createPool, openCache, resetState, startService } from './helpers';

const BUCKET = 'gateway_spec_cache';
const ADMIN = 'Bearer admin-token-0123456789';
const SERVICE = 'Bearer service-token-0123456789';
const KEY = 'sk_live_gateway_test_key';

describe('HTTP gateway → NATS → permissions service (e2e)', () => {
  let app: INestApplication;
  let service: RunningService;
  let client: NatsConnection;
  let cache: KV;
  let pool: Pool;

  const api = () => request(app.getHttpServer());
  const body = (module = 'orders', action = 'read') => ({ apiKey: KEY, module, action });

  beforeAll(async () => {
    service = await startService(BUCKET);
    client = await connectClient();
    cache = await openCache(client, BUCKET);
    pool = createPool();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          port: 0,
          natsUrl: NATS_URL,
          requestTimeoutMs: 2000,
          adminToken: ADMIN.slice('Bearer '.length),
          serviceToken: SERVICE.slice('Bearer '.length),
        }),
      ],
    }).compile();
    app = configureApp(moduleRef.createNestApplication({ logger: false }));
    await app.init();
  });

  beforeEach(() => resetState(pool, cache));

  afterAll(async () => {
    await app.close();
    await client.drain();
    await service.stop();
    await pool.end();
  });

  describe('authentication', () => {
    it('requires a bearer token', async () => {
      await api().post('/permissions/check').send(body()).expect(401);
      await api()
        .post('/permissions/check')
        .set('Authorization', 'Bearer wrong-token-value')
        .send(body())
        .expect(401);
    });

    it('lets the service token check but not manage permissions', async () => {
      await api().post('/permissions/check').set('Authorization', SERVICE).send(body()).expect(200);
      await api().post('/permissions/grant').set('Authorization', SERVICE).send(body()).expect(403);
      await api().post('/permissions/list').set('Authorization', SERVICE).send({ apiKey: KEY }).expect(403);
    });
  });

  describe('permissions flow', () => {
    it('grants, checks, lists and revokes through the gateway', async () => {
      await api()
        .post('/permissions/grant')
        .set('Authorization', ADMIN)
        .send(body())
        .expect(200, { status: 'ok' });

      await api()
        .post('/permissions/check')
        .set('Authorization', SERVICE)
        .send(body())
        .expect(200, { allowed: true });

      await api()
        .post('/permissions/list')
        .set('Authorization', ADMIN)
        .send({ apiKey: KEY })
        .expect(200, { permissions: [{ module: 'orders', action: 'read' }] });

      await api()
        .post('/permissions/revoke')
        .set('Authorization', ADMIN)
        .send(body())
        .expect(200, { status: 'ok', removed: true });

      await api()
        .post('/permissions/check')
        .set('Authorization', SERVICE)
        .send(body())
        .expect(200, { allowed: false });
    });

    it.each([
      ['a missing field', { apiKey: KEY, module: 'orders' }],
      ['an invalid module name', { apiKey: KEY, module: 'Orders!', action: 'read' }],
      ['a too-short API key', { apiKey: 'short', module: 'orders', action: 'read' }],
      ['an unknown field', { ...body(), admin: true }],
    ])('rejects %s with 400', async (_case, payload) => {
      await api().post('/permissions/grant').set('Authorization', ADMIN).send(payload).expect(400);
    });
  });

  describe('health and failure handling', () => {
    it('reports healthy when NATS and the service are up', async () => {
      await api().get('/health').expect(200, { status: 'ok', nats: 'up', permissionsService: 'up' });
    });

    // Runs last: stops the permissions service.
    it('returns 503 when no permissions-service instance is running', async () => {
      await service.stop();
      service = { nats: service.nats, stop: async () => undefined };

      await api().post('/permissions/check').set('Authorization', SERVICE).send(body()).expect(503);
      const health = await api().get('/health').expect(503);
      expect(health.body).toMatchObject({ status: 'degraded', permissionsService: 'down' });
    });
  });
});
