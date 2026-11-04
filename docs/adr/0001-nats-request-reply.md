# ADR 0001: NATS request–reply with a queue group between gateway and service

- Status: accepted
- Date: 2025-06 (original design), revisited 2026-11

## Context

Permission checks sit on the hot path of other services' requests: they must be fast, every caller needs an answer, and the service must scale horizontally without a separate load balancer or service registry.

## Decision

The permissions service listens on NATS subjects (`permissions.check`, `.grant`, `.revoke`, `.list`, `.health`) using **request–reply**. All instances join one **queue group** (`permissions-service`), so NATS delivers each request to exactly one instance.
The HTTP gateway is one client among many; backend services can call the subjects directly.

## Alternatives considered

- **HTTP between services.** It needs a load balancer or service discovery for replicas, and adds connection management per caller. NATS gives load balancing, discovery (by subject) and failover with no extra infrastructure.
- **Kafka or a similar log.** Built for durable event streams, not for low-latency request–reply where the caller waits for an answer. Replayability isn't needed for checks.
- **gRPC.** Strong typing and performance, but it brings back the load-balancing and discovery question. NATS is already needed for the KV cache.

## Consequences

- Adding a replica is just starting a process (`docker compose up --scale permissions=N`). The resilience tests show that stopping a replica doesn't drop traffic.
- Callers get `503 no responders` immediately when no instance is subscribed, instead of hanging until a timeout.
- NATS becomes critical infrastructure: if it is down, no checks happen. Run it clustered in production.
- NATS has no automatic OpenTelemetry instrumentation, so trace context is propagated manually in message headers ([ADR 0004](0004-observability.md)).
- A new replica receives traffic the moment it subscribes, which caused a tail-latency spike when scaling up ([benchmarks](../benchmarks.md#replicas-1500-checkss)).
