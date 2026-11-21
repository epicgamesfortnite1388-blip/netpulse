# 12 — Performance and Resource Audit

## Measured evidence

- Rust test suite (full, uncontended): 560 passed in ~32 s; with three concurrent suites the same run took 41 s and produced two wall-clock-only failures (`benchmarks_are_within_budget`, `n1_analysis_latency_smoke`) that passed on rerun. This is a real, reproducible measurement-contamination effect — exactly the kind the mission directive warns about. No budget was relaxed.
- Web suite: 61 files / 598 tests, ~21 s; jsdom construction dominated (61% of tracked time). A `vmThreads` pool or `isolate:false` would speed it up but would trade away test isolation — not done.
- API suite: 118 files / 1271 tests, ~471 s; ~45 s of that is 118 worker startups. No change.

## Polling density (OPEN, P3/P4)

| ID | Path | Cost |
|---|---|---|
| DD-026 | Rust NANI MonitorLoop polls the cloud health API every 5 s (`monitor_loop.rs:93`, `main.rs:416-452`) | ~17,280 external HTTPS probes/day plus journal writes; privacy + background CPU |
| DD-027 | `/meta/health` sync fs write-probe + sync SQLite per request (`health.ts:35-37,66`), polled every 3 s in degraded states | 1-5 ms per call on loopback; tens of ms under AV minifilter |
| DD-028 | `/map/connections` cache miss spawns up to 60 `tasklist.exe` children (6 workers × 10 pids), polled every 10 s while the map panel is open | mitigated by a 2000-entry PID cache |
| DD-029 | Connection-state 1.5 s poll continues indefinitely when the tunnel is wedged 'down' (`connectionState.ts:347-353`) | ~57,600 loopback requests/day with no backoff |
| DD-030 | GlobeCanvas autoRotate rAF runs at full render rate whenever the map page is visible (`GlobeCanvas.tsx:153,188`) | GPU/CPU while idle |

These are real but low-impact relative to correctness; none was "optimized" on intuition. Backoff policies would change observable freshness, so they were left as documented items rather than silently altered.

## Resource safety

No unbounded-memory growth path found: API maps bounded, event bus capped at 500 topics, WS tickets/subscriptions bounded and single-use, NANI retention paged, Rust buffers bounded, all timers cleared, SQL queries clamped. DD-031 remains TESTED.

Repairs affecting resource correctness this cycle:
- DD-049 elevation bridge uses `spawn_blocking`, so the UAC prompt does not stall the IPC runtime; nonce validation rejects malformed input before any HTTP call.
- DD-011 fail-closed secret storage avoids writing duplicate plaintext values.
- Prior DD-020 graceful shutdown and DD-025 startup deadline remain in place.

## Verdict

The application is lightweight at rest. Remaining performance items are polling density and two load-sensitive benchmark tests, not leaks or runaway allocation.
