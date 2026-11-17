# N1_05 — E2E and Regression Tests

**Phase:** N1.1 · **Commits:** `200de54` (implementation), `5b65737` (C2 harness)

## The acceptance-gate test: exact-oracle equivalence

`n1_bayesian_engine_drives_the_real_analysis` (investigation.rs tests) proves
the production lifecycle uses the REAL engine, with no mocking:

1. Registers one API against a deterministically failing endpoint
   (port 1 — deliberately outside the OS ephemeral range; a dropped dynamic
   port can be re-bound by another process within milliseconds, which was
   **observed live** during development: an "HTTP 200 failing leg").
2. Starts a real investigation through the production entry point.
3. Pulls the terminal record and **independently reconstructs** the engine
   from the recorded evidence: each observation → single-layer
   `ProbeOutcomeRecord` → `diagnostic_probes` → `observe` with the same
   second-converted timestamps; the verification measurement is reconstructed
   from the recorded verify observation (result + detail of the implicated
   layer), filtered by the same test the lifecycle targets.
4. Asserts **exact equality**: reported `top_hypothesis` and `confidence`
   match the reference engine's `diagnosis()` to 1e-9.
5. Asserts distribution validity: reported hypothesis confidences sum ≤ 1
   (the old ratio path reported 3.0 here), belief moved above uniform, and
   correlated layers did not inflate to certainty (< 0.99).
6. Asserts the canonical bus carries the same posterior
   (`AnalysisCompleted` payload finite and in [0,1]).

**Fails against the old implementation:** if `run_analyze_stage` reverts to
ratios, the reported confidence (a fail-ratio of 1.0) cannot equal the
posterior, and the hypothesis confidences (several 1.0s) sum past 1. A second
tripwire, `n1_rejects_the_old_ratio_analysis`, reimplements the audited OLD
algorithm verbatim on the same evidence and asserts the lifecycle's reported
numbers DISAGREE with it — permanent regression protection.

## Scenario coverage (mission §9 table)

| Scenario | Where covered |
|---|---|
| Strong independent evidence | oracle test: belief moved above uniform; per-API sources independent |
| Contradictory evidence | engine-level contradiction math untouched (suite green); live environment produces contradictory layers (NANI-021) and the engine handles them — the oracle matches the engine on exactly that evidence |
| No observations | pre-existing early failure (unchanged); `n0` gate legs |
| Duplicate observations | engine dedup contract untouched (engine tests); lifecycle adds no re-counting |
| Unverified observations | no verified-learning path was touched; nothing marks unverified evidence verified |
| Failed verification | stays failed: verify records the implicated layer's REAL result kind; refutation can drop the verdict to the refusal |
| Missing API | honest rejection/failure paths (early "no observations"; rejection records) |
| Correlated evidence | correlation model untouched; asserted `< 0.99` under correlated layers |
| Extreme numerical inputs | engine's audited NaN/±inf rules untouched; full suite green |
| Concurrent investigations | `n1_concurrency_limit_rejects_honestly_and_releases`; identity isolation via existing test |
| Investigation panic | `n1_panic_produces_honest_failure_and_releases_capacity` |

## Executed commands and results (this session, by Will)

| Command | Result |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml investigation` | **16 passed, 0 failed** (10 pre-existing + 6 new) |
| `cargo test --manifest-path src-tauri/Cargo.toml` | **541 passed, 0 failed, 2 ignored** |
| `npx vitest run src/features/nani` (apps/web) | **34 passed** (2 files) |
| `npm run e2e` | **44 passed, 0 failed** (after C2 commit `5b65737`) |

## C2 — harness correction committed

`scripts/e2e-desktop.mjs`: one-line change aligning the `/nodes/export`
expectation with the deliberate `410 Gone` retirement (security decision
unchanged; no unrelated files staged). Committed separately as `5b65737`.

## Discoveries recorded during test development

- **Port-reuse flake (fixed):** the N0 gate test's "closed port" used a
  dropped dynamic port — re-boundable by other processes. Both the N0 failing
  leg and the new tests now use port 1 (outside the ephemeral range).
- **NANI-021 (HIGH, OPEN):** the machine's network stack transparently
  intercepts loopback HTTP (raw connect to 127.0.0.1:1 times out; reqwest
  receives HTTP 503). Probe layer semantics are corrupted under this
  environment — tcp Failed while tls/http Ok+503. The oracle design is robust
  to it (derives everything from recorded measurements). Registered.
- **NANI-020 (MEDIUM, OPEN):** healthy evidence concentrates the posterior on
  the least-failure-prone hypothesis (no "no-fault" hypothesis exists).
  Mitigated in N1.1 by the preserved no-claim rule; registered.
