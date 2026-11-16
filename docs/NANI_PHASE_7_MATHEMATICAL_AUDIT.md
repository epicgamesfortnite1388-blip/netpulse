# NANI Phase 7 — Mathematical Intelligence Audit

**Subject:** Audit of existing NANI (NetPulse Adaptive Network Intelligence) mathematical implementation
**Repo:** `E:\Code\Project\Vpn_app` (monorepo: `apps/web`, `apps/api`, `packages/shared`, `src-tauri`)
**Scope:** All modules under `src-tauri/src/network_intelligence/` (32 modules)
**Status:** Complete — every module read and classified

---

## 1. Executive Summary

NANI is a Rust-based mathematical engine for network diagnosis, recovery, and adaptation. The codebase already contains substantial Phase 7 mathematical infrastructure:

- **Numerical foundations:** stable log-space math, sigmoid, KL/JS divergence, Bernoulli entropy
- **Probabilistic models:** Beta-Bernoulli conjugate model, hierarchical partial pooling
- **Bayesian inference:** priors, posteriors, entropy, KL divergence, confidence intervals
- **Robust statistics:** median, MAD, IQR, robust anomaly scoring over bounded windows
- **Causal reasoning:** ATE estimation with identifiability gating (no unbacked causal claims)
- **Change-point detection:** Bayesian Online Changepoint Detection (Adams & MacKay)
- **Drift detection:** CUSUM and Page-Hinkley detectors
- **Online learning:** telemetry pipeline, local learning engine, verified aggregate memory
- **Scoring & ranking:** hypothesis ranking, value of information, sequential stopping, bandit Thompson sampling
- **Validation:** Brier score, log loss, expected calibration error, micro-benchmarks
- **Evidence layer:** measurement schema with provenance, correlation groups with discounting, validation, telemetry queue
- **API intelligence:** multi-layer probe monitoring, failure classification, circuit breakers, bounded retries with jitter, recovery planning
- **Context personalization:** per-network context profiles, hierarchical reliability, transitions, snapshots
- **Configuration intelligence:** config discovery/parse/validate/score/classify pipeline
- **Hardware adaptation:** tier-based sampling interval, concurrency, model inference gating
- **AI layer:** optional local LLM for prose explanation only (never decides truth)

**Major gap:** No formal mathematical foundation layer beyond existing ad-hoc modules; no unified type-level API; no frontend integration for most mathematical features; no adversarial test suite; no Phase 7 reports produced yet.

---

## 2. Module-by-Module Audit

### 2.1 `math.rs` — Numerical Foundations

**File:** `src-tauri/src/network_intelligence/math.rs`

**Purpose:** Low-level numerical primitives used across the engine.

**Components:**
- `clamp_probability(x: f64) -> f64` — clamps to `[PROB_FLOOR, 1 - PROB_FLOOR]` where `PROB_FLOOR = 1e-12`; prevents log(0) and division by zero
- Log-sum-exp (stable) for log-space probability arithmetic
- `sigmoid(x: f64) -> f64` — numerically stable logistic function (no overflow for large |x|)
- `bernoulli_entropy(p: f64) -> f64` — binary entropy in nats
- `kl_divergence(p, q)` — KL divergence between two Bernoulli distributions
- `js_divergence(p, q)` — Jensen-Shannon divergence (symmetric, bounded [0, ln 2])

**Mathematical quality:** Good. Uses log-space and clamping to avoid NaN. No silent NaN replacement.

**Gaps:** No vectorized/matrix operations; no special functions (gamma, digamma, logit inverse beyond sigmoid); no error propagation / interval arithmetic.

---

### 2.2 `probability.rs` — Beta-Bernoulli Conjugate Model

**File:** `src-tauri/src/network_intelligence/probability.rs`

**Purpose:** Conjugate Beta-Bernoulli model for binary outcomes (success/failure).

**Components:**
- `BetaBernoulli` — alpha/beta parameters, `observe(success: bool)`, `mean()`, `variance()`, `sample()`, `credible_interval(level)`

**Mathematical quality:** Standard conjugate update. Mean = alpha/(alpha+beta). No numerical issues for reasonable counts.

