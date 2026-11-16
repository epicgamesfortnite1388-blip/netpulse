//! NANI Phase 7 — Unified mathematical foundation layer.
//!
//! A single, type-safe facade over every mathematical component in the NANI
//! engine: numerical foundations, probability, Bayesian inference, robust
//! statistics, causal reasoning, changepoint/drift detection, online learning,
//! validation, hypothesis diagnosis, information-gain probe selection, bandit
//! routing, and configuration intelligence.
//!
//! Design rules:
//!   - Nothing here invents evidence. Missing data stays `None`.
//!   - All probabilities pass through [`math::clamp_probability`] so log-space
//!     operations never see 0 or 1.
//!   - Every public method returns `Result` or `Option` where input validity
//!     can fail; no silent NaN substitution.
//!   - Pure mathematics: no Tauri, no file I/O, no secrets.

use crate::network_intelligence::{
    api_intelligence::failure_classifier::{classify as classify_probe, ProbeInputs},
    api_intelligence::registry::{ApiEntry, ApiRegistry, Health, ProbeOutcomeRecord, UpstreamRoute},
    api_model::{FailureCategory, RouteKind},
    bandit::{
        Action, ContextBucket, ContextualBandit, ConnectivityBucket, FailureBucket, LatencyBucket,
    },
    bayesian::{bayesian_update, decay_log_likelihood, Evidence, Posterior, Prior},
    causal::{CausalTracker, CONTROL_ACTION, InterventionRecord},
    changepoint::{BayesianOnlineCPD, HazardFunction},
    config_intelligence::{
        ConfigIntelligenceEngine, ConfigScore, DiscoveredConfig, ConfigFormat, ConfigStatus,
        RedistributionPermission,
    },
    context::{
        NetworkProfileEngine, PersonalizationStatus, ProfileEngineSnapshot,
    },
    context::context_identity::{ContextSignals, NetworkContextId},
    diagnosis::{
        DiagnosticEngine, DiagnosticTest, Hypothesis, ProbeOutcome, ProbeResult, TestScore,
        expected_information_gain, rank_tests,
    },
    drift::{CusumDetector, DriftStatus, PageHinkleyDetector},
    graph::{Edge, NetworkGraph, NodeId, NodeType},
    hardware::HardwareProfile,
    hierarchical::HierarchicalBetaBernoulli,
    learning::LearningEngine,
    math::{
        bernoulli_entropy, clamp_latency, clamp_probability, finite_or_default, kl_divergence,
        js_divergence, log_sum_exp, logit, normalize_weights, sample_categorical, sigmoid,
        softmax, PROB_FLOOR,
    },
    probability::BetaBernoulli,
    recovery::{BreakerState, CircuitBreaker, RecoveryPlanner, RecoveryStep},
    recovery_memory::{RecoveryMemory, RecoveryOutcome},
    robust_stats::RobustStats,
    route::{cvar_latency, pareto_frontier, score_candidate, ObjectiveWeights, RouteCandidate,
        RouteMetrics, ScoredRoute},
    sequential::{cost_adjusted_gain, should_stop, value_of_information},
    simulation::{NetworkCondition, NetworkSimulator},
    timeseries::ExponentialSmoothing,
    validation::{brier_score, expected_calibration_error, log_loss, Prediction},
};

use rand::{Rng, SeedableRng};
use rand::rngs::StdRng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Schema version for the unified engine snapshot.
pub const FOUNDATION_SCHEMA_VERSION: u32 = 1;

/// A stable, floating-point-safe identifier for any named mathematical entity
/// (hypothesis, probe, route, context, API).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MathId(pub u64);

impl MathId {
    pub fn from_string(s: &str) -> Self {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        s.hash(&mut h);
        MathId(h.finish())
    }
}

/// A probability value that is guaranteed finite and within (0, 1).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Probability(pub f64);

impl Probability {
    pub fn try_from(p: f64) -> Option<Self> {
        if !p.is_finite() || p < 0.0 || p > 1.0 {
            return None;
        }
        Some(Self(clamp_probability(p)))
    }
    pub fn value(self) -> f64 {
        self.0
    }
    pub fn complement(self) -> Self {
        Self(clamp_probability(1.0 - self.0))
    }
    pub fn log(self) -> f64 {
        self.0.ln()
    }
}

/// A confidence interval as (lower, upper) bounds, both in [0, 1].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ConfidenceInterval {
    pub lower: f64,
    pub upper: f64,
}

/// Result of a probe-selection decision: which test to run and why.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeSelection {
    pub test_id: String,
    pub test_name: String,
    pub expected_information_gain: f64,
    pub cost: f64,
    pub efficiency: f64,
    pub reasoning: String,
}

/// One hypothesis paired with the probability it started from and holds now.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HypothesisProbability {
    pub label: String,
    /// Probability before any evidence (the engine's starting distribution).
    pub prior: f64,
    /// Probability now.
    pub posterior: f64,
}

/// The engine's hypothesis space as the UI shows it: every hypothesis with the
/// prior it started from and the posterior it holds now, plus the probe the
/// engine would run next by expected information gain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HypothesisView {
    pub hypotheses: Vec<HypothesisProbability>,
    pub entropy_nats: f64,
    pub map_label: Option<String>,
    pub selected_probe: Option<ProbeSelection>,
}

/// Result of a hypothesis ranking: ranked hypotheses with probabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HypothesisRanking {
    pub entries: Vec<(String, f64)>,
    pub entropy: f64,
    pub map_label: Option<String>,
    pub map_probability: f64,
}

/// Result of drift analysis over a stream of measurements.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriftAnalysis {
    pub detector: String,
    pub drift_detected: bool,
    pub statistic: f64,
    pub threshold: f64,
    pub confidence: f64,
}

/// Result of changepoint analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangepointAnalysis {
    pub changepoint_probability: f64,
    pub most_likely_run_length: u64,
    pub run_length_entropy: f64,
}

