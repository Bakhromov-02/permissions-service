# Incident: PostgreSQL closing idle connections crashed the service

| | |
|---|---|
| Date found | 2026-11-04 |
| Found by | Resilience test (`test/resilience.spec.ts`), before any production exposure |
| Severity | High: one database failover would crash **every** replica at the same time |
| Status | Fixed, with a regression test |

## Summary

When PostgreSQL terminated the service's *idle* pooled connections, the permissions service process exited with code 1. That happens on any database restart, managed-database failover, or `pg_terminate_backend`. With every replica connected to the same database, a single failover would take down all of them at once, and every permission check would fail until the containers restarted.

## How it was found

A resilience test kills all connections from the database side while the service is running:

```sql
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid();
```

Jest reported `Unhandled error ... terminating connection due to administrator command (57P01)`.
To confirm the impact, the same steps were run against the real compiled service (`node dist/permissions/main.js`):

```
throw er; // Unhandled 'error' event
error: terminating connection due to administrator command
Emitted 'error' event on BoundPool instance at: ...
  severity: 'FATAL', code: '57P01'
SERVICE EXITED with code 1
```

## Root cause

`pg.Pool` is an `EventEmitter`. When a connection that is *idle in the pool* (not running a query) is closed by the server, the pool emits an `error` event.
In Node.js, an `error` event with no listener is thrown as an uncaught exception, which kills the process.
Errors on *active* queries were already handled (they reject the query promise and are mapped to `database_unavailable`), so normal outage tests passed. Only the idle-connection path was missed.
The original implementation of this service had the same gap.

## Fix

- `pool.on('error', …)` logs `db_idle_connection_error` and increments `permissions_db_pool_errors_total`. The pool already discards the broken client and opens a new one on the next query, so nothing else is needed (`src/permissions/service.ts`).
- Queries now time out (`DB_QUERY_TIMEOUT_MS`, default 1.5 s), so an unreachable database produces a fast `database_unavailable` instead of hanging requests.

## Verification

- `resilience › survives PostgreSQL terminating its connections` fails without the listener and passes with it.
- The real-process reproduction repeated with the fix: the service logged `db_idle_connection_error`, **kept running**, and answered the next requests normally.

## Follow-ups

- [x] Metric `permissions_db_pool_errors_total` is on the Grafana dashboard (PostgreSQL row), so a failover is visible instead of silent.
- [ ] Alert if `permissions_db_pool_errors_total` rises together with `database_unavailable` responses.
- [ ] Check every other Node.js service that uses `pg.Pool` directly for the same missing listener.
