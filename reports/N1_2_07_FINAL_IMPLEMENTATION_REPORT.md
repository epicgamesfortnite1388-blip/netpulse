# N1_2_07 — Final Implementation Report (N1.2 Runtime Hardening)

**Phase:** N1.2 · **Commits:** `c7fe33b` (K-2 atomic + K-3 three-way, post-review landing), `d46ece9` (K-1 boundary + stress proof + pure K-3 mapping + tests) · **HEAD after:** `d46ece9`

## A. Executive result

### PASS WITH CONDITIONS

All three review defects are corrected with reproducible evidence, the
validated Bayesian engine is untouched, and every N1.1 protection still
passes. The single condition: **K-1's manual-check conversion is applied in
the concurrent author's working tree but its commit belongs to that author**
(the manual-check feature does not exist at HEAD, so the fix cannot be
committed in isolation without entangling their WIP). The committed binary
has no ms-feeder at all; the working tree the developer runs is correct.
Nothing is over-claimed.

## B. K-1 — timestamp contract (HIGH)

- Caller map established: exactly two production engine feeders
  (investigation lifecycle; manual health-check command). Monitor loop,
  context-observe, and all other `observe` call sites feed different engines
  or are tests. (Full table: `N1_2_01` §1.)
- The canonical boundary `observe_diagnostic_probes[_matching]` now owns the
  ms→seconds conversion; both investigation paths route through it.
- Five regression tests including a **comparative tripwire** proving the
  original 1000× bug materially degrades accumulation (~0.42 vs ~0.24 over
  ten confirming probes).
- Manual-check path: conversion applied in the working tree of the
  concurrent author's file (byte-preserving their other edits, deliberately
  unstaged — documented, not hidden).
- Engine unchanged: zero diff in `diagnosis.rs`/`math.rs`/`bayesian.rs`.

## C. K-2 — atomic concurrency (MEDIUM)

- Check + reservation now in one critical section; the race is structurally
  impossible.
- Stress proof: 100 barrier-synchronized starts → **exactly 4 admitted,
  96 honestly rejected, active count never exceeds 4**; allocator accounting
  exact; bounded-history truncation documented in the test.
- Every terminal path releases capacity (complete/fail/cancel/panic — all
  test-asserted; thread-spawn OOM is process-fatal and honestly documented
  rather than claimed testable).

## D. K-3 — verification semantics (MEDIUM)

- Wording extracted into the pure, unit-tested
  `verify_result_text` mapping with four documented cases: reproduced
  (support, explicitly not root-cause proof), not-reproduced (challenges the
  hypothesis; posterior updated), unavailable (absence of verification is
  never success), inconclusive (shares the explicit-uncertainty wording;
  modeling fact documented — the principled upgrade is IG-guided
  verification, N5/roadmap).
- Floor precedence and the exactly-0.25 boundary asserted.
- Event schemas and the `verified` boolean unchanged; the frontend renders
  the backend's string (no frontend-side truth).

## E. Gates (mission §12)

**K-1:** [x] consistent contract (one boundary) · [x] manual-check seconds
semantics (working tree; commit = author's) · [x] 1000× regression tests ·
[x] engine untouched.
**K-2:** [x] atomic admission · [x] 100 simultaneous never exceed 4 · [x]
release on all terminal paths · [x] no panic/cancel leak.
**K-3:** [x] reproduced = reproduced · [x] contradictory = accurately
described · [x] unavailable/inconclusive distinct and honest · [x]
backend/frontend agree.
**Overall:** [x] N1.1 oracle passing (1e-9, unchanged) · [x] mathematical
suite passing (552/0 × 3 consecutive runs) · [x] web 34/34, e2e 44/44 · [x]
no concurrent user work lost (verified per-commit) · [x] registry reflects
evidence · [x] **NANI-021 scheduled as N1.3's first task** (recorded in the
registry and here).

## F. Findings registry updates

- **K-1 / NANI-022:** accurately recorded — both production call sites
  converted (one committed, one in the concurrent author's working tree);
  the engine-internal unit ambiguity remains OPEN (the contract now lives at
  the boundary; a newtype refactor is the durable option, deferred).
- **K-2, K-3:** RESOLVED with evidence (commits + test names).
- **NANI-020:** OPEN — assessment in `N1_2_04`; the all-healthy phrasing is
  deferred until after NANI-021 (proxy-corrupted "Ok" must not become
  "all healthy" wording).
- **NANI-021:** OPEN — explicitly N1.3's first task (`.no_proxy()` +
  tcp/http consistency gate feeding Missing).

## G. Preservation

Three N1.2-related commits touch exactly: `investigation.rs`, `monitor.rs`,
`e2e-desktop.mjs` (C2), reports/registry. The concurrent author's files
(`commands/nani.rs`, web UI, `diagnosis.rs`, …) are **untouched by commits**;
the single working-tree exception is the documented K-1 conversion inside
their WIP file, preserved byte-for-byte around it. 71 untracked paths
preserved. Nothing pushed, deployed, or packaged.

## H. Honest limitations

1. The K-1 commit is pending the concurrent author's next commit of
   `commands/nani.rs`; until then the committed tree simply lacks the
   manual-check feature (no corruption possible), and the working tree is
   correct.
2. NANI-021 (proxy-path) still corrupts HTTP-layer measurements in proxied
   environments — unchanged scope, N1.3's first task. Diagnostic conclusions
   should not ship to users in proxied deployments before it.
3. NANI-022's engine-internal harmonization (newtype timestamps) remains
   open; the boundary contract makes it safe to defer.
4. One non-reproducible 4-failure intermediate suite run (clean 3× after);
   recorded, no flake signature remained.

**Final status: PASS WITH CONDITIONS** — the condition being the K-1 commit
coordination above; nothing else is open on K-1/K-2/K-3.
