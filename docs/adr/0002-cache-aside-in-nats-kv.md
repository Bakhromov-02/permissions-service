# ADR 0002: Cache-aside in NATS JetStream KV, invalidated on write, filled with compare-and-set

- Status: accepted
- Date: 2026-11

## Context

`check` is called far more often than permissions change. Every check reading PostgreSQL would make the database the limit for every service that depends on permissions.

## Decision

- Cache the **full permission list per API key** in a JetStream KV bucket (`permissions_cache`), keyed by the SHA-256 of the key ([ADR 0003](0003-hash-api-keys.md)). Empty lists are cached too.
- **Cache-aside:** reads try the cache, and on a miss load from PostgreSQL and fill it.
- **Writes invalidate** (delete the entry) after committing, rather than writing the new list. That keeps one writer of cache values (the read path) and avoids ordering bugs between concurrent writers.
- **Fills are compare-and-set** on the KV revision seen at the miss (`put` with `previousSeq`). A fill that raced with a write is rejected ([incident](../incidents/2026-11-04-stale-cache-after-revoke.md)).
- A TTL (default 5 min) bounds staleness if an invalidation is ever missed, e.g. NATS unavailable right after a database write.
- Cache failures never fail requests: the service falls back to PostgreSQL.

## Alternatives considered

- **Redis.** The obvious default, but it would add another stateful system. NATS is already required ([ADR 0001](0001-nats-request-reply.md)), and its KV has the revision semantics needed for safe fills.
- **In-process cache per replica.** Fastest, but each replica would need invalidations broadcast to it, and replicas would disagree for a while after a write.
- **Write-through** (writers put the new list). Two concurrent writers can store their lists in the wrong order, and a writer must re-read the full list anyway.

## Consequences

- Measured: **99.3 % hit ratio and 146× fewer database queries** at 1,000 checks/s. Latency barely changed, because PostgreSQL primary-key lookups are already fast. The cache's value is database headroom ([benchmarks](../benchmarks.md#what-the-cache-buys-1000-checkss-2-replicas)).
- A read that loses the compare-and-set still answers correctly from the database; only the caching is skipped.
- `permissions_cache_lookups_total` and `permissions_cache_fill_conflicts_total` make cache behaviour visible on the dashboard.
