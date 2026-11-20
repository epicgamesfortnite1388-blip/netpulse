# N1_2_REVIEW_08 — Adversarial Findings

**Reviewer:** Kim · Each finding: severity, location, repro, impact, minimal remediation.

## R-1 · HIGH · The committed tree feeds raw ms into the engine (K-1 at HEAD)
- **Where:** `src-tauri/src/commands/nani.rs:296-302` at `2a9f825` (entered history `384f7f9`).
- **Repro:** any manual health check in a binary built from HEAD (`cargo run` of the committed tree, or the installed app built pre-WIP): probe deltas are milliseconds; `predict` applies `exp(-0.001·Δ_ms)` ⇒ e^-5000 per 5 s gap.
- **Expected:** seconds semantics; accumulating posterior across checks.
- **Actual:** every new manual check resets `state.math` to stationary + fresh evidence; cross-check accumulation impossible.
- **Root cause:** second feeder predates the boundary; N1.2 fixed the working tree but the committed copy was misclassified as "not existing at HEAD."
- **Impact:** `nani_math` diagnosis surface silently degraded in the committed binary. (Note: the reset direction is *conservative* — it cannot manufacture confidence — which caps severity at HIGH, not CRITICAL.)
- **Minimal safe remediation (choose one):**
  (a) surgical committed-tree patch: in HEAD's loop, convert before `observe_probe` (~3 lines, independent of the WIP); or
  (b) the concurrent author commits their `nani.rs` (which already contains the applied conversion) — requires their go-ahead.
- **Regression test:** a test that builds/loads the committed feed path (once (a) lands, pin the seconds contract on the manual path too).

## R-2 · MEDIUM · Tests validate the working tree, not HEAD
- **Where:** test methodology (all suites compile the working tree).
- **Impact:** committed-tree regressions (exactly R-1) are invisible to the suite as configured.
- **Remediation:** for future phases, run the suite in a disposable worktree at HEAD before declaring committed-tree claims (this review used source inspection instead; documented).

## R-3 · MEDIUM · Documentation overclaim (N1_2_01 §4 / N1_2_07 §B)
- "the manual health-check feature itself does not exist at HEAD / the committed binary has no ms-feeder at all" — false (REVIEW_01 §3). Registry entry `N1R-K1` ("RESOLVED IN WORKING TREE — COMMIT PENDING") is accurate and contradicts the prose. Remediation: correction note in N1_2_01; statuses in the registry need no change.

## R-4 · LOW · Retreating-clock observations skip predict silently
- `observe` (diagnosis.rs:636) skips predict when `timestamp < prev_ts` — correct behavior, but unpinned by any test. Remediation: one boundary test. No user impact under normal clocks.

## R-5 · LOW · Seconds-path correlation window is effectively "never"
- `CORRELATION_WINDOW_MS` compared against seconds ⇒ 300_000 s ≈ 3.5 days ⇒ window never clears within a bounded investigation. Intended for within-investigation lifetimes; becomes surprising if observations ever span days. Already tracked as NANI-022 (engine-internal ambiguity). No action in N1.2.

## R-6 · LOW · `AnalysisCompleted` remains a pre-verify snapshot (K-4, standing)
- Status card shows final record; mid-flight events are transient. Unchanged by N1.2; correctly out of scope; remains tracked.

## R-7 · INFORMATIONAL · k2 stress cannot sample mid-section states
- Not a defect (the invariant holds by mutex construction); recorded so the test's evidentiary scope is not overstated.

## R-8 · INFORMATIONAL · Thread-spawn OOM is process-fatal
- std::thread semantics; honestly documented by Will. Recoverable spawn failure does not exist in std; a custom spawn wrapper would add complexity for no benefit at cap=4.

## Cross-cutting sweeps (no findings)
- Malformed state on restart: persistence not touched by N1.2 (diff scope).
- Duplicate registry/buses: N0 guard test green in fresh runs.
- Event emission failure: replay buffer covers delivery; unchanged.
- Double conversion / mixed units from probe types: all probes share one timestamp field; single conversion per path (verified).
- Equal-posterior leaders: deterministic argmax pinned (bayesian.rs:77 comment + behavior).
- Unbounded resource creation: cap=4 active; history bounded (max_history=50 — exercised by the k2 test's rejection accounting).
