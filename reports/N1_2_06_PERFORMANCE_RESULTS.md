# N1_2_06 — Performance Results

**Phase:** N1.2 · **Commits:** `c7fe33b`, `d46ece9`

## Measurements (executed this session)

| Metric | Result | How measured |
|---|---|---|
| Concurrent admission latency | ~10–30 ms for a **100-thread barrier-synchronized** start cycle (≈100–300 µs per admission decision, O(1) bookkeeping under one lock) | `k2_hundred_simultaneous_starts_never_exceed_the_cap` harness timing |
| Maximum concurrent investigation count | **4** — never exceeded across 4 stress runs | asserted in the stress test |
| Reservation / release behavior | atomic reserve before spawn; released on complete/fail/cancel/panic (all test-asserted) | test suite |
| Manual health-check analysis latency | unchanged by N1.2 — the conversion is one integer division per probe | code inspection (no timing regression possible from `/= 1000`) |
| Investigation analysis latency | 80 probes × 4 layers across 20 APIs in **2.47 s**, probe-dominated; Bayesian work µs/probe | `n1_analysis_latency_smoke -- --nocapture` |
| Memory behavior | no growth: bounded replay (256), bounded history (50), bounded active (4), bounded correlation window (32) | existing bounds re-verified |

## Anti-patterns checked (mission §9)

- Locks during Bayesian calculation: **none** — the per-investigation engine
  is never behind a shared lock; the manager lock is held only for O(1)
  bookkeeping (admission now *shorter* than pre-K-2, being one section
  instead of two).
- Unbounded threads: cap 4.
- Busy waiting: none (barrier test uses `std::sync::Barrier`).
- Unnecessary allocations: the new boundary reuses the existing
  `diagnostic_probes` Vec; no additional clones introduced.
- Repeated posterior recomputation: none added; analyze reads the posterior
  built during observe.
- UI blocking: lifecycle and health checks run on background threads
  (unchanged).

Correctness over microbenchmarks: the atomic-admission change collapses two
lock sections into one — strictly less contention than before. No
optimization was applied elsewhere; none was needed.
