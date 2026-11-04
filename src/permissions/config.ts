import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const configSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  NATS_URL: z.string().default('nats://localhost:4222'),
  CACHE_ENABLED: booleanString,
  CACHE_BUCKET: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('permissions_cache'),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(300),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),
  METRICS_PORT: z.coerce.number().int().min(0).default(9464),
});

export type PermissionsConfig = {
  databaseUrl: string;
  natsUrl: string;
  /** false = always read from PostgreSQL (used to measure what the cache buys). */
  cacheEnabled?: boolean;
  cacheBucket: string;
  /** 0 disables expiry; invalidation on grant/revoke still applies. */
  cacheTtlSeconds: number;
  dbPoolMax?: number;
  /** Fail a query (and answer `database_unavailable`) instead of hanging when PostgreSQL is unreachable. */
  dbQueryTimeoutMs?: number;
  /** Port for the Prometheus `/metrics` endpoint; 0 picks a random free port. */
  metricsPort?: number;
};

export const loadPermissionsConfig = (env: NodeJS.ProcessEnv = process.env): PermissionsConfig => {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const c = parsed.data;
  return {
    databaseUrl: c.DATABASE_URL,
    natsUrl: c.NATS_URL,
    cacheEnabled: c.CACHE_ENABLED,
    cacheBucket: c.CACHE_BUCKET,
    cacheTtlSeconds: c.CACHE_TTL_SECONDS,
    dbPoolMax: c.DB_POOL_MAX,
    dbQueryTimeoutMs: c.DB_QUERY_TIMEOUT_MS,
    metricsPort: c.METRICS_PORT,
  };
};
