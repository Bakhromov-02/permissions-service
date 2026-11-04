# Permissions Service

[![CI](https://github.com/Bakhromov-02/permissions-service/actions/workflows/ci.yml/badge.svg)](https://github.com/Bakhromov-02/permissions-service/actions/workflows/ci.yml)

A small microservice system that decides **which API keys may perform which actions**.
A permissions service answers requests over **NATS** (request–reply), stores data in **PostgreSQL**, and caches lookups in a **NATS JetStream key-value bucket**.
A **NestJS HTTP gateway** exposes it to the outside world.

Everything runs with one `docker compose up`, including **tracing (Jaeger), metrics (Prometheus) and a Grafana dashboard**. The test suite runs against real PostgreSQL and NATS containers.

**Engineering notes:** [benchmarks](docs/benchmarks.md) · [incident reports](docs/incidents/) · [architecture decisions](docs/adr/)

## Results at a glance

Measured with k6 on a 2-vCPU Docker VM shared by the whole stack ([details and caveats](docs/benchmarks.md)):

| | Result |
|---|---|
| Sustained throughput within SLO (p95 < 50 ms, p99 < 100 ms) | **~1,500 checks/s**, 0 errors |
| Latency at 1,000 checks/s | p50 1.1 ms · p95 16 ms · p99 59 ms |
| Cache | 99.3 % hit ratio, **146× fewer PostgreSQL queries**; barely affects latency at this scale |
| Bottleneck | the **gateway** (one Node.js process, ~0.8 cores at saturation), not the service |
| Found and fixed by resilience and load tests | [process crash on database failover](docs/incidents/2026-11-04-idle-connection-crash.md) · [stale cache after revoke](docs/incidents/2026-11-04-stale-cache-after-revoke.md) |

## Architecture

```mermaid
flowchart LR
    client([HTTP client]) -->|REST + bearer token| gateway[Gateway<br/>NestJS]
    other([Other backend services]) -. NATS request .-> nats
    gateway -->|NATS request–reply| nats[(NATS<br/>JetStream)]
    nats -->|queue group<br/>permissions-service| p1[permissions #1]
    nats --> p2[permissions #2]
    p1 & p2 -->|cache-aside| kv[(KV bucket<br/>permissions_cache)]
    p1 & p2 --> pg[(PostgreSQL)]
```

- **Permissions service** (`src/permissions`) is the only component that touches the database. Any number of replicas can run: they join one NATS **queue group**, so each request is handled by exactly one instance, and stopping a replica doesn't drop traffic.
- **Gateway** (`src/gateway`) is a NestJS app that validates HTTP input, authenticates callers and translates service errors into HTTP status codes.
- **Contracts** (`src/contracts`) hold the subjects, message schemas (zod) and error codes, shared by both sides.

## Message contract

| Subject | Request | Reply |
|---|---|---|
| `permissions.grant` | `{ apiKey, module, action }` | `{ status: "ok" }` (idempotent) |
| `permissions.revoke` | `{ apiKey, module, action }` | `{ status: "ok", removed: boolean }` |
| `permissions.check` | `{ apiKey, module, action }` | `{ allowed: boolean }` |
| `permissions.list` | `{ apiKey }` | `{ permissions: [{ module, action }] }` |
| `permissions.health` | `{}` | `{ status: "ok" }` |

Errors use one shape, `{ error: { code, message, details? } }`, with code `invalid_payload`, `database_unavailable` or `internal`.
`module` and `action` are normalized to lowercase and may contain letters, digits and `_ . : -`.

## HTTP API (gateway)

Swagger UI is at `http://localhost:3000/docs`.

| Method | Path | Token | Description |
|---|---|---|---|
| POST | `/permissions/grant` | admin | Grant a permission |
| POST | `/permissions/revoke` | admin | Revoke a permission |
| POST | `/permissions/list` | admin | List a key's permissions |
| POST | `/permissions/check` | service or admin | Check a permission |
| GET | `/health` | – | Gateway, NATS and service health (`503` when degraded) |

API keys are always sent in the JSON body, never in the URL, so they don't end up in access logs.
Status codes: `400` invalid input, `401` missing or invalid token, `403` wrong token type, `503` no service instance or database down, `504` service timeout.

```bash
curl -X POST localhost:3000/permissions/grant \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"apiKey":"sk_live_123456789","module":"orders","action":"read"}'

curl -X POST localhost:3000/permissions/check \
  -H "Authorization: Bearer $SERVICE_TOKEN" -H "Content-Type: application/json" \
  -d '{"apiKey":"sk_live_123456789","module":"orders","action":"read"}'
# {"allowed":true}
```

## Design decisions

- **API keys are never stored in plain text.** The database and the cache only see a SHA-256 hash of each key. The hash also always works as a KV key, which some raw API keys wouldn't (spaces, `*`, `>`).
- **Cache-aside with invalidation on writes, filled with compare-and-set.** A read loads the key's full permission list from the cache or, on a miss, from PostgreSQL, and caches it. Empty lists are cached too. Grant and revoke delete the cache entry instead of rewriting it. The fill is conditional on the KV revision seen at the miss, so a read that raced with a write can't store a stale list ([incident](docs/incidents/2026-11-04-stale-cache-after-revoke.md)). A TTL bounds staleness if an invalidation is ever missed, and if the cache fails, the service falls back to the database.
- **Unknown keys are simply not allowed.** `check` returns `{ allowed: false }` and `list` returns an empty list; neither is an error.
- **Validation on both edges.** The gateway validates HTTP input (class-validator), and the service validates every NATS message (zod) because other services can call it directly. Unknown fields are rejected.
- **Two token scopes.** The admin token can manage permissions. The service token, for other backend services, can only check them. Tokens are compared in constant time.
- **Safe startup, shutdown and database failures.** Migrations run in a transaction under a PostgreSQL advisory lock, so replicas starting together don't race. Queries time out (`DB_QUERY_TIMEOUT_MS`), so an unreachable database gives a fast `database_unavailable` while cached keys keep being answered. Idle-connection errors from a database restart are handled instead of crashing the process ([incident](docs/incidents/2026-11-04-idle-connection-crash.md)). On `SIGTERM` the service drains NATS, finishing in-flight requests before it exits.

Each decision, with the alternatives considered, is written up in [`docs/adr`](docs/adr/).

## Running

```bash
cp example.env .env      # set ADMIN_TOKEN and SERVICE_TOKEN
docker compose up --build
```

This starts PostgreSQL, NATS (with JetStream), **two** permissions-service replicas, the gateway, and the observability stack:

| URL | What |
|---|---|
| http://localhost:3000/docs | Gateway API (Swagger) |
| http://localhost:3001 | Grafana: the *Permissions Service* dashboard opens by default |
| http://localhost:16686 | Jaeger: traces of single requests across gateway → NATS → service → PostgreSQL |
| http://localhost:9090 | Prometheus |

Scale the service with `docker compose up -d --scale permissions=4`; Prometheus picks up new replicas automatically. Load-test with `loadtest/run.sh 1000 30s` (see [benchmarks](docs/benchmarks.md#reproduce)).

Without Docker for the apps (you still need PostgreSQL and NATS running):

```bash
npm install && npm run build
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/permissions npm run start:permissions
ADMIN_TOKEN=... SERVICE_TOKEN=... npm run start:gateway
```

| Variable | Used by | Default |
|---|---|---|
| `DATABASE_URL` | permissions | required |
| `NATS_URL` | both | `nats://localhost:4222` |
| `CACHE_ENABLED` | permissions | `true` (`false` = always read PostgreSQL) |
| `CACHE_BUCKET` / `CACHE_TTL_SECONDS` | permissions | `permissions_cache` / `300` |
| `DB_POOL_MAX` / `DB_QUERY_TIMEOUT_MS` | permissions | `10` / `1500` |
| `METRICS_PORT` | permissions | `9464` (gateway serves `/metrics` on its HTTP port) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | both | unset = tracing off; e.g. `http://jaeger:4318` |
| `TRACE_SAMPLE_RATIO` (compose) | both | `1.0`; use `0.01` for load tests |
| `ADMIN_TOKEN` / `SERVICE_TOKEN` | gateway | required, ≥ 16 characters, must differ |
| `NATS_REQUEST_TIMEOUT_MS` / `PORT` | gateway | `2000` / `3000` |

## Testing

```bash
npm test     # requires Docker
```

Testcontainers starts PostgreSQL and NATS once per run. The suites talk to the service over real NATS and to the gateway over HTTP:

- **Service:** grant, check, list and revoke (including unknown keys and idempotency), cache population and invalidation, the write/fill race, contract validation, and failover between two replicas.
- **Gateway:** token scopes, the full HTTP flow, input validation, health, and `503` when no service instance is running.
- **Resilience:** the cache bucket disappearing, PostgreSQL unreachable (cached keys still answered, uncached ones fail fast, then recovery), and PostgreSQL killing every connection.
- **Observability:** one trace spans gateway and service across NATS; metric counters match the traffic; HTTP metrics use route patterns, not raw URLs.

Also available: `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build`, all of which run in CI.

## Project structure

```
src/
├── contracts/      # subjects, zod schemas, error codes (shared)
├── shared/         # logger, API-key hashing, metrics registry, tracing (incl. NATS context propagation)
├── permissions/    # NATS service: handlers, repository, cache, migrations, metrics, entrypoint
└── gateway/        # NestJS app: controller, DTOs, token guard, NATS client, health, metrics
test/               # integration, e2e, resilience and observability tests + Testcontainers setup
loadtest/           # k6 script and runner
observability/      # Prometheus config, Grafana provisioning and dashboard
docs/               # benchmarks, incident reports, ADRs
```
