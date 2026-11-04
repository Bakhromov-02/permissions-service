import { Pool } from 'pg';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

import { LATENCY_BUCKETS } from '../shared/metrics';

export type ServiceMetrics = ReturnType<typeof createServiceMetrics>;

export const createServiceMetrics = (registry: Registry) => {
  const registers = [registry];
  return {
    requests: new Counter({
      name: 'permissions_requests_total',
      help: 'NATS requests handled, by subject and outcome',
      labelNames: ['subject', 'outcome'] as const,
      registers,
    }),
    requestDuration: new Histogram({
      name: 'permissions_request_duration_seconds',
      help: 'Time to handle one NATS request, from receipt to reply',
      labelNames: ['subject'] as const,
      buckets: LATENCY_BUCKETS,
      registers,
    }),
    cacheLookups: new Counter({
      name: 'permissions_cache_lookups_total',
      help: 'Permission-list cache lookups: hit, miss or error',
      labelNames: ['result'] as const,
      registers,
    }),
    dbPoolErrors: new Counter({
      name: 'permissions_db_pool_errors_total',
      help: 'Errors on idle pooled connections (e.g. PostgreSQL restart or failover); the pool replaces them',
      registers,
    }),
    dbQueryDuration: new Histogram({
      name: 'permissions_db_query_duration_seconds',
      help: 'PostgreSQL query time by operation and outcome',
      labelNames: ['operation', 'outcome'] as const,
      buckets: LATENCY_BUCKETS,
      registers,
    }),
  };
};

/** Exposes connection-pool pressure: `waiting` > 0 means requests are queuing for a connection. */
export const registerPoolMetrics = (registry: Registry, pool: Pool) =>
  new Gauge({
    name: 'permissions_db_pool_connections',
    help: 'PostgreSQL pool connections by state (total, idle, waiting)',
    labelNames: ['state'] as const,
    registers: [registry],
    collect() {
      this.set({ state: 'total' }, pool.totalCount);
      this.set({ state: 'idle' }, pool.idleCount);
      this.set({ state: 'waiting' }, pool.waitingCount);
    },
  });