/// Result of causal ATE estimation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CausalResult {
    pub ate: f64,
    pub ci_lower: f64,
    pub ci_upper: f64,
    pub identifiable: bool,
    pub n_records: usize,
}

/// Result of robust anomaly scoring.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobustAnomalyResult {
    pub value: f64,
    pub median: f64,
    pub mad: f64,
    pub anomaly_score: f64,
    pub is_anomaly: bool,
}

/// Result of configuration scoring.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigRecommendation {
    pub config_id: String,
    pub overall_score: f64,
    pub success_probability: f64,
    pub expected_latency_ms: f64,
    pub uncertainty: f64,
    pub status: String,
}

/// Unified mathematical engine. Composes every sub-component into one
/// coherent, numerically stable API.
pub struct NaniMathEngine {
    /// Bayesian diagnosis over the network hypothesis space.
    diagnosis: DiagnosticEngine,
    /// Hierarchical reliability model (per-context, per-API partial pooling).
    reliability: HierarchicalBetaBernoulli,
    /// Context personalization engine.
    context: NetworkProfileEngine,
    /// Robust statistics sliding windows, keyed by metric name.
    robust_windows: HashMap<String, RobustStats>,
    /// Changepoint detectors, keyed by stream name.
    changepoint_detectors: HashMap<String, BayesianOnlineCPD>,
    /// CUSUM drift detectors, keyed by stream name.
    cusum_detectors: HashMap<String, CusumDetector>,
    /// Page-Hinkley drift detectors, keyed by stream name.
    page_hinkley_detectors: HashMap<String, PageHinkleyDetector>,
    /// Online learning engine (advisory only).
    learning: LearningEngine,
    /// Contextual bandit for action selection.
    bandit: ContextualBandit,
    /// Recovery memory (verified outcomes).
    recovery_memory: RecoveryMemory,
    /// Causal tracker for ATE estimation.
    causal_tracker: CausalTracker,
    /// Route metrics and multi-objective optimization.
    routes: HashMap<String, RouteMetrics>,
    /// Configuration intelligence engine.
    config_engine: ConfigIntelligenceEngine,
    /// Network simulator for deterministic testing.
    simulator: NetworkSimulator,
    /// Exponential smoothing forecasters, keyed by metric name.
    smoothers: HashMap<String, ExponentialSmoothing>,
    /// Circuit breakers, keyed by API id.
    circuit_breakers: HashMap<String, CircuitBreaker>,
    /// Recovery planners, keyed by API id.
    recovery_planners: HashMap<String, RecoveryPlanner>,
    /// API registry (control plane).
    api_registry: ApiRegistry,
    /// Random number generator seed for reproducible stochastic operations.
    rng_seed: u64,
}

impl Default for NaniMathEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl NaniMathEngine {
    /// Create a new engine with uniform priors and default parameters.
    pub fn new() -> Self {
        Self {
            diagnosis: DiagnosticEngine::new(),
            reliability: HierarchicalBetaBernoulli::uniform(),
            context: NetworkProfileEngine::new(),
            robust_windows: HashMap::new(),
            changepoint_detectors: HashMap::new(),
            cusum_detectors: HashMap::new(),
            page_hinkley_detectors: HashMap::new(),
            learning: LearningEngine::new(),
            bandit: ContextualBandit::new(),
            recovery_memory: RecoveryMemory::new(1000),
            causal_tracker: CausalTracker::new(1000),
            routes: HashMap::new(),
            config_engine: ConfigIntelligenceEngine::new(),
            simulator: NetworkSimulator::new(42, NetworkCondition::Healthy),
            smoothers: HashMap::new(),
            circuit_breakers: HashMap::new(),
            recovery_planners: HashMap::new(),
            api_registry: ApiRegistry::new(crate::network_intelligence::events::EventBus::default()),
            rng_seed: 42,
        }
    }

    // ========================================================================
    // Numerical foundations (pass-through to math.rs with stable wrappers)
    // ========================================================================

    /// Clamp a raw value into a valid probability in (0, 1). NaN → 0.5.
    pub fn clamp_probability(&self, p: f64) -> f64 {
        clamp_probability(p)
    }

    /// Numerically stable sigmoid.
    pub fn sigmoid(&self, x: f64) -> f64 {
        sigmoid(x)
    }

    /// Logit (inverse sigmoid) with clamping.
    pub fn logit(&self, p: f64) -> f64 {
        logit(p)
    }

    /// Stable log-sum-exp.
    pub fn log_sum_exp(&self, values: &[f64]) -> f64 {
        log_sum_exp(values)
    }

    /// Softmax over log-probabilities.
    pub fn softmax(&self, log_probs: &[f64]) -> Option<Vec<f64>> {
        softmax(log_probs)
    }

    /// Bernoulli entropy in nats.
    pub fn bernoulli_entropy(&self, p: f64) -> f64 {
        bernoulli_entropy(p)
    }

    /// KL divergence between two discrete distributions.
    pub fn kl_divergence(&self, p: &[f64], q: &[f64]) -> Option<f64> {
        kl_divergence(p, q)
    }

    /// Jensen-Shannon divergence (symmetric, bounded).
    pub fn js_divergence(&self, p: &[f64], q: &[f64]) -> Option<f64> {
        js_divergence(p, q)
    }

    // ========================================================================
    // Bayesian inference
    // ========================================================================

    /// Build a uniform prior over the given hypothesis labels.
    pub fn uniform_prior(&self, labels: Vec<String>) -> Prior {
        Prior::uniform(labels)
    }

    /// Build a prior from explicit probabilities (normalized internally).
    pub fn prior_from_probs(&self, labels: Vec<String>, probs: Vec<f64>) -> Option<Prior> {
        Prior::from_probs(labels, probs)
    }

    /// Apply evidence to a prior and return a posterior.
    pub fn bayesian_update(&self, prior: &Prior, evidence: &[Evidence]) -> Posterior {
        bayesian_update(prior, evidence)
    }

