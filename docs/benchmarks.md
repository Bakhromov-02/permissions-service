# Benchmarks

Load tests of `POST /permissions/check` through the full stack: k6 → gateway → NATS → permissions service → cache / PostgreSQL.
Raw numbers for every run are in [`benchmarks/results-2026-11-04.jsonl`](benchmarks/results-2026-11-04.jsonl).

## Environment — read this first

| | |
|---|---|
| Host | Apple M1 Pro, 8 cores, 16 GB |
| Docker | Docker Desktop VM limited to **2 vCPUs and 4 GB** |
| Stack | everything in one VM: k6, gateway (1), permissions (2 unless stated), NATS, PostgreSQL, Jaeger, Prometheus, Grafana |
| Tracing | 1 % sampling during tests (`TRACE_SAMPLE_RATIO=0.01`) |
| Workload | 200 API keys, each granted `orders:read`; 80 % of checks ask `orders:read` (allowed), 20 % `orders:write` (denied) |
| Runs | 30 s each, constant arrival rate (k6 `constant-arrival-rate`), latencies measured by k6 |

All components share two vCPUs with the load generator, so treat the numbers as **comparisons between configurations on the same box**, not as production capacity.
Single runs vary by roughly ±20 % at p95. Where a result looked surprising, it was re-run (see below).

## Results

### Throughput vs. latency (cache on, 2 replicas)

| Target rate | Achieved | p50 | p95 | p99 | Errors | Dropped iterations¹ |
|---:|---:|---:|---:|---:|---:|---:|
| 500/s | 499/s | 1.01 ms | 4.83 ms | 33.0 ms | 0 | 20 |
| 1,000/s | 998/s | 1.09 ms | 16.1 ms | 59.3 ms | 0 | 62 |
| 1,500/s | 1,491/s | 1.75 ms | 32.5 ms | 76.8 ms | 0 | 278 |
| 2,000/s | 1,958/s | 3.12 ms | **73.9 ms** | **136 ms** | 0 | 1,268 |

¹ Requests k6 couldn't start on schedule because all its virtual users were waiting: a sign of saturation.

The SLO used in the k6 thresholds (p95 < 50 ms, p99 < 100 ms) holds up to **~1,500 checks/s** and breaks at 2,000/s. Every response was correct in every run.

**Where the time goes.** These are the CPU cores each process used, from `process_cpu_seconds_total`:

| Rate | Gateway | Permissions (both replicas) | PostgreSQL (docker stats) |
|---:|---:|---:|---:|
| 500/s | 0.39 | 0.23 | ~1 % |
| 1,000/s | 0.60 | 0.30 | ~1 % |
| 1,500/s | 0.77 | 0.38 | ~1 % |
| 2,000/s | 0.83 | 0.40 | ~1 % |

**The gateway is the bottleneck.** It's a single Node.js process doing HTTP parsing, validation and auth, and it approaches one full core. The permissions replicas stay under ~20 % CPU each.

### What the cache buys (1,000 checks/s, 2 replicas)

| | p50 | p95 | p99 | PostgreSQL `list` queries | PostgreSQL CPU |
|---|---:|---:|---:|---:|---:|
| Cache on | 1.09 ms | 16.1 ms | 59.3 ms | **205** | ~1 % |
| Cache off (`CACHE_ENABLED=false`) | 1.51 ms | 19.4 ms | 54.6 ms | **29,920** | ~9 % |

At this scale the cache barely changes latency. An indexed primary-key lookup in PostgreSQL is already fast, and the gateway dominates latency anyway. What it does buy is **146× fewer database queries** (a 99.3 % cache hit ratio). That's database headroom, which is what you need when many services call `check`.

### Replicas (1,500 checks/s)

| Replicas | p95 | p99 | Dropped iterations | Permissions CPU (total) |
|---:|---:|---:|---:|---:|
| 1 | 69.9 / 39.6 ms | 126 / 144 ms | 421 / 423 | 0.33–0.34 |
| 2 | 32.5 / 39.1 ms | 76.8 / 81.6 ms | 278 / 273 | 0.35–0.38 |
| 4 | 35.1 ms² | 80.7 ms² | 239² | 0.47 |

Two runs per row where shown (first / rerun).

- **1 → 2 replicas improves tail latency** (p99 ~135 → ~80 ms): a single replica's event loop queues work under bursts.
- **2 → 4 adds nothing**, because the gateway is the limit. It also costs more total CPU on a CPU-starved box.
- ² The first 4-replica run started 12 s after scaling up and showed **p95 129 ms and p99 5.2 s** while the new replicas warmed up (cold JIT, empty connection pool). The NATS queue group routes traffic to a replica as soon as it subscribes. A rerun with warm replicas gives the numbers above. **Follow-up:** warm up (pre-open pool connections) before subscribing.

### Hot keys under constant invalidation (cache stampede check)

10 keys receiving all 1,000 checks/s, while 20 grants/s keep invalidating them:

| | Invalidations | Cache misses | DB `list` queries | Extra queries |
|---|---:|---:|---:|---:|
| Before the revision-checked fill | ~601 | 698 | 698 | +16 % |
| After | ~601 | 639 | 639 | +6 % |

A stampede would show many more misses than invalidations. Here concurrent misses add only 6–16 % extra queries, so **request coalescing isn't worth its complexity yet** ([ADR 0005](adr/0005-no-request-coalescing-yet.md)).
This test also surfaced a cache **correctness** race, which is fixed: [incident: stale cache after revoke](incidents/2026-11-04-stale-cache-after-revoke.md).

## Conclusions

1. **Scale the gateway first.** At ~1,500 checks/s on 2 vCPUs, one gateway process is the ceiling. Next steps: several gateway instances behind a load balancer (or Node cluster mode), or let backend services call `permissions.check` over NATS directly and skip HTTP.
2. **Treat the cache as database protection, not a latency feature.** Keep it, and keep watching the hit ratio.
3. **Two replicas are enough for this load.** More replicas only help once the service, not the gateway, is the bottleneck.
4. **New replicas need warm-up before taking traffic.**

## Reproduce

```bash
cp example.env .env
TRACE_SAMPLE_RATIO=0.01 docker compose up -d --build
loadtest/run.sh 1000 30s                              # rate, duration
WRITE_RATE=20 KEYS=10 HOT_KEYS=10 loadtest/run.sh 1000 30s
docker compose up -d --scale permissions=4            # then re-run
```

Watch it live in Grafana (http://localhost:3001) while the test runs.
