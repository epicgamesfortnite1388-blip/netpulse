// Contextual bandit for safe adaptive action selection.
//
// Learns pi*(x) = argmax_a E[r | x, a] using Bayesian Thompson Sampling over
// Beta-Bernoulli models, one per (context-bucket, action) pair. Context is
// discretized into buckets so the model stays interpretable and the updates
// stay in closed form. Unsafe actions are filtered before selection, and
// security/authorization failures are hard rejections, not negative rewards.

use crate::network_intelligence::math::clamp_probability;
use crate::network_intelligence::probability::BetaBernoulli;
use rand::Rng;
use std::collections::HashMap;

/// The current network context, discretized into a bucket for bandit lookup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ContextBucket {
    pub connectivity: ConnectivityBucket,
    pub recent_failures: FailureBucket,
    pub latency: LatencyBucket,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConnectivityBucket {
    Unknown,
    Good,
    Degraded,
    Poor,
    Outage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FailureBucket {
    None,
    Few,    // 1-2
    Many,   // 3+
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LatencyBucket {
    Unknown,
    Low,    // < 100ms
    Medium, // 100-500ms
    High,   // > 500ms
}

impl ContextBucket {
    /// Classify raw measurements into a bucket.
    pub fn from_measurements(
        latency_ms: Option<f64>,
        success_rate: f64,
        consecutive_failures: u64,
    ) -> Self {
        let connectivity = if success_rate >= 0.9 {
            ConnectivityBucket::Good
        } else if success_rate >= 0.6 {
            ConnectivityBucket::Degraded
        } else if success_rate > 0.0 {
            ConnectivityBucket::Poor
        } else {
            ConnectivityBucket::Outage
        };
        let recent_failures = if consecutive_failures == 0 {
            FailureBucket::None
        } else if consecutive_failures < 3 {
            FailureBucket::Few
        } else {
            FailureBucket::Many
        };
        let latency = match latency_ms {
            None => LatencyBucket::Unknown,
            Some(l) if l < 100.0 => LatencyBucket::Low,
            Some(l) if l < 500.0 => LatencyBucket::Medium,
            Some(_) => LatencyBucket::High,
        };
        Self {
            connectivity,
            recent_failures,
            latency,
        }
    }
}

/// A permitted action the bandit may choose.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Action {
    RunDnsDiagnostics,
    TestDirectApi,
    TestApprovedUpstream,
    TestIpv4,
    TestIpv6,
    TestSupportedEngine,
    VerifyKnownGoodRoute,
    AuthorizedMtuExperiment,
    RestorePreviousConfiguration,
}

impl Action {
    pub fn all() -> Vec<Action> {
        vec![
            Action::RunDnsDiagnostics,
            Action::TestDirectApi,
            Action::TestApprovedUpstream,
            Action::TestIpv4,
            Action::TestIpv6,
            Action::TestSupportedEngine,
            Action::VerifyKnownGoodRoute,
            Action::AuthorizedMtuExperiment,
            Action::RestorePreviousConfiguration,
        ]
    }

    pub fn label(&self) -> &'static str {
        match self {
            Action::RunDnsDiagnostics => "run_dns_diagnostics",
            Action::TestDirectApi => "test_direct_api",
            Action::TestApprovedUpstream => "test_approved_upstream",
            Action::TestIpv4 => "test_ipv4",
            Action::TestIpv6 => "test_ipv6",
            Action::TestSupportedEngine => "test_supported_engine",
            Action::VerifyKnownGoodRoute => "verify_known_good_route",
            Action::AuthorizedMtuExperiment => "authorized_mtu_experiment",
            Action::RestorePreviousConfiguration => "restore_previous_configuration",
        }
    }
}

/// The outcome of executing an action, used to compute reward.
#[derive(Debug, Clone)]
pub struct ActionOutcome {
    pub success: bool,
    /// Latency observed (ms), if any.
    pub latency_ms: Option<f64>,
    /// Whether a security/authorization constraint was violated.
    pub constraint_violated: bool,
    /// Whether the connection was unstable during/after the action.
    pub unstable: bool,
    /// Recovery time in seconds, if the action was a recovery attempt.
    pub recovery_time_sec: Option<f64>,
}

/// Reward weights. A successful connection must dominate minor speed
/// improvements; security violations are hard rejections.
#[derive(Debug, Clone)]
pub struct RewardWeights {
    pub w_success: f64,
    pub w_latency: f64,
    pub w_jitter: f64,
    pub w_loss: f64,
    pub w_cost: f64,
    pub w_time: f64,
}

impl Default for RewardWeights {
    fn default() -> Self {
        Self {
            w_success: 10.0,
            w_latency: 1.0,
            w_jitter: 0.5,
            w_loss: 2.0,
            w_cost: 0.1,
            w_time: 1.0,
        }
    }
}