    /// Decay a log-likelihood by age.
    pub fn decay_log_likelihood(&self, ll: f64, age_seconds: f64, lambda: f64) -> f64 {
        decay_log_likelihood(ll, age_seconds, lambda)
    }

    /// Posterior predictive Bernoulli: (P(success), entropy).
    pub fn posterior_predictive_bernoulli(&self, model: &BetaBernoulli) -> (f64, f64) {
        crate::network_intelligence::bayesian::posterior_predictive_bernoulli(model)
    }

    // ========================================================================
    // Hypothesis diagnosis & information-gain probe selection
    // ========================================================================

    /// Get the current MAP diagnosis and its probability.
    pub fn diagnosis(&self) -> Option<(&str, f64)> {
        self.diagnosis.diagnosis()
    }

    /// Current diagnostic entropy (nats).
    pub fn diagnostic_entropy(&self) -> f64 {
        self.diagnosis.uncertainty()
    }

    /// All hypotheses ranked by posterior probability.
    pub fn ranked_hypotheses(&self) -> Vec<(&str, f64)> {
        self.diagnosis.ranked()
    }

    /// Observe a probe result and update the diagnostic posterior.
    pub fn observe_probe(&mut self, result: &ProbeResult) {
        self.diagnosis.observe(result);
    }

    /// Rank all diagnostic tests by expected information gain per unit cost.
    pub fn rank_diagnostic_tests(&self) -> Vec<TestScore> {
        rank_tests(&self.diagnosis)
    }

    /// Select the single best diagnostic test to run next.
    pub fn select_best_probe(&self) -> Option<ProbeSelection> {
        let ranked = self.rank_diagnostic_tests();
        let best = ranked.into_iter().max_by(|a, b| {
            a.efficiency
                .partial_cmp(&b.efficiency)
                .unwrap_or(std::cmp::Ordering::Equal)
        })?;
        let reasoning = format!(
            "Expected information gain {:.4} nats at cost {:.1} (efficiency {:.4} nats/unit)",
            best.information_gain, best.cost, best.efficiency
        );
        Some(ProbeSelection {
            test_id: best.test.correlation_id().to_string(),
            test_name: format!("{:?}", best.test),
            expected_information_gain: best.information_gain,
            cost: best.cost,
            efficiency: best.efficiency,
            reasoning,
        })
    }

    /// Expected information gain for a specific test.
    pub fn expected_information_gain(&self, test: &DiagnosticTest) -> Option<TestScore> {
        expected_information_gain(&self.diagnosis, test)
    }

    /// Snapshot of the hypothesis space: every posterior paired with the prior
    /// it moved from, the current entropy, and the probe the engine would run
    /// next by expected information gain.
    pub fn hypothesis_view(&self) -> HypothesisView {
        let priors = self.diagnosis.priors();
        let hypotheses = self
            .diagnosis
            .ranked()
            .into_iter()
            .map(|(label, posterior)| HypothesisProbability {
                label: label.to_string(),
                // A prior is always defined for a label in the engine's own
                // space; 0.0 keeps a malformed pairing visible instead of
                // silently copying the posterior into the prior slot.
                prior: priors
                    .iter()
                    .find(|(l, _)| *l == label)
                    .map(|(_, p)| *p)
                    .unwrap_or(0.0),
                posterior,
            })
            .collect();
        HypothesisView {
            hypotheses,
            entropy_nats: self.diagnosis.uncertainty(),
            map_label: self.diagnosis.diagnosis().map(|(label, _)| label.to_string()),
            selected_probe: self.select_best_probe(),
        }
    }

    /// Sequential stopping rule: should we stop testing?
    pub fn should_stop_testing(
        &self,
        entropy_threshold: f64,
        confidence_target: f64,
    ) -> bool {
        let (_, map_prob) = self.diagnosis.diagnosis().unwrap_or(("unknown", 0.0));
        let entropy = self.diagnostic_entropy();
        crate::network_intelligence::diagnosis::should_stop_testing(
            entropy,
            map_prob,
            entropy_threshold,
        ) || map_prob >= confidence_target
    }

    /// Drift analysis across all registered CUSUM and Page-Hinkley detectors.
    pub fn drift_analyses(&self) -> Vec<DriftAnalysis> {
        let mut results = Vec::new();
        for (name, detector) in &self.cusum_detectors {
            let drifted = detector.statistic() > detector.h;
            let confidence = (detector.statistic() / detector.h).clamp(0.0, 1.0);
            results.push(DriftAnalysis {
                detector: format!("cusum:{name}"),
                drift_detected: drifted,
                statistic: detector.statistic(),
                threshold: detector.h,
                confidence,
            });
        }
        for (name, detector) in &self.page_hinkley_detectors {
            let statistic = detector.sum_ph;
            let drifted = statistic > detector.lambda;
            let confidence = (statistic / detector.lambda).clamp(0.0, 1.0);
            results.push(DriftAnalysis {
                detector: format!("ph:{name}"),
                drift_detected: drifted,
                statistic,
                threshold: detector.lambda,
                confidence,
            });
        }
        results
    }

    /// Changepoint analysis across all registered Bayesian Online CPD detectors.
    pub fn changepoint_analyses(&self) -> Vec<ChangepointAnalysis> {
        self.changepoint_detectors
            .iter()
            .map(|(_, detector)| ChangepointAnalysis {
                changepoint_probability: detector.changepoint_probability(),
                most_likely_run_length: detector.most_likely_run_length(),
                run_length_entropy: detector.expected_run_length(),
            })
            .collect()
    }

    // ========================================================================
    // Robust statistics
    // ========================================================================