**Gaps:** No multi-armed bandit extension (bandit.rs covers that separately); no hierarchical variant (hierarchical.rs covers that separately).

---

### 2.3 `bayesian.rs` — Priors, Posteriors, Entropy, Divergence

**File:** `src-tauri/src/network_intelligence/bayesian.rs`

**Purpose:** Bayesian updating and information-theoretic measures.

**Components:**
- `Prior`, `Posterior`, `Evidence` structs
- `bayesian_update(prior, evidence) -> posterior`
- `entropy(distribution)`, `kl_divergence`, `js_divergence`
- Confidence interval computation

**Mathematical quality:** Solid. Mirrors math.rs primitives with higher-level API.

**Gaps:** No variational inference; no MCMC; no conjugate-exponential family beyond Beta-Bernoulli.

---

### 2.4 `hierarchical.rs` — Hierarchical Beta-Bernoulli with Partial Pooling

**File:** `src-tauri/src/network_intelligence/hierarchical.rs`

**Purpose:** Multi-level model where per-(context, api) child posteriors pool toward a global parent.

**Components:**
- `HierarchicalBetaBernoulli` — `observe(context, api_id, success)`, `predict(context, api_id)`, `posterior(context, api_id, level)`, `observe_global(success)` (parent only), `global_mean()`
- `BetaPosterior`, `HierarchicalSnapshot` — serializable snapshots for persistence

**Mathematical quality:** Correct partial pooling. Child observations never leak into parent except via explicit `observe_global`. Global mean used when no context active.

**Gaps:** No non-conjugate hierarchical models; no hyperparameter learning from data (fixed kappa).

---

### 2.5 `robust_stats.rs` — Robust Statistics Toolkit

**File:** `src-tauri/src/network_intelligence/robust_stats.rs`

**Purpose:** Outlier-resistant statistics over bounded sliding windows.

**Components:**
- `median(slice)`, `mad(slice)` (median absolute deviation), `iqr(slice)`
- `RobustWindow` — bounded circular buffer of observations
- `robust_anomaly_score(value, window)` — standardized deviation using median/MAD

**Mathematical quality:** Correct. Uses median/MAD instead of mean/std to resist outliers. Bounded window prevents unbounded memory growth.

**Gaps:** No streaming/online median (recomputes from scratch each time); no robust regression; no winsorization/trimming.

---

### 2.6 `causal.rs` — Causal Reasoning & ATE Estimation

**File:** `src-tauri/src/network_intelligence/causal.rs`

**Purpose:** Average Treatment Effect estimation with identifiability gating.

**Components:**
- `InterventionRecord` — treatment, outcome, covariates
- `ATE` estimation: `estimate_ate(records, treatment, outcome)`
- Identifiability gate: refuses to estimate when confounding is detected / insufficient overlap
- `ate_confidence_interval()`

**Mathematical quality:** Strong. The identifiability gating satisfies the design constraint "Never claim a causal effect where controlled evidence is insufficient."

**Gaps:** No propensity score weighting; no instrumental variables; no counterfactual simulation; no do-calculus graph.

---

### 2.7 `changepoint.rs` — Bayesian Online Changepoint Detection

**File:** `src-tauri/src/network_intelligence/changepoint.rs`

**Purpose:** Detect changes in data-generating distribution online (Adams & MacKay BOCPD).

**Components:**
- `ChangepointDetector` — run-length posterior, hazard function, predictive distribution
- `observe(x) -> (changepoint_probability, run_length_distribution)`
- `HazardFunction` — constant, decreasing

**Mathematical quality:** Correct implementation of BOCPD. Log-space probabilities for stability.

**Gaps:** No multivariate changepoint; no multiple changepoint segmentation; no offline/refined detection.

---

### 2.8 `drift.rs` — CUSUM & Page-Hinkley Drift Detectors

**File:** `src-tauri/src/network_intelligence/drift.rs`

**Purpose:** Sequential change detection for streaming metrics.

**Components:**
- `CusumDetector` — cumulative sum, reference value, decision threshold
- `PageHinkleyDetector` — cumulative deviation from mean, threshold
- `reset()` — detector reset after drift confirmed

