import request from 'supertest';
import { Pool } from 'pg';
import { KV, NatsConnection } from 'nats';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SpanKind } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { AppModule } from '../src/gateway/app.module';
import { configureApp } from '../src/gateway/app.setup';
import { RunningService } from '../src/permissions/service';
import { NATS_URL, connectClient, createPool, openCache, resetState, startService } from './helpers';

const BUCKET = 'observability_spec_cache';
const ADMIN = 'admin-token-0123456789';
const SERVICE = 'service-token-0123456789';
const KEY = 'sk_live_observability_key';

// Captures spans in memory instead of exporting them, so the test can inspect the trace.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

describe('observability', () => {
  let app: INestApplication;
  let service: RunningService;
  let client: NatsConnection;
  let cache: KV;
  let pool: Pool;

  const api = () => request(app.getHttpServer());
  const check = () =>
    api()
      .post('/permissions/check')
      .set('Authorization', `Bearer ${SERVICE}`)
      .send({ apiKey: KEY, module: 'orders', action: 'read' })
      .expect(200);

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
          adminToken: ADMIN,
          serviceToken: SERVICE,
        }),
      ],
    }).compile();
    app = configureApp(moduleRef.createNestApplication({ logger: false }));
    await app.init();
  });

  beforeEach(async () => {
    await resetState(pool, cache);
    exporter.reset();
  });

  afterAll(async () => {
    await app.close();
    await client.drain();
    await service.stop();
    await pool.end();
    await provider.shutdown();
  });

  describe('tracing', () => {
    it('continues the gateway trace inside the service via NATS headers', async () => {
      await check();

      const spans = exporter.getFinishedSpans();
      const send = spans.find((s) => s.name === 'permissions.check send');
      const processed = spans.find((s) => s.name === 'permissions.check process');

      expect(send?.kind).toBe(SpanKind.CLIENT);
      expect(processed?.kind).toBe(SpanKind.SERVER);
      // Same trace, and the service span is a child of the gateway's NATS span.
      expect(processed?.spanContext().traceId).toBe(send?.spanContext().traceId);
      expect(processed?.parentSpanContext?.spanId).toBe(send?.spanContext().spanId);
      expect(processed?.attributes).toMatchObject({
        'messaging.system': 'nats',
        'messaging.destination.name': 'permissions.check',
        'permissions.outcome': 'ok',
      });
    });
  });

  describe('metrics', () => {
    const scrape = async (url: string) => (await fetch(url)).text();
    const value = (metrics: string, series: string) => {
      const line = metrics.split('\n').find((l) => l.startsWith(series));
      return line ? Number(line.split(' ').pop()) : 0;
    };

    it('counts service requests and cache hits/misses', async () => {
      const before = await scrape(service.metricsUrl);
      await check(); // miss: loads from PostgreSQL and fills the cache
      await check(); // hit
      const after = await scrape(service.metricsUrl);

      const delta = (series: string) => value(after, series) - value(before, series);
      expect(
        delta('permissions_requests_total{subject="permissions.check",outcome="ok",service="permissions"}'),
      ).toBe(2);
      expect(delta('permissions_cache_lookups_total{result="miss",service="permissions"}')).toBe(1);
      expect(delta('permissions_cache_lookups_total{result="hit",service="permissions"}')).toBe(1);
      expect(after).toContain('permissions_db_pool_connections{state="waiting"');
      expect(after).not.toContain(KEY);
    });

    it('labels gateway HTTP metrics by route pattern, not raw URL', async () => {
      await check();
      await api().get('/does-not-exist').expect(404);

      const metrics = (await api().get('/metrics').expect(200)).text;
      // Label order differs between metric types, so match labels in any order.
      const series = (name: string, ...labels: string[]) =>
        metrics
          .split('\n')
          .some((line) => line.startsWith(`${name}{`) && labels.every((l) => line.includes(l)));

      expect(series('gateway_http_requests_total', 'route="/permissions/check"', 'status="200"')).toBe(true);
      expect(metrics).toContain('route="unmatched",status="404"');
      expect(metrics).not.toContain('does-not-exist');
      expect(
        series('gateway_nats_request_duration_seconds_count', 'subject="permissions.check"', 'outcome="ok"'),
      ).toBe(true);
    });
  });
});