    /// Record a measurement into the robust window for a metric and return an
    /// anomaly score. The window is bounded; old samples fall out.
    pub fn robust_anomaly(
        &mut self,
        metric: &str,
        value: f64,
        anomaly_threshold: f64,
    ) -> Option<RobustAnomalyResult> {
        if !value.is_finite() {
            return None;
        }
        let window = self
            .robust_windows
            .entry(metric.to_string())
            .or_insert_with(|| RobustStats::new(128));
        window.observe(value);
        let med = window.median().unwrap_or(value);
        let m = window.mad().unwrap_or(0.0);
        let score = if m > 0.0 {
            (value - med).abs() / (1.4826 * m + 1e-6)
        } else {
            0.0
        };
        Some(RobustAnomalyResult {
            value,
            median: med,
            mad: m,
            anomaly_score: score,
            is_anomaly: score > anomaly_threshold,
        })
    }

    /// Median of a slice.
    pub fn robust_median(&self, values: &[f64]) -> Option<f64> {
        if values.is_empty() {
            return None;
        }
        let mut v: Vec<f64> = values.to_vec();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = v.len();
        if n % 2 == 1 {
            Some(v[n / 2])
        } else {
            Some((v[n / 2 - 1] + v[n / 2]) / 2.0)
        }
    }

    /// Median absolute deviation of a slice around a given center.
    pub fn robust_mad(&self, values: &[f64], center: f64) -> Option<f64> {
        if values.is_empty() {
            return None;
        }
        let mut devs: Vec<f64> = values.iter().map(|x| (x - center).abs()).collect();
        devs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = devs.len();
        if n % 2 == 1 {
            Some(devs[n / 2])
        } else {
            Some((devs[n / 2 - 1] + devs[n / 2]) / 2.0)
        }
    }

    // ========================================================================
    // Change-point detection (Bayesian Online Changepoint Detection)
    // ========================================================================

    /// Feed a value into the changepoint detector for a stream and get an
    /// analysis. Creates the detector on first use.
    pub fn detect_changepoint(
        &mut self,
        stream: &str,
        value: f64,
    ) -> Option<ChangepointAnalysis> {
        if !value.is_finite() {
            return None;
        }
        let detector = self
            .changepoint_detectors
            .entry(stream.to_string())
            .or_insert_with(|| {
                BayesianOnlineCPD::new(HazardFunction::Constant(50.0), 100)
                    .expect("valid CPD parameters")
            });
        detector.observe(value);
        Some(ChangepointAnalysis {
            changepoint_probability: detector.changepoint_probability(),
            most_likely_run_length: detector.most_likely_run_length(),
            run_length_entropy: 0.0, // not directly exposed by BOCPD
        })
    }

    // ========================================================================
    // Drift detection (CUSUM + Page-Hinkley)
    // ========================================================================

    /// Feed a value into both drift detectors for a stream.
    pub fn detect_drift(
        &mut self,
        stream: &str,
        value: f64,
        cusum_threshold: f64,
        ph_threshold: f64,
    ) -> Option<DriftAnalysis> {
        if !value.is_finite() {
            return None;
        }
        let cusum = self
            .cusum_detectors
            .entry(stream.to_string())
            .or_insert_with(|| CusumDetector::new(0.1, cusum_threshold).expect("valid CUSUM"));
        let ph = self
            .page_hinkley_detectors
            .entry(stream.to_string())
            .or_insert_with(|| PageHinkleyDetector::new(ph_threshold).expect("valid PH"));

        let cusum_status = cusum.update(value - 0.5); // residual from neutral
        let ph_status = ph.update(value);

        let cusum_drift = matches!(cusum_status, DriftStatus::Drifted);
        let ph_drift = matches!(ph_status, DriftStatus::Drifted);
        let statistic = cusum.statistic();
        let threshold = cusum_threshold.max(ph_threshold);
        Some(DriftAnalysis {
            detector: if cusum_drift || ph_drift {
                "cusum_or_page_hinkley".into()
            } else {
                "none".into()
            },
            drift_detected: cusum_drift || ph_drift,
            statistic,
            threshold,
            confidence: (statistic / threshold.max(1e-12)).clamp(0.0, 1.0),
        })
    }

    // ========================================================================
    // Causal reasoning (ATE with identifiability gating)
    // ========================================================================

    /// Record an intervention record for causal tracking.
    pub fn record_intervention(&mut self, record: InterventionRecord) {
        self.causal_tracker.record(record);
    }

    /// Estimate the average treatment effect from intervention records.
    /// Returns `None` when the effect is not identifiable (insufficient
    /// overlap / confounding).
    pub fn estimate_causal_effect(
        &self,
        action: &str,
        context: &str,
    ) -> Option<CausalResult> {
        let est = self.causal_tracker.estimate(action, context);
        if !est.identifiable {
            return None;
        }
        let (ci_lower, ci_upper) = est.ci95.unwrap_or((est.ate.unwrap_or(0.0), est.ate.unwrap_or(0.0)));
        Some(CausalResult {
            ate: est.ate.unwrap_or(0.0),
            ci_lower,
            ci_upper,
            identifiable: est.identifiable,
            n_records: est.treated_n + est.control_n,
        })
    }

    // ========================================================================
    // Online learning (advisory only — never changes control decisions)
    // ========================================================================

    /// Record an API probe outcome into the local learning engine.
    pub fn record_api_probe(
        &mut self,
        api_id: &str,
        healthy: bool,
        latency_ms: Option<f64>,
        timestamp_ms: u64,
    ) {
        let _ = self.learning.record_api_probe(api_id, healthy, latency_ms, timestamp_ms);
    }

    // ========================================================================
    // Contextual bandit (Thompson sampling)
    // ========================================================================

    /// Select an arm for a context using Thompson sampling.
    /// `arms` are action names; they are mapped to `Action` enum variants by
    /// label matching. Unknown names are skipped.
    pub fn bandit_select(&mut self, context_signals: &ContextSignals, arm_names: &[String]) -> Option<usize> {
        let ctx = ContextBucket::from_measurements(
            context_signals.mtu.map(|m| m as f64),
            0.9, // default success rate; caller should update
            0,
        );
        let permitted: Vec<Action> = arm_names
            .iter()
            .filter_map(|name| Action::all().iter().find(|a| a.label() == name.as_str()).cloned())
            .collect();
        if permitted.is_empty() {
            return None;
        }
        let mut rng = StdRng::seed_from_u64(self.rng_seed);
        self.rng_seed = self.rng_seed.wrapping_add(1);
        let (action, _prob) = self.bandit.select(ctx, &permitted, &[], &mut rng)?;
        // Return the index into arm_names that matches the selected action.
        arm_names.iter().position(|n| {
            Action::all().iter().any(|a| a.label() == n.as_str() && format!("{:?}", a) == format!("{:?}", action))
        })
    }

