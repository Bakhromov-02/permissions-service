import { z } from 'zod';

const configSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  NATS_URL: z.string().default('nats://localhost:4222'),
  CACHE_BUCKET: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('permissions_cache'),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(300),
});

export type PermissionsConfig = {
  databaseUrl: string;
  natsUrl: string;
  cacheBucket: string;
  /** 0 disables expiry; invalidation on grant/revoke still applies. */
  cacheTtlSeconds: number;
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
    cacheBucket: c.CACHE_BUCKET,
    cacheTtlSeconds: c.CACHE_TTL_SECONDS,
  };
};