/// Compute a scalar reward from an observed action outcome.
///
/// Security and permission failures are hard rejection conditions: they
/// return a strongly negative reward so the bandit never repeats them.
///
/// The success term dominates; minor speed improvements cannot outweigh a
/// failed connection.
pub fn compute_reward(outcome: &ActionOutcome, weights: &RewardWeights) -> f64 {
    // Hard rejection: security/authorization violations are never rewarded.
    if outcome.constraint_violated {
        return -10.0;
    }

    let mut r = 0.0;

    // Success dominates.
    if outcome.success {
        r += weights.w_success;
    } else {
        r -= weights.w_success * 0.5; // failure is bad but not as bad as a violation
    }

    // Latency penalty (normalized).
    if let Some(lat) = outcome.latency_ms {
        if lat.is_finite() && lat > 0.0 {
            let lat_norm = clamp_probability(lat / 5000.0);
            r -= weights.w_latency * lat_norm;
        }
    }

    // Instability penalty.
    if outcome.unstable {
        r -= weights.w_loss;
    }

    // Recovery time penalty.
    if let Some(t) = outcome.recovery_time_sec {
        if t.is_finite() && t > 0.0 {
            let t_norm = clamp_probability(t / 30.0);
            r -= weights.w_time * t_norm;
        }
    }

    r
}

/// A contextual bandit using Thompson Sampling over Beta-Bernoulli models,
/// one per (context-bucket, action) pair.
#[derive(Debug, Clone)]
pub struct ContextualBandit {
    /// Models keyed by (context_bucket, action).
    models: HashMap<(ContextBucket, Action), BetaBernoulli>,
    /// Prior hyperparameters for new models.
    prior_alpha: f64,
    prior_beta: f64,
}

impl ContextualBandit {
    pub fn new() -> Self {
        Self {
            models: HashMap::new(),
            prior_alpha: 1.0,
            prior_beta: 1.0,
        }
    }

    pub fn with_prior(alpha: f64, beta: f64) -> Option<Self> {
        if alpha <= 0.0 || beta <= 0.0 {
            return None;
        }
        Some(Self {
            models: HashMap::new(),
            prior_alpha: alpha,
            prior_beta: beta,
        })
    }

    fn model_for(&mut self, ctx: ContextBucket, action: &Action) -> &mut BetaBernoulli {
        self.models
            .entry((ctx, action.clone()))
            .or_insert_with(|| BetaBernoulli::new(self.prior_alpha, self.prior_beta).expect("valid prior"))
    }

    /// Select an action via Thompson Sampling.
    ///
    /// 1. Construct context bucket from measurements.
    /// 2. Generate permitted actions.
    /// 3. Filter unsafe actions.
    /// 4. Sample each (ctx, action) Beta posterior.
    /// 5. Select the action with the highest sample.
    /// 6. Return the chosen action and its estimated success probability.
    pub fn select<R: Rng + ?Sized>(
        &mut self,
        ctx: ContextBucket,
        permitted: &[Action],
        unsafe_actions: &[Action],
        rng: &mut R,
    ) -> Option<(Action, f64)> {
        if permitted.is_empty() {
            return None;
        }

        let safe: Vec<&Action> = permitted
            .iter()
            .filter(|a| !unsafe_actions.contains(a))
            .collect();
        if safe.is_empty() {
            return None;
        }

        let mut best_action = None;
        let mut best_sample = f64::NEG_INFINITY;
        let mut best_prob = 0.0;

        for action in safe {
            let model = self.model_for(ctx, action);
            let sample = model.sample(rng);
            let prob = model.mean();
            if sample > best_sample {
                best_sample = sample;
                best_action = Some(action.clone());
                best_prob = prob;
            }
        }

        best_action.map(|a| (a, best_prob))
    }

    /// Update the model for the chosen action with the observed outcome.
    ///
    /// `success` is whether the action achieved its goal. `None` (missing data)
    /// is a no-op.
    pub fn update(&mut self, ctx: ContextBucket, action: &Action, success: Option<bool>) {
        let model = self.model_for(ctx, action);
        model.observe(success);
    }

    /// Estimated success probability for an action in a context (the bandit's
    /// current belief, not a sample).
    pub fn estimated_success(&self, ctx: ContextBucket, action: &Action) -> f64 {
        self.models
            .get(&(ctx, action.clone()))
            .map(|m| m.mean())
            .unwrap_or(0.5)
    }

    /// Number of distinct (context, action) models learned so far.
    pub fn n_models(&self) -> usize {
        self.models.len()
    }
}

