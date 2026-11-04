import { Pool } from 'pg';
import { connect, JSONCodec, Msg, NatsConnection, Subscription } from 'nats';
import { ZodType } from 'zod';

import {
  checkRequestSchema,
  ErrorCode,
  ErrorResponse,
  grantRequestSchema,
  listRequestSchema,
  PERMISSIONS_QUEUE_GROUP,
  revokeRequestSchema,
  Subject,
  Subjects,
} from '../contracts';
import { createLogger, Logger } from '../shared/logger';
import { PermissionCache } from './cache';
import { PermissionsConfig } from './config';
import { PermissionHandlers } from './handlers';
import { runMigrations } from './migrations';
import { DatabaseError, PermissionsRepository } from './repository';

const codec = JSONCodec();

export type RunningService = {
  nats: NatsConnection;
  stop: () => Promise<void>;
};

const errorResponse = (code: ErrorCode, message: string, details?: unknown): ErrorResponse => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

/** Decodes, validates and dispatches one request, and always answers it. */
const respond = async <T>(
  msg: Msg,
  schema: ZodType<T>,
  handle: (payload: T) => Promise<unknown>,
  logger: Logger,
): Promise<void> => {
  let body: unknown;
  try {
    let payload: unknown;
    try {
      payload = codec.decode(msg.data);
    } catch {
      body = errorResponse(ErrorCode.InvalidPayload, 'Request body is not valid JSON');
      return;
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      body = errorResponse(
        ErrorCode.InvalidPayload,
        'Request does not match the contract',
        parsed.error.issues.map(({ path, message }) => ({ path: path.join('.'), message })),
      );
      return;
    }

    body = await handle(parsed.data);
  } catch (error) {
    if (error instanceof DatabaseError) {
      logger.error('database_error', { subject: msg.subject, error: String(error.cause) });
      body = errorResponse(ErrorCode.DatabaseUnavailable, 'Database is unavailable');
    } else {
      logger.error('unhandled_error', { subject: msg.subject, error: String(error) });
      body = errorResponse(ErrorCode.Internal, 'Unexpected error');
    }
  } finally {
    if (msg.reply) msg.respond(codec.encode(body));
  }
};

/**
 * Starts one permissions-service instance: runs migrations, opens the KV cache and subscribes to every
 * subject in the shared queue group. Returns a handle that drains NATS and closes the pool.
 */
export const startPermissionsService = async (
  config: PermissionsConfig,
  logger: Logger = createLogger('permissions'),
): Promise<RunningService> => {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  const migrated = await runMigrations(pool);
  if (migrated.length) logger.info('migrations_applied', { migrations: migrated });

  const nats = await connect({ servers: config.natsUrl, name: 'permissions-service' });
  const kv = await nats.jetstream().views.kv(config.cacheBucket, {
    ttl: config.cacheTtlSeconds * 1000,
    history: 1,
  });

  const handlers = new PermissionHandlers(new PermissionsRepository(pool), new PermissionCache(kv, logger));

  // Each route keeps its own payload type: the schema's output is exactly what the handler receives.
  const route = <T>(subject: Subject, schema: ZodType<T>, handle: (payload: T) => Promise<unknown>) =>
    nats.subscribe(subject, {
      queue: PERMISSIONS_QUEUE_GROUP,
      callback: (error, msg) => {
        if (error) {
          logger.error('subscription_error', { subject, error: String(error) });
          return;
        }
        void respond(msg, schema, handle, logger);
      },
    });

  const subscriptions: Subscription[] = [
    route(Subjects.GRANT, grantRequestSchema, (p) => handlers.grant(p)),
    route(Subjects.REVOKE, revokeRequestSchema, (p) => handlers.revoke(p)),
    route(Subjects.CHECK, checkRequestSchema, (p) => handlers.check(p)),
    route(Subjects.LIST, listRequestSchema, (p) => handlers.list(p)),
  ];

  subscriptions.push(
    nats.subscribe(Subjects.HEALTH, {
      queue: PERMISSIONS_QUEUE_GROUP,
      callback: (_error, msg) => msg.respond(codec.encode({ status: 'ok' })),
    }),
  );

  logger.info('permissions_service_started', { nats: config.natsUrl, bucket: config.cacheBucket });

  return {
    nats,
    stop: async () => {
      // Drain finishes in-flight requests before closing; then release database connections.
      await nats.drain();
      await pool.end();
      logger.info('permissions_service_stopped');
    },
  };
};
