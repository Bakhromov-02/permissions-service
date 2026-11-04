import { Counter, Histogram, Registry } from 'prom-client';

import { createRegistry, LATENCY_BUCKETS } from '../../shared/metrics';

export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');
export const GATEWAY_METRICS = Symbol('GATEWAY_METRICS');

export type GatewayMetrics = ReturnType<typeof createGatewayMetrics>;

export const createGatewayRegistry = (): Registry => createRegistry('gateway');

export const createGatewayMetrics = (registry: Registry) => {
  const registers = [registry];
  return {
    httpRequests: new Counter({
      name: 'gateway_http_requests_total',
      help: 'HTTP requests by method, route pattern and status code',
      labelNames: ['method', 'route', 'status'] as const,
      registers,
    }),
    httpDuration: new Histogram({
      name: 'gateway_http_request_duration_seconds',
      help: 'HTTP request latency by method and route pattern',
      labelNames: ['method', 'route'] as const,
      buckets: LATENCY_BUCKETS,
      registers,
    }),
    natsDuration: new Histogram({
      name: 'gateway_nats_request_duration_seconds',
      help: 'Round trip to the permissions service over NATS, by subject and outcome',
      labelNames: ['subject', 'outcome'] as const,
      buckets: LATENCY_BUCKETS,
      registers,
    }),
  };
};
