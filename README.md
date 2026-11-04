# Permissions Service

[![CI](https://github.com/Bakhromov-02/permission-management-test/actions/workflows/ci.yml/badge.svg)](https://github.com/Bakhromov-02/permission-management-test/actions/workflows/ci.yml)

A small microservice system that decides **which API keys may perform which actions**.
A permissions service answers requests over **NATS** (request–reply), stores data in **PostgreSQL**, and caches lookups in a **NATS JetStream key-value bucket**.
A **NestJS HTTP gateway** exposes it to the outside world.

Everything runs with one `docker compose up`, and the test suite runs against real PostgreSQL and NATS containers.

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
- **Cache-aside with invalidation on writes.** A read loads the key's full permission list from the cache or, on a miss, from PostgreSQL, and caches it. Empty lists are cached too. Grant and revoke delete the cache entry instead of rewriting it, and a TTL bounds staleness if an invalidation is ever missed. If the cache itself fails, the service falls back to the database.
- **Unknown keys are simply not allowed.** `check` returns `{ allowed: false }` and `list` returns an empty list; neither is an error.
- **Validation on both edges.** The gateway validates HTTP input (class-validator), and the service validates every NATS message (zod) because other services can call it directly. Unknown fields are rejected.
- **Two token scopes.** The admin token can manage permissions. The service token, for other backend services, can only check them. Tokens are compared in constant time.
- **Safe startup and shutdown.** Migrations run in a transaction under a PostgreSQL advisory lock, so replicas starting together don't race. On `SIGTERM` the service drains NATS, finishing in-flight requests before it exits.

## Running

```bash
cp example.env .env      # set ADMIN_TOKEN and SERVICE_TOKEN
docker compose up --build
```

This starts PostgreSQL, NATS (with JetStream), **two** permissions-service replicas and the gateway on port 3000.

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
| `CACHE_BUCKET` / `CACHE_TTL_SECONDS` | permissions | `permissions_cache` / `300` |
| `ADMIN_TOKEN` / `SERVICE_TOKEN` | gateway | required, ≥ 16 characters, must differ |
| `NATS_REQUEST_TIMEOUT_MS` / `PORT` | gateway | `2000` / `3000` |

## Testing

```bash
npm test     # requires Docker
```

Testcontainers starts PostgreSQL and NATS once per run. The suites talk to the service over real NATS and to the gateway over HTTP:

- **Service:** grant, check, list and revoke (including unknown keys and idempotency), cache population and invalidation, contract validation, and failover between two replicas.
- **Gateway:** token scopes, the full HTTP flow, input validation, health, and `503` when no service instance is running.

Also available: `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build`, all of which run in CI.

## Project structure

```
src/
├── contracts/      # subjects, zod schemas, error codes (shared)
├── shared/         # logger, API-key hashing
├── permissions/    # NATS service: handlers, repository, cache, migrations, entrypoint
└── gateway/        # NestJS app: controller, DTOs, token guard, NATS client, health
test/               # integration and e2e tests + Testcontainers setup
```
