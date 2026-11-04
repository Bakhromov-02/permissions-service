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
import { createRegistry, startMetricsServer } from '../shared/metrics';
import { traceIncoming } from '../shared/nats-tracing';
import { DisabledPermissionCache, KvPermissionCache, PermissionCache } from './cache';
import { PermissionsConfig } from './config';
import { PermissionHandlers } from './handlers';
import { createServiceMetrics, registerPoolMetrics, ServiceMetrics } from './metrics';
import { runMigrations } from './migrations';
import { DatabaseError, PermissionsRepository } from './repository';

const codec = JSONCodec();

export type RunningService = {
  nats: NatsConnection;
  metricsUrl: string;
  stop: () => Promise<void>;
};

const errorResponse = (code: ErrorCode, message: string, details?: unknown): ErrorResponse => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

type Outcome = 'ok' | ErrorCode;

/** Decodes, validates and dispatches one request, and always answers it. */
const respond = async <T>(
  msg: Msg,
  schema: ZodType<T>,
  handle: (payload: T) => Promise<unknown>,
  logger: Logger,
  metrics: ServiceMetrics,
): Promise<void> => {
  const stopTimer = metrics.requestDuration.startTimer({ subject: msg.subject });

  await traceIncoming(msg.subject, msg.headers, async (span) => {
    let body: unknown;
    let outcome: Outcome = 'ok';
    try {
      let payload: unknown;
      try {
        payload = codec.decode(msg.data);
      } catch {
        outcome = ErrorCode.InvalidPayload;
        body = errorResponse(outcome, 'Request body is not valid JSON');
        return;
      }

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        outcome = ErrorCode.InvalidPayload;
        body = errorResponse(
          outcome,
          'Request does not match the contract',
          parsed.error.issues.map(({ path, message }) => ({ path: path.join('.'), message })),
        );
        return;
      }

      body = await handle(parsed.data);
    } catch (error) {
      if (error instanceof DatabaseError) {
        outcome = ErrorCode.DatabaseUnavailable;
        logger.error('database_error', { subject: msg.subject, error: String(error.cause) });
        body = errorResponse(outcome, 'Database is unavailable');
      } else {
        outcome = ErrorCode.Internal;
        logger.error('unhandled_error', { subject: msg.subject, error: String(error) });
        body = errorResponse(outcome, 'Unexpected error');
      }
    } finally {
      if (msg.reply) msg.respond(codec.encode(body));
      span.setAttribute('permissions.outcome', outcome);
      metrics.requests.inc({ subject: msg.subject, outcome });
      stopTimer();
    }
  });
};

/**
 * Starts one permissions-service instance: runs migrations, opens the KV cache, subscribes to every
 * subject in the shared queue group and serves Prometheus metrics. Returns a handle that drains NATS,
 * closes the pool and stops the metrics server.
 */
export const startPermissionsService = async (
  config: PermissionsConfig,
  logger: Logger = createLogger('permissions'),
): Promise<RunningService> => {
  const registry = createRegistry('permissions');
  const metrics = createServiceMetrics(registry);

  const queryTimeout = config.dbQueryTimeoutMs ?? 1500;
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax ?? 10,
    connectionTimeoutMillis: queryTimeout,
    query_timeout: queryTimeout,
  });
  registerPoolMetrics(registry, pool);

  const migrated = await runMigrations(pool);
  if (migrated.length) logger.info('migrations_applied', { migrations: migrated });

  const nats = await connect({ servers: config.natsUrl, name: 'permissions-service' });

  let cache: PermissionCache;
  if (config.cacheEnabled === false) {
    cache = new DisabledPermissionCache(metrics);
  } else {
    const kv = await nats.jetstream().views.kv(config.cacheBucket, {
      ttl: config.cacheTtlSeconds * 1000,
      history: 1,
    });
    cache = new KvPermissionCache(kv, logger, metrics);
  }

  const handlers = new PermissionHandlers(new PermissionsRepository(pool, metrics), cache);

  // Each route keeps its own payload type: the schema's output is exactly what the handler receives.
  const route = <T>(subject: Subject, schema: ZodType<T>, handle: (payload: T) => Promise<unknown>) =>
    nats.subscribe(subject, {
      queue: PERMISSIONS_QUEUE_GROUP,
      callback: (error, msg) => {
        if (error) {
          logger.error('subscription_error', { subject, error: String(error) });
          return;
        }
        void respond(msg, schema, handle, logger, metrics);
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

  const metricsServer = await startMetricsServer(registry, config.metricsPort ?? 9464);

  logger.info('permissions_service_started', {
    nats: config.natsUrl,
    cache: config.cacheEnabled === false ? 'disabled' : config.cacheBucket,
    metrics: metricsServer.url,
  });

  return {
    nats,
    metricsUrl: metricsServer.url,
    stop: async () => {
      // Drain finishes in-flight requests before closing; then release database connections.
      await nats.drain();
      await pool.end();
      await metricsServer.close();
      logger.info('permissions_service_stopped');
    },
  };
};
