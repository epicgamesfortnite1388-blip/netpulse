# N1_08 — Final Implementation Report (N1.1 Bayesian Analysis Routing)

**Phase:** N1.1 · **Commits:** `5b65737` (C2 harness), `200de54` (implementation) · **HEAD after:** `200de54`

## A. Executive result

### PASS WITH CONDITIONS

The real investigation lifecycle now runs on the authoritative Bayesian engine
(`DiagnosticEngine`), end to end, with proven exactness: the reported analysis
is bit-for-bit the engine's posterior computed from the recorded evidence.
Insufficient-evidence refusal, verification semantics, correlation protection,
and every numerical guarantee are preserved. All three N0-review conditions
are resolved or explicitly tracked. The conditions attached to this PASS are
the newly registered OPEN findings (NANI-020/021/022) — none of them blocks
the integrated path; two of them are next-phase work by design.

## B. Root causes addressed

- **NANI-003 (analysis bypasses the engine) → RESOLVED.** `run_analyze_stage`
  consumes `engine.diagnosis()/ranked()`; observe-stage feeds the engine every
  real measurement via the existing `diagnostic_probes` bridge; verification
  re-enters the engine. Proof: exact-oracle test (`n1_bayesian_engine_drives_
  the_real_analysis`) + old-ratio tripwire (`n1_rejects_the_old_ratio_analysis`).
- **NANI-001/002/019 (N0) — unchanged and still green** (10 pre-existing
  investigation tests pass; the N0 gate legs pass with the new analysis).

## C. Evidence (all executed this session)

| Check | Result |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml investigation` | 16 passed, 0 failed |
| `cargo test --manifest-path src-tauri/Cargo.toml` (full) | **541 passed, 0 failed, 2 ignored** |
| web nani vitest | 34 passed |
| `npm run e2e` | 44 passed, 0 failed (post-C2 commit) |
| Oracle exactness | reported top/confidence == independent reconstruction, 1e-9 |
| Distribution validity | reported confidences sum ≤ 1; old ratios summed 3.0 |
| Refusal | healthy → "Insufficient evidence to reach a conclusion." + no verify (verbatim preserved) |
| Concurrency | 4-cap enforced, honest rejection, release proven |
| Panic | honest failure + slot release + never a completion |
| Latency | 80 probes × 4 layers in 2.46 s (probe-dominated; engine work µs/probe) |

## D. Findings registry updates (36 entries now)

- **NANI-003 → RESOLVED** with evidence strings (files, symbols, tests).
- **NANI-020 (MEDIUM, OPEN):** healthy-posterior artifact — all-healthy
  evidence concentrates on the least-failure-prone hypothesis (no no-fault
  hypothesis in the space). Mitigated in N1.1 by the preserved no-claim rule;
  N5 refinement candidate.
- **NANI-021 (HIGH, OPEN):** loopback HTTP transparently intercepted on this
  machine (raw connect times out; reqwest receives 503) — probe layer
  semantics corrupted under interfered networks; design decision required
  (direct-path enforcement vs explicit "intercepted" outcome).
- **NANI-022 (LOW, OPEN):** predict-step unit ambiguity (seconds vs ms window
  constant); resolved at the N1.1 call site (seconds), engine-internal
  harmonization deferred.
- N1.3 follow-up recorded: unused `probe_dns` timeout — untouched in N1.1,
  must be resolved with real timeout tests in N1.3.

## E. Preservation

- Working tree at start: 19 modified + 51 untracked user files — **all
  preserved untouched**; the two commits stage exactly three files
  (`main.rs`, `investigation.rs` — both N0-clean before N1.1; the e2e
  harness). Concurrent user work (`diagnosis.rs`, `foundation.rs`,
  `evaluation.rs`, web files, `events/mod.rs`, `commands/nani.rs`) was
  deliberately **not modified** — the N1.1 integration required no edit to
  any of them.
- No push, no deploy, no packaged-app replacement, no destructive git ops.

## F. Honest limitations

1. The dev runtime live run (the "4 observations / 25 events" demonstration)
   was performed for N0; N1.1's live runtime re-verification in the desktop
   app has **not** been repeated this session — the deterministic in-process
   oracle is the primary evidence, and it is environment-independent.
   Recommended: one manual live investigation on the next dev run (also
   serves the C1 release gate).
2. NANI-021 means layer-level evidence quality on this machine is degraded
   for the HTTP layer (interception). The engine handles the contradiction
   honestly, but real-world diagnosis of genuinely intercepted networks will
   show it. This is the environment, not the integration.
3. The oracle's verification reconstruction assumes the verify observation's
   recorded result kind faithfully represents the implicated layer (now true
   by construction — it records the layer's real result).
4. The 0.25 conclusion floor is the pre-existing constant, now applied to real
   posteriors; its calibration against real distributions is un-validated
   (existing calibration semantics untouched; T-05 rule applies: posteriors
   are scores until n ≥ 100 && ECE < 0.10).

## G. Acceptance gates (mission §14)

- [x] Lifecycle invokes the authoritative engine (oracle-proven)
- [x] Real evidence enters the engine (observe-stage feed, recorded)
- [x] Posterior output drives the result (exact match)
- [x] Ranking from real Bayesian output (ranked() → events)
- [x] Provenance preserved (result/detail fields; no fabricated evidence)
- [x] Dedup + correlation effective (engine untouched; < 0.99 asserted)
- [x] Verification semantics correct (targeted, honest Missing ≠ success)
- [x] Insufficient evidence honest terminal outcome (verbatim preserved)
- [x] Existing event pipeline (no schema invented; reducer-compatible)
- [x] Frontend receives compatible events (34/34 web tests)
- [x] Integration tests prove the real engine (oracle, no mocks)
- [x] Existing mathematical tests pass (541/0)
- [x] No numerical regression (engine untouched; suite green)
- [x] Performance acceptable (§10 report)
- [x] User work preserved (verified; commits touch 3 files only)
- [x] N0 conditions resolved or tracked with evidence (N1_07)

**Final status: PASS WITH CONDITIONS** — conditions = NANI-020/021/022 tracked
as OPEN findings with owners/phases, plus the standing C1 release gate.