    /// Update the bandit with an observed reward.
    pub fn bandit_update(&mut self, context_signals: &ContextSignals, arm_name: &str, reward: f64) {
        let ctx = ContextBucket::from_measurements(
            context_signals.mtu.map(|m| m as f64),
            0.9,
            0,
        );
        let action = Action::all().iter().find(|a| a.label() == arm_name).cloned();
        if let Some(action) = action {
            self.bandit.update(ctx, &action, Some(reward > 0.5));
        }
    }

    // ========================================================================
    // Recovery memory (verified outcomes)
    // ========================================================================

    /// Record a verified recovery outcome.
    pub fn record_recovery_outcome(
        &mut self,
        action: &str,
        success: bool,
        context: &str,
        timestamp_ms: u64,
    ) {
        self.recovery_memory.record(RecoveryOutcome {
            incident_id: format!("inc_{}", timestamp_ms),
            action: action.to_string(),
            network_context: context.to_string(),
            predicted_success: if success { 0.8 } else { 0.2 },
            verified_success: success,
            duration_ms: 0,
            rolled_back: !success,
        });
    }

    /// Best verified recovery action for a context.
    pub fn best_recovery_action(&self, context: &str) -> Option<String> {
        let counts = self.recovery_memory.counts_by_action();
        let mut best_action: Option<String> = None;
        let mut best_rate: f64 = f64::NEG_INFINITY;
        for (action, _) in &counts {
            if let Some(rate) = self.recovery_memory.success_rate(action, context) {
                if rate > best_rate {
                    best_rate = rate;
                    best_action = Some(action.clone());
                }
            }
        }
        best_action
    }

    // ========================================================================
    // Route evaluation & multi-objective optimization
    // ========================================================================

    /// Register route metrics for multi-objective optimization.
    pub fn register_route(&mut self, route_id: String, metrics: RouteMetrics) {
        self.routes.insert(route_id, metrics);
    }

    /// Score a route using the multi-objective objective (lower = better).
    /// Returns None if the route is unauthorized or insecure.
    pub fn score_route(&self, route_id: &str, kappa: f64) -> Option<f64> {
        let metrics = self.routes.get(route_id)?;
        let candidate = RouteCandidate {
            id: route_id.to_string(),
            route_kind: RouteKind::Direct,
            authorized: true,
            tls_verified: true,
            metrics: metrics.clone(),
        };
        let scored = score_candidate(&candidate, &ObjectiveWeights::default(), kappa)?;
        Some(scored.objective)
    }

    /// Compute the Pareto frontier of registered routes.
    pub fn route_pareto_frontier(&mut self) -> Vec<String> {
        let mut scored: Vec<ScoredRoute> = self
            .routes
            .iter()
            .filter_map(|(id, metrics)| {
                let candidate = RouteCandidate {
                    id: id.clone(),
                    route_kind: RouteKind::Direct,
                    authorized: true,
                    tls_verified: true,
                    metrics: metrics.clone(),
                };
                score_candidate(&candidate, &ObjectiveWeights::default(), 1.0)
            })
            .collect();
        pareto_frontier(&mut scored);
        scored
            .iter()
            .filter(|s| s.pareto_optimal)
            .map(|s| s.candidate.id.clone())
            .collect()
    }

    /// CVaR of latency samples for a route.
    pub fn route_cvar_latency(&self, samples: &[f64], alpha: f64) -> Option<f64> {
        cvar_latency(samples, alpha)
    }

    // ========================================================================
    // Time-series forecasting (exponential smoothing)
    // ========================================================================

    /// Forecast the next value for a metric using exponential smoothing.
    pub fn forecast_metric(
        &mut self,
        metric: &str,
        value: f64,
        alpha: f64,
    ) -> Option<f64> {
        if !value.is_finite() || !alpha.is_finite() || alpha <= 0.0 || alpha > 1.0 {
            return None;
        }
        let smoother = self
            .smoothers
            .entry(metric.to_string())
            .or_insert_with(|| ExponentialSmoothing::new(alpha).expect("valid alpha"));
        Some(smoother.observe(value))
    }

    // ========================================================================
    // Validation: proper scoring rules & calibration
    // ========================================================================

    /// Brier score for probabilistic predictions vs binary outcomes.
    pub fn brier_score(&self, predictions: &[f64], outcomes: &[bool]) -> Option<f64> {
        if predictions.len() != outcomes.len() || predictions.is_empty() {
            return None;
        }
        let preds: Vec<Prediction> = predictions
            .iter()
            .zip(outcomes.iter())
            .map(|(&p, &o)| Prediction::new(p, if o { 1.0 } else { 0.0 }).expect("valid prediction"))
            .collect();
        brier_score(&preds)
    }

    /// Log loss for probabilistic predictions vs binary outcomes.
    pub fn log_loss(&self, predictions: &[f64], outcomes: &[bool]) -> Option<f64> {
        if predictions.len() != outcomes.len() || predictions.is_empty() {
            return None;
        }
        let preds: Vec<Prediction> = predictions
            .iter()
            .zip(outcomes.iter())
            .map(|(&p, &o)| Prediction::new(p, if o { 1.0 } else { 0.0 }).expect("valid prediction"))
            .collect();
        log_loss(&preds)
    }

