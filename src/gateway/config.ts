import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NATS_URL: z.string().default('nats://localhost:4222'),
  NATS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN must be at least 16 characters'),
  SERVICE_TOKEN: z.string().min(16, 'SERVICE_TOKEN must be at least 16 characters'),
});

export type GatewayConfig = {
  port: number;
  natsUrl: string;
  requestTimeoutMs: number;
  /** Can grant, revoke, list and check. */
  adminToken: string;
  /** For other backend services: can only check permissions. */
  serviceToken: string;
};

export const GATEWAY_CONFIG = Symbol('GATEWAY_CONFIG');

export const loadGatewayConfig = (env: NodeJS.ProcessEnv = process.env): GatewayConfig => {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const c = parsed.data;
  if (c.ADMIN_TOKEN === c.SERVICE_TOKEN) {
    throw new Error('Invalid configuration: ADMIN_TOKEN and SERVICE_TOKEN must differ');
  }
  return {
    port: c.PORT,
    natsUrl: c.NATS_URL,
    requestTimeoutMs: c.NATS_REQUEST_TIMEOUT_MS,
    adminToken: c.ADMIN_TOKEN,
    serviceToken: c.SERVICE_TOKEN,
  };
};
