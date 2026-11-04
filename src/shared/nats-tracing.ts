import { context, propagation, Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { headers as createHeaders, MsgHdrs } from 'nats';

/**
 * nats.js has no OpenTelemetry instrumentation, so trace context is carried by hand: the caller injects
 * W3C `traceparent` headers into the NATS message, and the service continues the same trace from them.
 */
const tracer = trace.getTracer('permissions-nats');

const messagingAttributes = (subject: string, operation: 'send' | 'process') => ({
  'messaging.system': 'nats',
  'messaging.destination.name': subject,
  'messaging.operation.type': operation,
});

/** Runs `send` inside a client span and passes it NATS headers carrying that span's context. */
export const traceRequest = <T>(subject: string, send: (headers: MsgHdrs) => Promise<T>): Promise<T> =>
  tracer.startActiveSpan(
    `${subject} send`,
    { kind: SpanKind.CLIENT, attributes: messagingAttributes(subject, 'send') },
    async (span) => {
      const headers = createHeaders();
      propagation.inject(context.active(), headers, {
        set: (carrier, key, value) => carrier.set(key, value),
      });
      try {
        return await send(headers);
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );

/** Runs `handle` inside a server span that is a child of the caller's span (if headers carry one). */
export const traceIncoming = <T>(
  subject: string,
  headers: MsgHdrs | undefined,
  handle: (span: Span) => Promise<T>,
): Promise<T> => {
  const parent = propagation.extract(context.active(), headers, {
    get: (carrier, key) => carrier?.get(key) || undefined,
    keys: (carrier) => (carrier ? carrier.keys() : []),
  });
  return context.with(parent, () =>
    tracer.startActiveSpan(
      `${subject} process`,
      { kind: SpanKind.SERVER, attributes: messagingAttributes(subject, 'process') },
      async (span) => {
        try {
          return await handle(span);
        } finally {
          span.end();
        }
      },
    ),
  );
};