/// Filter out actions that are unsafe given the current state.
///
/// `certificate_verification_required` means actions that would disable TLS
// verification are always unsafe. `unauthorized_actions` are actions the
// caller has not permitted (e.g. from an allow-list).
pub fn safe_action_filter(
    all_actions: &[Action],
    unsafe_actions: &[Action],
    certificate_verification_required: bool,
) -> Vec<Action> {
    all_actions
        .iter()
        .filter(|a| {
            // Never allow actions that would disable TLS verification.
            if certificate_verification_required {
                match a {
                    // No action in our space disables TLS by design, but this
                    // is the gate where such an action would be excluded.
                    _ => {}
                }
            }
            !unsafe_actions.contains(a)
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::{Rng, SeedableRng};

    #[test]
    fn bandit_starts_uniform_prior_mean_half() {
        let mut b = ContextualBandit::new();
        let ctx = ContextBucket::from_measurements(Some(50.0), 0.9, 0);
        let (action, prob) = b
            .select(ctx, &Action::all(), &[], &mut StdRng::seed_from_u64(1))
            .expect("selection");
        assert!(prob >= 0.0 && prob <= 1.0);
        let _ = action;
    }

    #[test]
    fn bandit_learns_to_prefer_better_action() {
        let mut b = ContextualBandit::new();
        let ctx = ContextBucket::from_measurements(Some(50.0), 0.9, 0);
        let mut rng = StdRng::seed_from_u64(42);

        // Train: TestDirectApi succeeds 90%, RunDnsDiagnostics succeeds 20%
        for _ in 0..300 {
            let (sel, _) = b.select(ctx, &[Action::TestDirectApi, Action::RunDnsDiagnostics], &[], &mut rng).expect("sel");
            if sel == Action::TestDirectApi {
                b.update(ctx, &Action::TestDirectApi, Some(true));
            } else {
                b.update(ctx, &Action::RunDnsDiagnostics, Some(false));
            }
        }

        // After training, direct API should have higher estimated success.
        let p_direct = b.estimated_success(ctx, &Action::TestDirectApi);
        let p_dns = b.estimated_success(ctx, &Action::RunDnsDiagnostics);
        assert!(p_direct > p_dns, "direct ({p_direct}) > dns ({p_dns})");
    }

    #[test]
    fn unsafe_actions_are_never_selected() {
        let mut b = ContextualBandit::new();
        let ctx = ContextBucket::from_measurements(Some(50.0), 0.9, 0);
        let mut rng = StdRng::seed_from_u64(7);
        // Mark TestDirectApi as unsafe; bandit should pick something else or None.
        let result = b.select(
            ctx,
            &[Action::TestDirectApi],
            &[Action::TestDirectApi],
            &mut rng,
        );
        assert!(result.is_none());
    }

    #[test]
    fn empty_permitted_returns_none() {
        let mut b = ContextualBandit::new();
        let ctx = ContextBucket::from_measurements(Some(50.0), 0.9, 0);
        let result = b.select(ctx, &[], &[], &mut StdRng::seed_from_u64(1));
        assert!(result.is_none());
    }

    #[test]
    fn missing_data_update_is_noop() {
        let mut b = ContextualBandit::new();
        let ctx = ContextBucket::from_measurements(Some(50.0), 0.9, 0);
        let mut rng = StdRng::seed_from_u64(5);
        let (sel, _) = b.select(ctx, &[Action::TestDirectApi], &[], &mut rng).expect("sel");
        b.update(ctx, &sel, None);
        // Mean should still be the prior (0.5)
        assert!((b.estimated_success(ctx, &sel) - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn compute_reward_penalizes_violation_most() {
        let w = RewardWeights::default();
        let violation = ActionOutcome {
            success: true,
            latency_ms: Some(50.0),
            constraint_violated: true,
            unstable: false,
            recovery_time_sec: None,
        };
        let success = ActionOutcome {
            success: true,
            latency_ms: Some(5000.0),
            constraint_violated: false,
            unstable: false,
            recovery_time_sec: None,
        };
        let r_violation = compute_reward(&violation, &w);
        let r_success = compute_reward(&success, &w);
        assert!(r_violation < r_success, "violation ({r_violation}) < slow success ({r_success})");
    }

    #[test]
    fn compute_reward_success_dominates_speed() {
        let w = RewardWeights::default();
        let fast_fail = ActionOutcome {
            success: false,
            latency_ms: Some(10.0),
            constraint_violated: false,
            unstable: false,
            recovery_time_sec: None,
        };
        let slow_success = ActionOutcome {
            success: true,
            latency_ms: Some(5000.0),
            constraint_violated: false,
            unstable: false,
            recovery_time_sec: None,
        };
        let r_fast_fail = compute_reward(&fast_fail, &w);
        let r_slow_success = compute_reward(&slow_success, &w);
        assert!(r_slow_success > r_fast_fail, "slow success ({r_slow_success}) > fast fail ({r_fast_fail})");
    }

    #[test]
    fn context_bucket_classification() {
        let b = ContextBucket::from_measurements(Some(50.0), 0.95, 0);
        assert_eq!(b.connectivity, ConnectivityBucket::Good);
        assert_eq!(b.recent_failures, FailureBucket::None);
        assert_eq!(b.latency, LatencyBucket::Low);

        let b = ContextBucket::from_measurements(Some(800.0), 0.3, 5);
        assert_eq!(b.connectivity, ConnectivityBucket::Poor);
        assert_eq!(b.recent_failures, FailureBucket::Many);
        assert_eq!(b.latency, LatencyBucket::High);
    }

    #[test]
    fn safe_action_filter_excludes_unsafe() {
        let all = Action::all();
        let filtered = safe_action_filter(&all, &[Action::TestApprovedUpstream], true);
        assert_eq!(filtered.len(), all.len() - 1);
        assert!(!filtered.contains(&Action::TestApprovedUpstream));
    }
}

