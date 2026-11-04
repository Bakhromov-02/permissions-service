import { Pool } from 'pg';
import { connect, JSONCodec, KV, NatsConnection } from 'nats';

import { Subject } from '../src/contracts';
import { createLogger } from '../src/shared/logger';
import { RunningService, startPermissionsService } from '../src/permissions/service';

export const DATABASE_URL = process.env.TEST_DATABASE_URL!;
export const NATS_URL = process.env.TEST_NATS_URL!;

const codec = JSONCodec();

export const startService = (cacheBucket: string): Promise<RunningService> =>
  startPermissionsService(
    { databaseUrl: DATABASE_URL, natsUrl: NATS_URL, cacheBucket, cacheTtlSeconds: 60, metricsPort: 0 },
    createLogger('permissions-test'),
  );

export const connectClient = () => connect({ servers: NATS_URL, name: 'test-client' });

/** Sends a request exactly like any other service would, and decodes the JSON reply. */
export const request = async <T = unknown>(
  nats: NatsConnection,
  subject: Subject,
  payload: unknown,
): Promise<T> => {
  const data = typeof payload === 'string' ? new TextEncoder().encode(payload) : codec.encode(payload);
  const reply = await nats.request(subject, data, { timeout: 5000 });
  return codec.decode(reply.data) as T;
};

export const openCache = (nats: NatsConnection, bucket: string): Promise<KV> =>
  nats.jetstream().views.kv(bucket);

/** Empties the database table and the cache bucket between tests. */
export const resetState = async (pool: Pool, cache: KV) => {
  await pool.query('TRUNCATE permissions');
  for await (const key of await cache.keys()) {
    await cache.purge(key);
  }
};

export const createPool = () => new Pool({ connectionString: DATABASE_URL });
