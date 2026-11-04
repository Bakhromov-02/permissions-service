# ADR 0005: Don't add request coalescing (single-flight) for cache misses yet

- Status: accepted
- Date: 2026-11

## Context

With cache-aside, many concurrent requests for the same key right after an invalidation all miss and all query PostgreSQL: a *cache stampede*. The usual remedy is **single-flight**: concurrent misses for one key wait for a single database read and share its result.

## Decision

**Not now.** It was measured first. In the worst case tested, all 1,000 checks/s went to 10 keys while 20 grants/s kept invalidating them. That produced only **6–16 % more database queries than invalidations** (639–698 queries for ~601 invalidations in 30 s), with PostgreSQL at ~2–4 % CPU.
At this load, the database read (~2 ms) finishes before many requests for the same key can pile up.

## Why not just add it anyway

- It adds a per-replica map of in-flight promises, plus error handling: what the waiters get when the leader's query fails, and whether they retry.
- It interacts with the revision-checked fill ([ADR 0002](0002-cache-aside-in-nats-kv.md)) and would need its own tests.
- It saves at most ~100 queries per 30 s here: no measurable benefit.

## Revisit when

- `permissions_cache_lookups_total{result="miss"}` grows much faster than grants and revokes, or
- `permissions_db_pool_connections{state="waiting"}` goes above 0 under load, or
- some keys get far more traffic, for example one API key shared by a large fleet.
