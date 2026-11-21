# 06 — NANI INTELLIGENCE AUDIT

**Scope:** `src-tauri/src/network_intelligence/`, `src-tauri/src/commands/nani.rs`, `apps/api/src/services/nani*`, `apps/api/src/routes/nani*.ts`, `apps/web/src/features/nani*`, `apps/web/src/features/copilot/`.
**Method:** Line-by-line specialist audit (research agent) + personal verification of every high-severity claim + mutation-tested repair. The deterministic Rust Bayesian engine remains authoritative; no LLM replacement and no speculative mathematical rewrite were made.
**Prior context:** N0/N1/N1.1/N1.2 operations (reports `N0_*`, `N1_*`, `N1_2_*`) established the timestamp contract (K-1), atomic concurrency (K-2) and four-case verification semantics (K-3). This pass re-verified those contracts at current HEAD and found one residual K-1 defect.

## Confirmed correct (with evidence)

| Area | Evidence | Verdict |
|---|---|---|
| Authoritative analysis path | `src-tauri/src/network_intelligence/foundation.rs` `observe_probe` → `diagnosis.rs` `DiagnosticEngine::observe`; UI Copilot (`apps/web/src/features/copilot/aiApi.ts:58-83`) calls `nani_explain` IPC and never substitutes a model answer for a deterministic one | Correct — no LLM in the authoritative path |
| K-1 ms→s boundary | `api_intelligence/monitor.rs:306-340` (`observe_diagnostic_probes`, `_matching`) divides `probe.timestamp /= 1000` before `engine.observe`; all production callers (`monitor.rs:338,408`, `investigation.rs:783,1001`, `foundation.rs:386`) go through it or carry seconds already | Correct at the feeder boundary |
| Negative/out-of-order timestamps | `diagnosis.rs:634-640` only calls `predict` when `timestamp >= prev`; zero delta is an identity update (tested at `monitor.rs:434`) | Correct |
| Transition model | `diagnosis.rs:589-627` exact log-space predict step; `mix = exp(-0.001 * delta_seconds)`; row-normalized posterior | Correct |
| Observation history bound | `MAX_CORRELATION_HISTORY = 32` (`diagnosis.rs:541`), eviction at `:656-658` | Correct — O(1) per observe |
| Persistence bounds | `network_intelligence/persistence.rs` retention + calibration cap tests pass (`cargo test persistence`: bounded) | Correct |
| No-fault / healthy-system behavior | No-fault hypothesis present in `Hypothesis::all()`; healthy probes produce real likelihood updates; N1.2 `HEALTHY_NETWORK_BIAS_ASSESSMENT` evidence retained | Correct |
| Panic surface | No `unwrap()`/`expect()` on untrusted probe data in the observation path; malformed probe records are skipped at `monitor.rs:275-283` | Correct |
| History/UI explanation | `nani_explain` returns `deterministic`, `narrative`, `source`, `grounded`, `warning`; UI shows the warning verbatim (`aiApi.ts:68-71`) | Correct — no fake grounding |

## Finding: DD-032 — residual K-1 unit mismatch in the correlation window (P2, FIXED)

**Problem statement (formal).** `ProbeResult.timestamp` reaching `DiagnosticEngine::observe` is in **seconds** (the canonical feeder divides ms by 1000 at `monitor.rs:337`; `predict` is calibrated in seconds at `diagnosis.rs:589-592`). The correlation-window reset compared a **seconds** gap against `CORRELATION_WINDOW_MS = 5 * 60 * 1_000 = 300_000` (`diagnosis.rs:545,647`). Therefore the intended five-minute reset required a 300,000-second (≈3.5-day) gap.

**Reproducible defect.** Two failed probes at `t=1000` and `t=1010`, then a TLS failure at `t=1370` (six minutes later). Expected `observation_history == ["tls-handshake"]`; observed `["dns-lookup", "tcp-connect", "tls-handshake"]`. The stale cluster continued to depress `last_evidence_weight`, so fresh evidence from a new incident was discounted as correlated.

**Exact posterior/invariant impact.** No likelihood value or posterior formula was altered. The affected invariant is *evidence independence*: `observation_history` must be cleared at the boundary so the first probe of a new incident receives full weight. The defect kept the discount active for 3.5 days instead of 5 minutes, biasing confidence downward long after the designed window.

**Fix.** `CORRELATION_WINDOW_SECONDS: u64 = 5 * 60` with a unit comment at `diagnosis.rs:543-551`; comparison updated at `:653`; the pre-existing `long_gap_starts_a_fresh_correlation_window` fixture corrected (its two "nearby" probes had been 1,000 seconds apart — already outside the intended window); new test `six_minute_gap_in_engine_seconds_resets_even_without_the_ms_feeder` pins the engine's own seconds contract independently of the feeder.

**Verification.** `cargo test diagnosis::tests` → **22 passed / 0 failed**. Mutation: restoring the 300,000 constant makes the new test fail with `left=["dns-lookup","tcp-connect","tls-handshake"] right=["tls-handshake"]`. The fix is minimal, reversible and confined to the window constant; no authoritative math was changed.

## Verified-correct claims that were raised and rejected

- **SEC-DD-003 / "nonce not bound to config bytes"** — rejected after source verification. `elevationBroker.ts:120` hashes the staged config; `fetchForBridge` re-hashes at fetch time (`:165-176`); Rust `validate_op` independently re-reads and SHA-256-checks the exact file before `ShellExecuteExW` (`elevation.rs:206-210`). The nonce binds (opId, descriptor, result); the hash binds bytes. No change made.
- **Suspicion that `predict(delta)` received milliseconds** — rejected. `diagnosis.rs:637-638` passes the raw seconds gap; only the window constant was wrong.

## Unverified / limitations

- The full Bayesian posterior was not re-derived from first principles in this pass; the prior N1/N1.2 mathematical parity work (`reports/NANI_MATHEMATICAL_REVIEW.md`, `N1_2_REVIEW_*`) remains the authority for the formulas.
- Real WebView2 presentation of NANI explanations was not exercised (no built installer/tauri-driver in this session).
- Probe provenance for the cloud health API was traced in code, not against a live endpoint (no external production access permitted).
- No change to K-2 concurrency or K-3 verification semantics was needed; both remain covered by N1.2 stress/verification evidence.

**Verdict:** NANI is mathematically intact at current HEAD after the DD-032 unit repair. No speculative model changes were made.
