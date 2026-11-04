# Incident: a cache fill racing with a write could keep a stale permission list

| | |
|---|---|
| Date found | 2026-11-04 |
| Found by | Reviewing the cache fill path while load-testing hot keys under constant invalidation, then a targeted race experiment |
| Severity | High for a permissions service: a **revoked** permission could stay allowed for up to the cache TTL (5 min) |
| Status | Fixed (revision-checked cache fill), with a deterministic regression test |

## Summary

Reads use cache-aside: on a miss, the service loads the key's permission list from PostgreSQL and writes it to the NATS KV cache. Grants and revokes write PostgreSQL, then delete the cache entry.
When a read and a write overlapped, the read could put the **old** list back *after* the write had invalidated it:

```
reader                               writer (revoke)
──────                               ───────────────
cache miss
SELECT … → [orders:read]
                                     DELETE FROM permissions …   (commit)
                                     cache.delete(key)
cache.put(key, [orders:read])   ← stale list, now cached until TTL
```

For a grant, the new permission is invisible for up to 5 minutes. For a **revoke**, a key keeps access it shouldn't have, which is the dangerous case.

## How it was found

The hot-key load test (10 keys, 1,000 checks/s, 20 grants/s) runs reads and writes against the same keys constantly. Its checks only ask about permissions the writes never change, so it couldn't reveal a stale entry by itself. It did raise the question of what happens between a miss and the fill.
A targeted experiment against the running stack ran 30 concurrent readers of one key while granting 100 new permissions, then compared the cached list with the database:

```
round 8:  cache says 99, database has 100  <-- STALE
round 12: cache says 99, database has 100  <-- STALE
2/20 keys left with a stale cache entry
```

## Root cause

The fill was an unconditional `kv.put`. Nothing tied it to the state of the cache entry at the time of the miss, so a fill started before a write could land after it.

## Fix

The fill is now a **compare-and-set on the KV revision** (`src/permissions/cache.ts`):

1. `get` returns the entry's revision along with the value. A delete marker also has a revision, and a key that never existed has revision 0.
2. After loading from PostgreSQL, the fill uses `kv.put(key, list, { previousSeq: revision })`.
3. If a write invalidated the key in between, its revision has moved on, so the server rejects the fill (`wrong last sequence`). The service skips caching and still answers from the fresh database read. The next read caches the correct list.

`permissions_cache_fill_conflicts_total` counts skipped fills. It also counts harmless conflicts where another replica filled the key first.

Note: `kv.update()` from nats.js rejects revision 0 before contacting the server, so `put` with `previousSeq` is used to cover "key never existed" too.

## Verification

- The deterministic test `cache › never stores a stale list when a write races with a cache fill` replays miss → invalidate → late fill. It **fails** with the old unconditional `put` and passes with the fix.
- Race experiment after the fix: **0/50** keys stale (was 2/20). The fill-conflict counter showed the stale fills being rejected.
- Hot-key load test after the fix: no throughput or latency regression, and database queries per invalidation went from +16 % to +6 % over the ideal.

## Follow-ups

- [ ] Alert on a sudden rise in `permissions_cache_fill_conflicts_total` relative to grants/revokes (could indicate a write storm).
- [ ] Consider shortening `CACHE_TTL_SECONDS` as defence in depth. With the fix it bounds only *missed invalidations* (e.g. NATS unavailable during a write), not this race.
