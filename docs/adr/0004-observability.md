# ADR 0004: OpenTelemetry tracing across NATS, Prometheus metrics, Grafana dashboard

- Status: accepted
- Date: 2026-11

## Context

A permission check crosses four components: HTTP gateway → NATS → permissions service → cache or PostgreSQL. When it is slow or failing, you need to see *where*, both for one request (traces) and in aggregate (metrics).

## Decision

- **Traces:** OpenTelemetry SDK in both processes, exporting OTLP to Jaeger. HTTP, Express and pg are auto-instrumented. nats.js has no instrumentation, so the gateway **injects W3C `traceparent` into NATS message headers** and the service continues the same trace from them (`src/shared/nats-tracing.ts`). A test asserts the service span is a child of the gateway span.
- **Metrics:** prom-client with one registry per process.
  - Service: requests by subject and outcome, handling latency, cache hit/miss/error, fill conflicts, database query latency, pool connections (`waiting` > 0 means exhaustion) and idle-connection errors.
  - Gateway: HTTP requests and latency by **route pattern** (never the raw URL, to bound label cardinality), and NATS round trip by outcome.
  - Both: Node.js runtime metrics such as event-loop lag and CPU.
- **Prometheus** discovers service replicas through Docker DNS, so scaling needs no config change. **Grafana** is provisioned with the dashboard and both data sources.
- **Sampling** is configurable (`TRACE_SAMPLE_RATIO`): 100 % for local exploration, low for load tests.

## Alternatives considered

- **Logs only.** They can't show latency distributions or follow a request across processes.
- **A vendor APM agent.** It works out of the box, but locks the project to one vendor. OTLP plus Prometheus are open standards with many backends.
- **Metrics via OpenTelemetry instead of prom-client.** It's viable, but prom-client is simpler for a Prometheus-scraped setup and has mature Node.js runtime metrics.

## Consequences

- One request can be followed end to end in Jaeger: HTTP → handler → `permissions.check send` → `permissions.check process` → `pg.query`.
- The dashboard immediately showed **the gateway, not the service, is the bottleneck** ([benchmarks](../benchmarks.md)).
- `/metrics` endpoints are unauthenticated and must stay on the internal network in production.
- Tracing every request costs CPU, so production should sample.