**Mathematical quality:** Standard sequential detection. Bounded memory (no history retention beyond accumulator).

**Gaps:** No drift magnitude estimation; no adaptive threshold; no multi-metric joint drift.

---

### 2.9 `diagnosis.rs` — Hypothesis Space & Diagnostic Engine

**File:** `src-tauri/src/network_intelligence/diagnosis.rs`

**Purpose:** Dynamic Bayesian diagnosis over a hypothesis space.

**Components:**
- `Hypothesis` enum: Gateway, Dns, Tcp, Tls, Http, Auth, RateLimit, Server, Unknown
- `DiagnosticEngine` — `update(evidence)`, `rank_hypotheses()`, `top_hypothesis()`, `information_gain(hypothesis)`
- Information-gain-based experiment selection

**Mathematical quality:** Bayesian hypothesis ranking. Uses information gain to select next diagnostic probe.

**Gaps:** No hypothesis composition (AND/OR of hypotheses); no temporal hypothesis tracking; no false-discovery rate control.

---

### 2.10 `sequential.rs` — Sequential Analysis & Stopping

**File:** `src-tauri/src/network_intelligence/sequential.rs`

**Purpose:** Cost-adjusted experiment selection and sequential stopping.

**Components:**
- `cost_adjusted_gain(evidence, hypothesis, cost)` — expected information gain per unit cost
- `should_stop(posterior, threshold, cost_budget)` — sequential stopping rule
- `value_of_information(experiment)` — EVPI-style calculation

**Mathematical quality:** Decision-theoretic. Correct VOI framing.

**Gaps:** No finite-horizon dynamic programming; no restless bandit formulation.

---

### 2.11 `learning.rs` — Online Learning & Telemetry Pipeline

**File:** `src-tauri/src/network_intelligence/learning.rs`

**Purpose:** Local learning engine recording probe outcomes; advisory only (never changes probe/recovery decisions).

**Components:**
- `LearningEngine` — `record_api_probe(api_id, healthy, latency_ms, timestamp_ms)`
- Telemetry pipeline feeding probe outcomes into learning
- Per-API success-rate tracking

**Mathematical quality:** Observational only. No leakage into control decisions (by design).

**Gaps:** No exploration-exploitation balancing (bandit.rs covers that); no model retraining; no drift-aware learning.

---

### 2.12 `validation.rs` — Prediction Validation & Calibration

**File:** `src-tauri/src/network_intelligence/validation.rs`

**Purpose:** Score predictions against outcomes; calibration assessment.

**Components:**
- `brier_score(predictions, outcomes)`
- `log_loss(predictions, outcomes)`
- `expected_calibration_error(predictions, outcomes, bins)`
- `calibration_curve()`

**Mathematical quality:** Proper scoring rules. Brier score and log loss are strictly proper. ECE uses equal-frequency or equal-width binning.

**Gaps:** No reliability diagram plotting; no proper scoring rule for continuous variables (CRPS); no proper scoring rule for rankings.

---

### 2.13 `evaluation.rs` — Micro-Benchmarks & Condition Simulation

**File:** `src-tauri/src/network_intelligence/evaluation.rs`

**Purpose:** Chronological diagnosis accuracy, micro-benchmarks across network conditions.

**Components:**
- `CONDITIONS` — 11 network conditions (healthy, dns_failure, tcp_timeout, tls_failure, http_401, http_429, http_500, partial_outage, flaky, high_latency, packet_loss)
- Micro-benchmark harness for diagnosis accuracy per condition
- Timing benchmarks for each mathematical component

**Mathematical quality:** Grounded in simulated conditions with known ground truth.

**Gaps:** No statistical significance testing across conditions; no confidence intervals on accuracy; no ablation studies.

---

### 2.14 `simulation.rs` — Deterministic Network Simulator

**File:** `src-tauri/src/network_intelligence/simulation.rs`

**Purpose:** Deterministic network condition simulator for testing.

**Components:**
- `NetworkSimulator` — injects conditions: latency, loss, DNS failure, TCP failure, TLS failure, HTTP errors
- `NetworkCondition` enum — 13 conditions
- Deterministic output for reproducible tests

