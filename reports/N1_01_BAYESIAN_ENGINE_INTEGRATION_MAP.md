# N1_01 — Bayesian Engine Integration Map

**Phase:** N1.1 (Bayesian analysis routing) · **Commit:** `200de54` · **Author:** Will — Senior Developer

## 1. The authoritative engine (identified, not built)

The production Bayesian engine is `DiagnosticEngine` in
`src-tauri/src/network_intelligence/diagnosis.rs` — independently audited as the
strongest part of NANI. **No new Bayesian code was written in N1.1.** Its
established contracts, located by symbol in the current tree:

| Contract | Symbol | Behavior preserved |
|---|---|---|
| Hypothesis space | `Hypothesis` (19 variants incl. `Unknown`) | untouched |
| Six-outcome model | `ProbeOutcome` {Success, Failure, Missing, AuthRejected, RateLimited, ServerError} | untouched |
| Likelihood table | `LikelihoodTable::default()` (log P(outcome \| hypothesis, test)) | untouched |
| Transition kernel | `TransitionModel::default()` + `predict(delta_seconds)` (time-scaled: `mix = exp(-0.001·Δt)`) | untouched |
| Correlation protection | `CorrelationModel` + `evidence_weight` gate (discount grows only near certainty) | untouched |
| Update step | `observe(&ProbeResult)` — predict → discount → log-space `bayesian_update` | untouched |
| Deduplication | `bayesian_update` dedup on (source, hypothesis) | untouched |
| Numerical stability | log-space, NaN discarded, ±inf preserved (`math.rs` primitives) | untouched |
| Output | `diagnosis()` (MAP + prob), `ranked()`, `uncertainty()`, `priors()` | untouched |

Public entry points used: `DiagnosticEngine::new()`, `.observe()`,
`.diagnosis()`, `.ranked()`.

## 2. The existing bridge (found dead, now live)

`monitor.rs::diagnostic_probes(&ProbeOutcomeRecord) -> Vec<ProbeResult>` already
existed with **zero production callers** — it maps measured layers to
diagnostic tests (dns→DnsResolve, tcp→TcpConnect, tls→TlsHandshake,
http→HttpGet), classifies HTTP status into the six-outcome model
(401/403→AuthRejected, 429→RateLimited, 5xx→ServerError), and maps
`LayerResult::Unknown` → **Missing** ("never exercised", never a failure).
N1.1 activates it. It was built for exactly this integration.

## 3. The new data path

```
probe_api(entry)                          [monitor.rs — unchanged]
  └─ diagnostic_probes(&outcome)          [existing bridge — now called]
      └─ timestamp: ms → seconds          [call site; see §4]
          └─ DiagnosticEngine::observe()  [authoritative engine — per-investigation instance]
              └─ (posterior)
run_analyze_stage: engine.diagnosis()/ranked() → HypothesisCreated/Updated events
                   → real posteriors in inv.hypotheses → AnalysisCompleted event
run_verify_stage: verify_layer_for(top) → re-probe implicated layer on a
                  failing API → engine.observe(verification measurement)
                  → final posterior → verdict (0.25 floor preserved)
finish_completed: result text from the final posterior
```

Per-investigation engine instance: fresh uniform prior (`DiagnosticEngine::new()`),
no shared mutable state, no lock contention during analysis. The prior is NOT
loaded from `LearningEngine` — no established, validated prior-learning
mechanism exists (mission §4: no automatic prior adjustment).

## 4. Timestamp unit resolution (NANI-022)

`predict()` calibrates `exp(-0.001·delta)` for **seconds**; the
`CORRELATION_WINDOW_MS = 300_000` constant compares raw timestamp deltas (ms
semantics). The investigation passes **unix seconds** at its call site:
predict semantics are correct (a 1s gap ≈ no mixing), and the correlation
window then spans the whole bounded investigation — which is the intended
behavior (dns/tcp/tls/http of one endpoint within one investigation are one
causal chain and must be discounted; separate investigations start with fresh
engines, so no stale history). Engine-internal harmonization is registered as
NANI-022 (LOW, deferred) — no engine math was changed.

## 5. What the frontend receives (unchanged schema)

`HypothesisCreated`/`HypothesisUpdated` (top-5 ranked, real posteriors),
`AnalysisCompleted { top_hypothesis, confidence, insufficient_evidence }`,
`VerificationCompleted { route_id, verified }`, plus the existing
probe/observation/evidence events. The reducer consumes every kind
(verified against current `naniEvents.ts`). The frontend computes no posterior
of its own; it displays the backend's distribution. **No event schema was
invented; no `events/mod.rs` edit was needed** (deliberate: that file carries
concurrent in-flight user work and N1.1 does not require touching it).

## 6. Provenance upgrades (additive)

`InvestigationObservation` now records `result` ("ok"/"failed"/"unknown" — the
kind behind the boolean) and `detail` (sanitized measurement detail, e.g. HTTP
status). Both `#[serde(default)]` — previously persisted records still decode.
This is what makes the exact-oracle test (N1_05) possible and makes Missing
distinguishable from Failure in persisted evidence.