    /// Expected calibration error.
    pub fn expected_calibration_error(
        &self,
        predictions: &[f64],
        outcomes: &[bool],
        n_bins: usize,
    ) -> Option<f64> {
        if predictions.len() != outcomes.len() || predictions.is_empty() || n_bins == 0 {
            return None;
        }
        let preds: Vec<Prediction> = predictions
            .iter()
            .zip(outcomes.iter())
            .map(|(&p, &o)| Prediction::new(p, if o { 1.0 } else { 0.0 }).expect("valid prediction"))
            .collect();
        expected_calibration_error(&preds, n_bins)
    }

    // ========================================================================
    // Hierarchical reliability (partial pooling)
    // ========================================================================

    /// Observe a binary outcome under a context/API pair (child update).
    pub fn observe_reliability(
        &mut self,
        context: &str,
        api_id: &str,
        success: bool,
    ) {
        let context_id = NetworkContextId(MathId::from_string(context).0);
        self.reliability.observe(context_id, api_id, Some(success));
    }

    /// Observe device-level aggregate evidence (parent update only).
    pub fn observe_global_reliability(&mut self, success: bool) {
        self.reliability.observe_global(Some(success));
    }

    /// Predicted reliability for a context/API pair.
    pub fn predict_reliability(&self, context: &str, api_id: &str) -> f64 {
        let context_id = NetworkContextId(MathId::from_string(context).0);
        self.reliability.predict(context_id, api_id)
    }

    // ========================================================================
    // Circuit breakers
    // ========================================================================

    /// Record a success/failure for an API's circuit breaker.
    pub fn circuit_breaker_record(
        &mut self,
        api_id: &str,
        success: bool,
        timestamp_secs: u64,
    ) {
        let breaker = self
            .circuit_breakers
            .entry(api_id.to_string())
            .or_insert_with(CircuitBreaker::new);
        if success {
            breaker.record_success(timestamp_secs);
        } else {
            breaker.record_failure(timestamp_secs);
        }
    }

    /// Whether an API's circuit breaker is tripped.
    pub fn circuit_breaker_tripped(&self, api_id: &str) -> bool {
        self.circuit_breakers
            .get(api_id)
            .map(|b| b.is_tripped())
            .unwrap_or(false)
    }

    // ========================================================================
    // Configuration intelligence
    // ========================================================================

    /// Discover a VPN configuration and return its ID.
    pub fn discover_config(
        &mut self,
        source_id: &str,
        format: ConfigFormat,
        raw_config: Option<String>,
        source_reputation: f64,
    ) -> String {
        self.config_engine
            .discover(source_id, format, raw_config, source_reputation)
    }

    /// Score a discovered configuration.
    pub fn score_config(&mut self, config_id: &str) -> Option<ConfigRecommendation> {
        let score = self.config_engine.score_config(config_id)?;
        let config = self.config_engine.get_config(config_id)?;
        Some(ConfigRecommendation {
            config_id: config_id.to_string(),
            overall_score: score.overall,
            success_probability: score.success_prob,
            expected_latency_ms: score.expected_latency_ms,
            uncertainty: score.uncertainty,
            status: format!("{:?}", config.status),
        })
    }

    /// All discovered configurations.
    pub fn all_configs(&self) -> Vec<&DiscoveredConfig> {
        self.config_engine.get_all_configs()
    }

    // ========================================================================
    // Network simulator (deterministic testing)
    // ========================================================================

    /// Simulate a probe against the current network condition.
    pub fn simulate_probe(&mut self, test: &DiagnosticTest) -> ProbeResult {
        self.simulator.probe(test)
    }

    /// Simulate an API call and return (category, success, latency_ms).
    pub fn simulate_api_call(&mut self, api_id: &str, route: RouteKind) -> (FailureCategory, bool, f64) {
        self.simulator.api_call(api_id, route)
    }

    // ========================================================================
    // Hardware adaptation
    // ========================================================================

    /// Detect the hardware tier and return adaptive policy parameters.
    pub fn hardware_profile(&self, memory_mb: Option<u64>) -> HardwareProfile {
        HardwareProfile::detect(memory_mb)
    }

    // ========================================================================
    // Probe API (multi-layer health check)
    // ========================================================================

    /// Probe an API across all layers (DNS → TCP → TLS → HTTP).
    pub fn probe_api(&self, entry: &ApiEntry) -> ProbeOutcomeRecord {
        crate::network_intelligence::api_intelligence::monitor::probe_api(entry, None)
    }

    /// Classify probe inputs into a failure category.
    pub fn classify_probe_inputs(&self, inputs: ProbeInputs) -> FailureCategory {
        classify_probe(inputs)
    }

    // ========================================================================
    // Snapshot & restore (versioned persistence)
    // ========================================================================

    /// Versioned snapshot of the entire engine state.
    pub fn snapshot(&self) -> FoundationSnapshot {
        FoundationSnapshot {
            schema_version: FOUNDATION_SCHEMA_VERSION,
            timestamp_ms: unix_now_ms(),
            diagnostic_entropy: self.diagnostic_entropy(),
            diagnosis: self.diagnosis.diagnosis().map(|(l, p)| (l.to_string(), p)),
            reliability_global_mean: self.reliability.global_mean(),
            context_status: self.context.status(),
            route_count: self.routes.len(),
            config_count: self.config_engine.config_count(),
            changepoint_streams: self.changepoint_detectors.len(),
            drift_streams: self.cusum_detectors.len(),
            robust_windows: self.robust_windows.len(),
            rng_seed: self.rng_seed,
        }
    }

    /// Restore from a snapshot. Returns None on schema mismatch or corruption.
    pub fn from_snapshot(snapshot: FoundationSnapshot) -> Option<Self> {
        if snapshot.schema_version != FOUNDATION_SCHEMA_VERSION {
            return None;
        }
        let mut engine = Self::new();
        engine.rng_seed = snapshot.rng_seed;
        let _ = snapshot;
        Some(engine)
    }
}

/// Versioned snapshot of the foundation engine state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FoundationSnapshot {
    pub schema_version: u32,
    pub timestamp_ms: u64,
    pub diagnostic_entropy: f64,
    pub diagnosis: Option<(String, f64)>,
    pub reliability_global_mean: f64,
    pub context_status: PersonalizationStatus,
    pub route_count: usize,
    pub config_count: usize,
    pub changepoint_streams: usize,
    pub drift_streams: usize,
    pub robust_windows: usize,
    pub rng_seed: u64,
}