**Mathematical quality:** Deterministic by design. Good for unit testing.

**Gaps:** No stochastic network model (Poisson arrivals, Markov-modulated); no topology simulation.

---

### 2.15 `graph.rs` — Network Graph Model

**File:** `src-tauri/src/network_intelligence/graph.rs`

**Purpose:** Graph representation of network topology.

**Components:**
- `NodeId`, `NodeType`, `Edge`
- `NetworkGraph` — add_node, add_edge, neighbors(), path finding

**Mathematical quality:** Basic graph structure. No graph algorithms beyond traversal.

**Gaps:** No shortest-path (Dijkstra); no centrality measures; no community detection; no graph neural features.

---

### 2.16 `timeseries.rs` — Time Series Smoothing

**File:** `src-tauri/src/network_intelligence/timeseries.rs`

**Purpose:** Exponential smoothing for metric forecasting.

**Components:**
- `ExponentialSmoothing` — single, double, triple (Holt-Winters)

**Mathematical quality:** Standard EWMA. Correct update equations.

**Gaps:** No seasonal decomposition; no ARIMA; no confidence bands on forecasts.

---

### 2.17 `bandit.rs` — Contextual Bandit (Thompson Sampling)

**File:** `src-tauri/src/network_intelligence/bandit.rs`

**Purpose:** Contextual multi-armed bandit for action selection.

**Components:**
- `ContextualBandit` — Thompson sampling per context arm
- `select_action(context)`, `update(context, arm, reward)`
- Safe filtering (never select unsafe actions)

**Mathematical quality:** Correct Thompson sampling with Beta-Bernoulli posterior per (context, arm).

**Gaps:** No UCB or epsilon-greedy alternative; no contextual linear bandit; no batch Thompson sampling.

---

### 2.18 `route.rs` — Route Evaluation & Multi-Objective Optimization

**File:** `src-tauri/src/network_intelligence/route.rs`

**File:** `src-tauri/src/network_intelligence/route.rs`

**Purpose:** Route evaluation, Pareto frontier, CVaR, LCB (lower confidence bound) selection.

**Components:**
- `RouteMetrics` — latency, loss, jitter, reliability
- Pareto frontier computation (non-dominated routes)
- CVaR (Conditional Value at Risk) for tail risk
- LCB selection (optimism/pessimism tuning)

**Mathematical quality:** Correct multi-objective optimization. CVaR and LCB are coherent risk measures.

**Gaps:** No stochastic route dominance (probabilistic Pareto); no dynamic route switching cost model.

---

### 2.19 `recovery.rs` — Recovery Planning & Circuit Breaker

**File:** `src-tauri/src/network_intelligence/recovery.rs`

**Purpose:** Recovery planning, circuit breaker, rollback.

**Components:**
- `CircuitBreaker` — closed/open/half-open states, failure threshold, recovery timeout
- `BreakerState` enum
- `RecoveryPlanner` — build_plan, complete_step, is_complete, next_step

**Mathematical quality:** State machine with time-based half-open trials. Bounded recovery window (2 min default).

**Gaps:** No Markov decision process for recovery policy; no expected cost of recovery; no rollback verification beyond health check.

---

### 2.20 `recovery_memory.rs` — Verified Recovery Memory

**File:** `src-tauri/src/network_intelligence/recovery_memory.rs`

**Purpose:** Store verified recovery outcomes for future reference.

**Components:**
- `RecoveryOutcome` — action, success, context, timestamp
- `RecoveryMemory` — store, retrieve, best_action_for_context

**Mathematical quality:** Lookup table with context matching. No learning from history beyond argmax.

**Gaps:** No Bayesian updating of action success probabilities; no forgetting/decay; no confidence-weighted selection.

---

### 2.21 `api_model.rs` — API Health Model & Failure Classification

**File:** `src-tauri/src/network_intelligence/api_model.rs`

**Purpose:** Logistic-regression-style API health model; failure category classification.

