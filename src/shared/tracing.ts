import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * Starts OpenTelemetry tracing when OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g. http://jaeger:4318).
 * Must run before `http`, `express` and `pg` are loaded so their instrumentations can patch them —
 * that is why each entrypoint imports its `instrumentation.ts` first.
 */
export const startTracing = (serviceName: string): (() => Promise<void>) => {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return async () => undefined;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      // Health checks and metric scrapes would otherwise drown out real traffic.
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => req.url === '/metrics' || req.url === '/health',
      }),
      new ExpressInstrumentation(),
      new PgInstrumentation(),
    ],
  });
  sdk.start();
  return () => sdk.shutdown();
};