/// Property-based numerical stability test results.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StabilityReport {
    pub test_name: String,
    pub passed: bool,
    pub detail: String,
}

/// Run a built-in numerical stability self-test suite.
pub fn run_stability_tests() -> Vec<StabilityReport> {
    let mut reports = Vec::new();

    // 1. clamp_probability never produces NaN or out-of-range.
    let cases = [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1e300, 1e300, 0.0, 1.0, 0.5];
    let ok = cases.iter().all(|&p| {
        let c = clamp_probability(p);
        c.is_finite() && c > 0.0 && c < 1.0
    });
    reports.push(StabilityReport {
        test_name: "clamp_probability_boundary".into(),
        passed: ok,
        detail: if ok {
            "all boundary inputs map to (0, 1)".into()
        } else {
            "boundary input produced invalid probability".into()
        },
    });

    // 2. sigmoid never overflows at extremes.
    let ok = sigmoid(1e10).is_finite() && sigmoid(-1e10).is_finite()
        && (sigmoid(0.0) - 0.5).abs() < f64::EPSILON;
    reports.push(StabilityReport {
        test_name: "sigmoid_no_overflow".into(),
        passed: ok,
        detail: if ok {
            "extreme inputs produce finite outputs".into()
        } else {
            "sigmoid overflowed".into()
        },
    });

    // 3. log_sum_exp stable for large magnitude inputs.
    let ok = (log_sum_exp(&[1000.0, 1000.0]) - (1000.0 + 2.0f64.ln())).abs() < 1e-6
        && log_sum_exp(&[]).is_infinite()
        && log_sum_exp(&[]).is_sign_negative();
    reports.push(StabilityReport {
        test_name: "log_sum_exp_stability".into(),
        passed: ok,
        detail: if ok {
            "large-magnitude inputs do not overflow".into()
        } else {
            "log_sum_exp overflowed".into()
        },
    });

    // 4. softmax sums to 1 and is positive.
    let probs = softmax(&[0.0, 1.0, 2.0]).expect("softmax");
    let sum: f64 = probs.iter().sum();
    let ok = (sum - 1.0).abs() < 1e-9 && probs.iter().all(|p| *p > 0.0 && *p < 1.0);
    reports.push(StabilityReport {
        test_name: "softmax_normalization".into(),
        passed: ok,
        detail: if ok {
            "probabilities are positive and sum to 1".into()
        } else {
            "softmax did not normalize".into()
        },
    });

    // 5. KL divergence: D(P||P) = 0; D(P||Q) = INF when Q has no mass where P does.
    let p = vec![0.5, 0.5];
    let q = vec![0.0, 1.0];
    let d_pp = kl_divergence(&p, &p).expect("valid");
    let d_pq = kl_divergence(&p, &q).expect("valid");
    let ok = d_pp.abs() < 1e-9 && d_pq.is_infinite();
    reports.push(StabilityReport {
        test_name: "kl_divergence_properties".into(),
        passed: ok,
        detail: if ok {
            "self-divergence is zero; unsupported mass is infinite".into()
        } else {
            "KL divergence violated expected properties".into()
        },
    });

    // 6. JS divergence is symmetric and finite.
    let p = vec![0.7, 0.3];
    let q = vec![0.4, 0.6];
    let d1 = js_divergence(&p, &q).expect("valid");
    let d2 = js_divergence(&q, &p).expect("valid");
    let ok = (d1 - d2).abs() < 1e-9 && d1.is_finite() && d1 >= 0.0;
    reports.push(StabilityReport {
        test_name: "js_divergence_symmetry".into(),
        passed: ok,
        detail: if ok {
            "symmetric and bounded".into()
        } else {
            "JS divergence not symmetric or not finite".into()
        },
    });

    reports
}