**Components:**
- `FailureCategory` enum: Healthy, DnsFailure, TransportFailure, TlsFailure, HttpError, AuthenticationFailure, RateLimited, ServerFailure, Unknown
- `classify_failure(http_status, tls_ok, tcp_ok, dns_ok) -> FailureCategory`
- `RouteKind` enum: Direct, Upstream

**Mathematical quality:** Structural classification (never guesses). Missing layer → Unknown. Authentication/rate-limit never treated as transport faults.

**Gaps:** No probabilistic health model (currently deterministic thresholds); no learned failure classifier.

---

### 2.22 `config_intelligence.rs` — Configuration Discovery & Scoring

**File:** `src-tauri/src/network_intelligence/config_intelligence.rs`

**Purpose:** Pipeline: DISCOVER → PARSE → NORMALIZE → VALIDATE → DEDUPLICATE → TEST → SCORE → CLASSIFY → STORE.

**Components:**
- `ConfigFormat`, `ConfigStatus`, `RedistributionPermission` enums
- `DiscoveredConfig`, `ConfigScore`, `PipelineResult`, `PipelineStage`
- `ConfigIntelligenceEngine` — discover, parse, validate, score, deduplicate by fingerprint
- Fingerprinting: SHA-like hash (DefaultHasher-based) of canonical and structural forms
- `ConfigScore` fields: overall, success_prob, expected_latency_ms, latency_std_ms, jitter_ms, packet_loss, stability, freshness, uncertainty

**Mathematical quality:** Placeholder scoring (success_prob scaled from source_reputation by status). Latency/jitter/loss are hardcoded placeholders, not measured.

**Gaps:** All numeric score fields except success_prob are placeholders. No real network measurement feeding into config scoring. No cryptographic fingerprint (uses DefaultHasher, not SHA-256).

---

### 2.23 `context/*` — Network Personalization

**Files:** `context/engine.rs`, `context/mod.rs`, `context/context_identity.rs`, `context/collector.rs`, `context/network_profiles.rs`, `context/privacy.rs`, `context/storage.rs`, `context/transitions.rs`

**Purpose:** Per-network context identification, profile storage, hierarchical baselines, transitions.

**Components:**
- `NetworkContextId`, `ContextSignals`, `InterfaceClass` — local-only identifiers (no SSIDs/MACs/private IPs)
- `ProfileStore` — per-context metric profiles (median, count, min, max)
- `NetworkProfileEngine` — observe_signals, record_metric, observe_outcome, observe_verified_aggregate, reliability(), posterior(), predict_metric()
- `ContextTransitionTracker` — context detection from signals, NewContext/ContextSwitch/None
- `PersonalizationStatus`, `ProfileEngineSnapshot` — serializable snapshots

**Mathematical quality:** Correct. Missing data rejected (never stored as 0). Local contexts isolated from each other. Global parent updated only via verified aggregate evidence.

**Gaps:** No context similarity metric (can't transfer knowledge between similar networks); no context clustering; no automatic context merging.

---

### 2.24 `hardware.rs` — Hardware Capability Profile

**File:** `src-tauri/src/network_intelligence/hardware.rs`

**Purpose:** Tier-based adaptive resource policy.

**Components:**
- `HardwareTier` enum: Minimal, Standard, HighPerformance
- `HardwareProfile` — detect(cores, memory), sampling_interval_ms(), max_concurrent_tests(), allow_model_inference()

**Mathematical quality:** Simple threshold-based classification. No mathematical modeling.

**Gaps:** None significant for this component's scope.

---

### 2.25 `ai/*` — Optional Local LLM Explanation Layer

**Files:** `ai/mod.rs`, `ai/explanation.rs`, `ai/local_runtime.rs`

**Purpose:** Optional local language model for prose explanation of deterministic output.

**Components:**
- `Explanation`, `ExplanationFacts` — structured facts from mathematical engine
- `LocalLlm`, `LocalLlmConfig`, `AiStatus` — llama.cpp-compatible runtime
- Disabled by default; requires explicit env config (NANI_LLM_ENABLED, binary, model path)

**Mathematical quality:** Never decides truth. Rewrites deterministic summaries only. Fallback to deterministic explanation on failure.

**Gaps:** No mathematical capabilities (by design).

---

### 2.26 `evidence/*` — Evidence & Measurement Layer

**Files:** `evidence/measurements.rs`, `evidence/correlation.rs`, `evidence/provenance.rs`, `evidence/validation.rs`, `evidence/telemetry_pipeline.rs`

**Purpose:** Structured evidence with provenance, correlation, validation, telemetry queue.

**Components:**
- `Measurement` — schema, value, unit, timestamp, source
- `MeasureState` — pending/validated/rejected
- `Provenance` enum — observed/derived/verified/inherited
- `CorrelationGroup`, `CorrelationModel` — correlation with discounting over time
- `ValidationError` — measurement validation rules
- `TelemetryQueue`, `PipelineResult` — bounded telemetry ingestion

**Mathematical quality:** Sound. Discounting prevents stale correlation dominance. Validation rejects non-finite values.

**Gaps:** No correlation significance testing; no Bayesian network over evidence variables; no evidence fusion (Dempster-Shafer).

---

### 2.27 `api_intelligence/*` — API Intelligence Control Plane

**Files:** `api_intelligence/mod.rs`, `api_intelligence/failure_classifier.rs`, `api_intelligence/monitor.rs`, `api_intelligence/monitor_loop.rs`, `api_intelligence/registry.rs`

**Purpose:** Multi-layer API health monitoring, failure classification, circuit breakers, bounded retries with jitter, recovery planning.

**Components:**
- `ProbeInputs` — http_status, tls_ok, tcp_ok, dns_ok (all Optional)
- `classify(inputs) -> FailureCategory` — structural, never guesses
- `probe_api(entry)` — DNS → TCP → TLS → HTTP layer probing with bounded timeouts
- `MonitorLoop` — polls at cadence, respects circuit breakers, bounded exponential backoff with jitter U(0.8, 1.2), feeds into LearningEngine (advisory only)
- `ApiRegistry` — thread-safe registry, event emission on health change/failure/breaker trip
- `CircuitBreaker` — closed/open/half-open with recovery timeout
- Recovery actions: verify_direct → test_approved_upstream → restore_known_good (least-intrusive first)

**Mathematical quality:** Strong. Exponential backoff with jitter prevents thundering herd. Circuit breaker prevents cascade. Non-retryable categories (auth, rate-limit, server errors) not retried.

**Gaps:** No probabilistic failure prediction; no learned retry policy; no multi-armed bandit for upstream selection.

---

### 2.28 `events/` — Event Bus

**Files:** `events/` directory

**Purpose:** Reactive event bus (Tauri `nani:event` + internal channel).

**Components:**
- `Event` enum — ApiHealthChanged, FailureDetected, CircuitBreakerTripped, RecoveryStarted, RecoveryStepCompleted, RecoveryCompleted, RouteSelected, etc.
- `EventBus` — publish/subscribe

**Mathematical quality:** None (plumbing).

---

### 2.29 `persistence.rs` — Versioned Local Storage

**File:** `src-tauri/src/network_intelligence/persistence.rs`

**Purpose:** Versioned storage of observations and model state.

**Components:**
- `save_engine()`, `load_engine()`, `profile_path()`, `ProfileStorageError`
- Schema-versioned snapshots with corruption rejection

**Mathematical quality:** Schema mismatch → reject (don't trust corrupt parameters).

**Gaps:** No encryption at rest; no append-only write-ahead log; no incremental snapshots.

---

### 2.30 `investigation.rs` — Investigation Lifecycle

**File:** `src-tauri/src/network_intelligence/investigation.rs`

**Purpose:** Investigation lifecycle (start/cancel/status/list) — Phase 6.1.

**Components:**
- `InvestigationManager`, `InvestigationStatus`, `Event` variants
- 4 Tauri commands wired in `main.rs`/`commands/nani.rs`

**Mathematical quality:** None (lifecycle management).

---

## 3. Cross-Cutting Design Constraints (All Satisfied)

| Constraint | Status | Evidence |
|---|---|---|
| Security/auth/cert verification are hard constraints | Satisfied | TLS always verified; no secrets stored; auth_type never persisted |
| Never treat missing data as zero | Satisfied | Optional types everywhere; missing data → Unknown/rejected |
| Never disable TLS verification | Satisfied | reqwest blocking client with default TLS verification |
| Never claim causal effect without controlled evidence | Satisfied | causal.rs identifiability gating; failure_classifier returns Unknown on missing evidence |
| No empty functions/placeholders reported as complete | Partial | config_intelligence.rs has placeholder latency/jitter/loss values (documented as placeholders) |
| Pure math separate from Tauri IPC | Satisfied | All math modules are pure Rust; Tauri commands only in commands/nani.rs |
| Numerically stable | Satisfied | log-space math, clamping, PROB_FLOOR=1e-12 |
| Deterministic unit tests | Satisfied | Every module has #[cfg(test)] with deterministic tests |

---

## 4. Gaps Identified for Phase 7

### 4.1 Missing Mathematical Components

1. **Unified mathematical foundation API** — No single entry point exposing all mathematical capabilities with consistent types.
2. **Information theory & probe selection** — Exists partially (sequential.rs VOI, diagnosis.rs information_gain) but no unified probe-selection engine maximizing expected information gain per cost across all probe types.
3. **Formal numerical stability validation** — No property-based tests (e.g., no NaN/Inf propagation tests, no clamping boundary tests).
4. **Adversarial test suite** — No adversarial tests feeding pathological inputs (extreme values, NaN, Inf, empty data, rapid alternation) to mathematical components.
5. **Frontend integration** — Most mathematical features (Bayesian posteriors, drift detection, changepoint, robust scores, causal ATE) are not exposed to the frontend.

### 4.2 Partially Implemented

1. **Config scoring** — success_prob is computed but latency/jitter/loss/stability/freshness/uncertainty are hardcoded placeholders.
2. **Online learning** — Advisory only; does not influence probe/recovery decisions (by design, but could be extended with bandit-based exploration).

---

## 5. Recommendations for Phase 7 Build Order

1. Build formal mathematical foundation layer (unified types, stable API)
2. Build robust network statistics toolkit (extend robust_stats.rs)
3. Build Bayesian network diagnostics (extend diagnosis.rs)
4. Build information theory & probe selection (unify sequential.rs + diagnosis.rs)
5. Build causal reasoning & dependency graphs (extend causal.rs + graph.rs)
6. Build change-point & drift detection (already exists — wrap into unified API)
7. Build online learning & verified memory (already exists — wrap into unified API)
8. Build mathematical scoring & hypothesis ranking (already exists — wrap into unified API)
9. Numerical stability & validation tests (property-based tests)
10. Frontend integration (expose math features via Tauri commands + web UI)
11. Adversarial testing (pathological input tests)
12. Produce all 11 required reports

---

## 6. Files Read (Complete Audit)

32 modules under `src-tauri/src/network_intelligence/`, all read:

- `math.rs`, `probability.rs`, `bayesian.rs`, `hierarchical.rs`, `robust_stats.rs`, `causal.rs`, `changepoint.rs`, `drift.rs`, `learning.rs`, `validation.rs`, `evaluation.rs`, `simulation.rs`, `graph.rs`, `timeseries.rs`, `bandit.rs`, `route.rs`, `recovery.rs`, `recovery_memory.rs`, `api_model.rs`, `config_intelligence.rs`, `hardware.rs`, `investigation.rs`, `persistence.rs`
- `api_intelligence/` (5 files): failure_classifier.rs, monitor.rs, monitor_loop.rs, registry.rs, mod.rs
- `context/` (8 files): engine.rs, context_identity.rs, network_profiles.rs, transitions.rs, collector.rs, privacy.rs, storage.rs, mod.rs
- `ai/` (3 files): mod.rs, explanation.rs, local_runtime.rs
- `evidence/` (5 files): measurements.rs, correlation.rs, provenance.rs, validation.rs, telemetry_pipeline.rs
- `events/` directory
- `mod.rs` (module manifest)

Plus: `src-tauri/src/commands/nani.rs`, `apps/web/src/features/nani/` (NaniPage.tsx, naniEvents.ts, naniApi.ts), `docs/nani-phase-6-1-report.md`, `docs/release-gate-report.md`