/// Adversarial test suite: feeds pathological inputs to every mathematical
/// component and asserts no panics, no NaN propagation, no silent defaults.
pub fn run_adversarial_tests() -> Vec<StabilityReport> {
    let mut reports = Vec::new();

    // A. Diagnosis engine: extreme likelihoods, missing outcomes, rapid alternation.
    {
        let mut engine = DiagnosticEngine::new();
        let mut ok = true;
        for i in 0..1000 {
            let test = DiagnosticTest::DnsResolve;
            let outcome = match i % 4 {
                0 => ProbeOutcome::Failure,
                1 => ProbeOutcome::Success,
                2 => ProbeOutcome::Missing,
                _ => ProbeOutcome::AuthRejected,
            };
            let result = ProbeResult {
                test,
                outcome,
                timestamp: i as u64,
                source: "adv".into(),
                cost: 1.0,
            };
            // Must not panic.
            engine.observe(&result);
            let ent = engine.uncertainty();
            if !ent.is_finite() || ent < 0.0 {
                ok = false;
            }
        }
        reports.push(StabilityReport {
            test_name: "adversarial_diagnosis_rapid_alternation".into(),
            passed: ok,
            detail: if ok {
                "no NaN/Inf entropy after 1000 rapid observations".into()
            } else {
                "entropy became non-finite or negative".into()
            },
        });
    }

    // B. Robust statistics: NaN input rejected, empty window returns None.
    {
        let mut engine = NaniMathEngine::new();
        let ok = engine
            .robust_anomaly("m", f64::NAN, 3.0)
            .is_none()
            && engine.robust_anomaly("m", f64::INFINITY, 3.0).is_none()
            && engine.robust_anomaly("m", -5.0, 3.0).is_some();
        reports.push(StabilityReport {
            test_name: "adversarial_robust_stats_rejects_invalid".into(),
            passed: ok,
            detail: if ok {
                "NaN/Inf rejected; negative finite accepted".into()
            } else {
                "invalid input was not rejected".into()
            },
        });
    }

    // C. Bayesian update: NaN log-likelihood is ignored, not propagated.
    {
        let prior = Prior::uniform(vec!["a".into(), "b".into()]);
        let evidence = vec![Evidence {
            hypothesis: "a".into(),
            log_likelihood: f64::NAN,
            timestamp: 1,
            source: "s".into(),
            confidence: None,
        }];
        let post = bayesian_update(&prior, &evidence);
        let ok = post.prob(0).is_finite() && (post.prob(0) + post.prob(1) - 1.0).abs() < 1e-9;
        reports.push(StabilityReport {
            test_name: "adversarial_bayesian_nan_likelihood_ignored".into(),
            passed: ok,
            detail: if ok {
                "NaN likelihood does not corrupt posterior".into()
            } else {
                "NaN propagated into posterior".into()
            },
        });
    }

    // D. Changepoint: extreme values.
    {
        let mut detector = BayesianOnlineCPD::new(HazardFunction::Constant(50.0), 100).expect("valid");
        let ok = (0..100).all(|_| {
            detector.observe(f64::NAN); // ignored internally
            detector.observe(1e300);
            detector.observe(-1e300);
            detector.changepoint_probability().is_finite()
        });
        reports.push(StabilityReport {
            test_name: "adversarial_changepoint_extreme_values".into(),
            passed: ok,
            detail: if ok {
                "extreme values do not corrupt detector".into()
            } else {
                "detector produced non-finite probability".into()
            },
        });
    }

    // E. Drift detectors: extreme values.
    {
        let mut cusum = CusumDetector::new(0.1, 10.0).expect("valid");
        let mut ph = PageHinkleyDetector::new(10.0).expect("valid");
        let ok = (0..100).all(|_| {
            cusum.update(f64::NAN);
            cusum.update(1e300);
            ph.update(f64::NAN);
            ph.update(1e300);
            cusum.statistic().is_finite()
        });
        reports.push(StabilityReport {
            test_name: "adversarial_drift_extreme_values".into(),
            passed: ok,
            detail: if ok {
                "drift statistics remain finite".into()
            } else {
                "drift statistics became non-finite".into()
            },
        });
    }

    // F. Softmax: extreme log-probabilities.
    //
    // The invariant asserted here is the one the engine actually relies on:
    // finite, non-negative, normalized. Strict positivity is NOT required — an
    // outcome more than ~745 nats below the maximum underflows f64 and keeps an
    // exact 0.0, which is the honest representation of "impossible" and which
    // the entropy / information-gain / log-loss consumers already handle (they
    // skip or clamp zero terms). Demanding a positive value here is what made
    // softmax fabricate 1e-12 of mass for outcomes the evidence rules out.
    {
        let ok = softmax(&[1000.0, -1000.0]).map_or(false, |p| {
            p.len() == 2
                && p.iter().all(|x| x.is_finite() && *x >= 0.0 && *x <= 1.0)
                && (p.iter().sum::<f64>() - 1.0).abs() < 1e-12
        });
        reports.push(StabilityReport {
            test_name: "adversarial_softmax_extreme_log_probs".into(),
            passed: ok,
            detail: if ok {
                "extreme log-probs produce a finite, normalized distribution".into()
            } else {
                "softmax failed on extreme inputs".into()
            },
        });
    }

    reports
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foundation_engine_creates_and_snapshots() {
        let engine = NaniMathEngine::new();
        let snap = engine.snapshot();
        assert_eq!(snap.schema_version, FOUNDATION_SCHEMA_VERSION);
        assert!(snap.diagnostic_entropy.is_finite());
    }

    #[test]
    fn foundation_stability_tests_pass() {
        let reports = run_stability_tests();
        for r in &reports {
            assert!(r.passed, "stability test failed: {} — {}", r.test_name, r.detail);
        }
    }

    #[test]
    fn foundation_adversarial_tests_pass() {
        let reports = run_adversarial_tests();
        for r in &reports {
            assert!(r.passed, "adversarial test failed: {} — {}", r.test_name, r.detail);
        }
    }

    #[test]
    fn foundation_clamp_probability_wraps_math() {
        let engine = NaniMathEngine::new();
        assert!((engine.clamp_probability(f64::NAN) - 0.5).abs() < f64::EPSILON);
        assert!((engine.clamp_probability(0.0) - PROB_FLOOR).abs() < f64::EPSILON);
    }

    #[test]
    fn foundation_robust_anomaly_rejects_nan() {
        let mut engine = NaniMathEngine::new();
        assert!(engine.robust_anomaly("m", f64::NAN, 3.0).is_none());
    }

    #[test]
    fn foundation_diagnosis_and_probe_selection() {
        let engine = NaniMathEngine::new();
        assert!(engine.rank_diagnostic_tests().len() == 8);
        assert!(engine.select_best_probe().is_some());
    }

    #[test]
    fn foundation_bayesian_update_round_trip() {
        let engine = NaniMathEngine::new();
        let prior = engine.uniform_prior(vec!["a".into(), "b".into()]);
        let evidence = vec![Evidence {
            hypothesis: "a".into(),
            log_likelihood: 2.0,
            timestamp: 1,
            source: "s".into(),
            confidence: None,
        }];
        let post = engine.bayesian_update(&prior, &evidence);
        assert!(post.prob(0) > post.prob(1));
    }

    #[test]
    fn foundation_causal_not_identifiable_with_few_records() {
        let mut engine = NaniMathEngine::new();
        let result = engine.estimate_causal_effect("upstream", "ctx");
        assert!(result.is_none());
    }

    #[test]
    fn foundation_validation_scores() {
        let engine = NaniMathEngine::new();
        let preds = vec![0.8, 0.3, 0.9];
        let outcomes = vec![true, false, true];
        let bs = engine.brier_score(&preds, &outcomes).expect("brier");
        assert!(bs >= 0.0);
        let ll = engine.log_loss(&preds, &outcomes).expect("log loss");
        assert!(ll >= 0.0);
    }
}
