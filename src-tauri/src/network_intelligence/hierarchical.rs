//! NANI Phase 4 — Hierarchical Bayesian learning.
//!
//! Implements partial pooling across the hierarchy:
//!   GLOBAL prior → NETWORK CONTEXT → API/endpoint → individual observation.
//!
//! The global model is learned only from evidence explicitly routed to it
//! (`observe_global`). Local observations update only their own (context, API)
//! model. This is deliberate: feeding child observations back into the parent
//! and then using that parent as the child's prior would count the same
//! evidence twice and make sparse profiles look more certain than they are.
//!
//! A local model is initialized from the *current* global posterior mean with
//! prior strength `kappa`:
//!
//!   local prior = Beta(global_mean · kappa, (1 - global_mean) · kappa)
//!   local posterior = Beta(prior_alpha + s, prior_beta + f)
//!
//! Sparse profiles stay close to the parent mean; mature profiles move toward
//! their own measured rate.

use crate::network_intelligence::context::context_identity::NetworkContextId;
use crate::network_intelligence::probability::BetaBernoulli;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A complete Beta posterior summary for UI/diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BetaPosterior {
    pub alpha: f64,
    pub beta: f64,
    pub effective_sample_size: f64,
    pub mean: f64,
    pub variance: f64,
    pub credible_low: f64,
    pub credible_high: f64,
    /// Probability the next Bernoulli observation succeeds.
    pub predictive: f64,
}

impl BetaPosterior {
    fn from_model(model: &BetaBernoulli, level: f64) -> Self {
        let (low, high) = model.credible_interval(level);
        Self {
            alpha: model.posterior_alpha(),
            beta: model.posterior_beta(),
            effective_sample_size: model.effective_sample_size(),
            mean: model.mean(),
            variance: model.variance(),
            credible_low: low,
            credible_high: high,
            predictive: model.mean(),
        }
    }
}

/// Persisted form. Tuple HashMap keys are converted to a stable list so the
/// snapshot survives JSON round trips without lossy key stringification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HierarchicalSnapshot {
    pub global_alpha: f64,
    pub global_beta: f64,
    pub global_successes: u64,
    pub global_failures: u64,
    pub kappa: f64,
    pub locals: Vec<LocalSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalSnapshot {
    pub context: u64,
    pub api: String,
    pub alpha: f64,
    pub beta: f64,
    pub successes: u64,
    pub failures: u64,
}

/// A hierarchical Beta-Bernoulli model with partial pooling.
#[derive(Debug, Clone)]
pub struct HierarchicalBetaBernoulli {
    /// Global model over the device-level success probability.
    global: BetaBernoulli,
    /// Strength of the global mean in a newly created local prior.
    kappa: f64,
    /// Per-(context, api) local models.
    locals: HashMap<(NetworkContextId, String), BetaBernoulli>,
}

impl HierarchicalBetaBernoulli {
    /// Create a model with a global prior `Beta(a0, b0)` and pooling strength
    /// `kappa`. Returns `None` for non-finite or non-positive parameters.
    pub fn new(a0: f64, b0: f64, kappa: f64) -> Option<Self> {
        let global = BetaBernoulli::new(a0, b0)?;
        if kappa <= 0.0 || !kappa.is_finite() {
            return None;
        }
        Some(Self {
            global,
            kappa,
            locals: HashMap::new(),
        })
    }

    /// Uniform global prior `Beta(1, 1)` with default kappa 10.0.
    pub fn uniform() -> Self {
        Self::new(1.0, 1.0, 10.0).expect("valid parameters")
    }

    /// Global posterior mean success probability.
    pub fn global_mean(&self) -> f64 {
        self.global.mean()
    }

    /// Global posterior summary.
    pub fn global_posterior(&self, level: f64) -> BetaPosterior {
        BetaPosterior::from_model(&self.global, level)
    }

    /// Update the parent model from evidence that belongs to the parent only.
    ///
    /// Local `observe` calls never reach this function. Callers must route an
    /// observation here exactly once if it is genuinely device-level evidence.
    pub fn observe_global(&mut self, success: Option<bool>) {
        self.global.observe(success);
    }

    /// Get or create the local model for a (context, api) pair.
    fn local_model_mut(&mut self, context: NetworkContextId, api: &str) -> &mut BetaBernoulli {
        let mean = self.global.mean();
        let kappa = self.kappa;
        self.locals
            .entry((context, api.to_string()))
            .or_insert_with(|| {
                BetaBernoulli::new(mean * kappa, (1.0 - mean) * kappa)
                    .expect("valid local prior")
            })
    }

    /// Pooled success probability for a (context, api) pair.
    ///
    /// The local posterior already contains the global prior, so no second
    /// blend with the global mean is applied (that would double-count the
    /// parent). With no local data the global mean is returned exactly.
    pub fn predict(&self, context: NetworkContextId, api: &str) -> f64 {
        self.locals
            .get(&(context, api.to_string()))
            .map(|m| m.mean())
            .unwrap_or_else(|| self.global.mean())
    }

    /// Full posterior for one (context, api) pair.
    pub fn posterior(&self, context: NetworkContextId, api: &str, level: f64) -> BetaPosterior {
        self.locals
            .get(&(context, api.to_string()))
            .map(|m| BetaPosterior::from_model(m, level))
            .unwrap_or_else(|| BetaPosterior::from_model(&self.global, level))
    }

    /// Record one success/failure for a (context, api) pair. `None` (missing
    /// measurement) is ignored, never treated as failure.
    pub fn observe(&mut self, context: NetworkContextId, api: &str, success: Option<bool>) {
        let Some(success) = success else {
            return;
        };
        let model = self.local_model_mut(context, api);
        model.observe(Some(success));
    }

    /// Observed sample count for a (context, api) pair.
    pub fn local_count(&self, context: NetworkContextId, api: &str) -> u64 {
        self.locals
            .get(&(context, api.to_string()))
            .map(|m| m.n())
            .unwrap_or(0)
    }

    /// Number of distinct (context, api) pairs with local data.
    pub fn n_locals(&self) -> usize {
        self.locals.len()
    }

    /// Contexts that currently have at least one local model.
    pub fn contexts(&self) -> Vec<NetworkContextId> {
        let mut ids: Vec<NetworkContextId> =
            self.locals.keys().map(|(ctx, _)| *ctx).collect();
        ids.sort_by_key(|id| id.0);
        ids.dedup();
        ids
    }

    /// Serialize without exposing private fields.
    pub fn snapshot(&self) -> HierarchicalSnapshot {
        let mut locals: Vec<LocalSnapshot> = self
            .locals
            .iter()
            .map(|((ctx, api), model)| LocalSnapshot {
                context: ctx.0,
                api: api.clone(),
                alpha: model.alpha,
                beta: model.beta,
                successes: model.successes(),
                failures: model.failures(),
            })
            .collect();
        locals.sort_by(|a, b| a.context.cmp(&b.context).then(a.api.cmp(&b.api)));
        HierarchicalSnapshot {
            global_alpha: self.global.alpha,
            global_beta: self.global.beta,
            global_successes: self.global.successes(),
            global_failures: self.global.failures(),
            kappa: self.kappa,
            locals,
        }
    }

    /// Restore a snapshot. Invalid hyperparameters return `None` instead of
    /// silently clamping corrupt values into a plausible model.
    pub fn from_snapshot(snapshot: &HierarchicalSnapshot) -> Option<Self> {
        let mut model = Self::new(snapshot.global_alpha, snapshot.global_beta, snapshot.kappa)?;
        if snapshot.global_successes > 0 || snapshot.global_failures > 0 {
            model
                .global
                .observe_batch(snapshot.global_successes, snapshot.global_failures);
        }
        for local in &snapshot.locals {
            let mut m = BetaBernoulli::new(local.alpha, local.beta)?;
            m.observe_batch(local.successes, local.failures);
            model
                .locals
                .insert((NetworkContextId(local.context), local.api.clone()), m);
        }
        Some(model)
    }
}

impl Default for HierarchicalBetaBernoulli {
    fn default() -> Self {
        Self::uniform()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn predict_starts_at_global_mean() {
        let model = HierarchicalBetaBernoulli::uniform();
        assert!((model.predict(NetworkContextId(1), "api-a") - 0.5).abs() < 1e-9);
    }

    #[test]
    fn local_data_shifts_prediction_away_from_global() {
        let mut model = HierarchicalBetaBernoulli::uniform();
        let ctx = NetworkContextId(1);
        for _ in 0..200 {
            model.observe(ctx, "api-a", Some(true));
        }
        for _ in 0..200 {
            model.observe(ctx, "api-b", Some(false));
        }
        assert!(model.predict(ctx, "api-a") > 0.8);
        assert!(model.predict(ctx, "api-b") < 0.2);
    }

    #[test]
    fn sparse_local_data_shrinks_toward_global() {
        let mut model = HierarchicalBetaBernoulli::uniform();
        let ctx = NetworkContextId(2);
        model.observe(ctx, "api-x", Some(true));
        let p = model.predict(ctx, "api-x");
        assert!((p - 0.5).abs() < 0.2, "sparse data should stay near global: {p}");
    }

    #[test]
    fn global_prior_influences_new_contexts() {
        let mut model = HierarchicalBetaBernoulli::new(8.0, 2.0, 10.0).expect("valid");
        assert!((model.global_mean() - 0.8).abs() < 1e-9);
        let p = model.predict(NetworkContextId(9), "api-new");
        assert!((p - 0.8).abs() < 0.05);
    }

    #[test]
    fn missing_observation_is_ignored() {
        let mut model = HierarchicalBetaBernoulli::uniform();
        let ctx = NetworkContextId(3);
        let before = model.predict(ctx, "api-y");
        model.observe(ctx, "api-y", None);
        assert_eq!(before, model.predict(ctx, "api-y"));
        assert_eq!(model.local_count(ctx, "api-y"), 0);
    }

    #[test]
    fn kappa_controls_pooling_strength() {
        let mut tight = HierarchicalBetaBernoulli::new(1.0, 1.0, 1.0).expect("valid");
        let mut loose = HierarchicalBetaBernoulli::new(1.0, 1.0, 100.0).expect("valid");
        let ctx = NetworkContextId(4);
        for _ in 0..50 {
            tight.observe(ctx, "api-z", Some(true));
            loose.observe(ctx, "api-z", Some(true));
        }
        assert!(tight.predict(ctx, "api-z") > loose.predict(ctx, "api-z"));
    }

    #[test]
    fn posterior_matches_closed_form_mean_and_variance() {
        let mut model = HierarchicalBetaBernoulli::new(1.0, 1.0, 10.0).expect("valid");
        let ctx = NetworkContextId(7);
        for _ in 0..12 {
            model.observe(ctx, "api", Some(true));
        }
        for _ in 0..3 {
            model.observe(ctx, "api", Some(false));
        }
        let p = model.posterior(ctx, "api", 0.95);
        // local prior Beta(5,5), so posterior Beta(17,8)
        assert!((p.alpha - 17.0).abs() < 1e-9);
        assert!((p.beta - 8.0).abs() < 1e-9);
        assert!((p.mean - 17.0 / 25.0).abs() < 1e-9);
        let expected_var = (17.0 * 8.0) / (25.0 * 25.0 * 26.0);
        assert!((p.variance - expected_var).abs() < 1e-12);
        assert!((p.effective_sample_size - 25.0).abs() < 1e-9);
        assert!(p.credible_low <= p.mean && p.mean <= p.credible_high);
    }

    #[test]
    fn local_observations_do_not_update_the_parent() {
        let mut model = HierarchicalBetaBernoulli::uniform();
        let before = model.global_posterior(0.95);
        for _ in 0..100 {
            model.observe(NetworkContextId(1), "api", Some(true));
        }
        let after = model.global_posterior(0.95);
        assert_eq!(before, after, "child evidence must not be counted in the parent");
    }

    #[test]
    fn global_observations_are_inherited_by_new_contexts() {
        let mut model = HierarchicalBetaBernoulli::uniform();
        for _ in 0..50 {
            model.observe_global(Some(true));
        }
        let p = model.predict(NetworkContextId(11), "new-api");
        assert!(p > 0.8, "new context should inherit learned parent mean: {p}");
    }

    #[test]
    fn snapshot_round_trip_preserves_posteriors() {
        let mut model = HierarchicalBetaBernoulli::new(2.0, 3.0, 7.0).expect("valid");
        let ctx = NetworkContextId(42);
        for i in 0..20 {
            model.observe(ctx, "api", Some(i % 3 != 0));
        }
        model.observe_global(Some(true));
        let restored = HierarchicalBetaBernoulli::from_snapshot(&model.snapshot()).expect("valid");
        assert!((restored.predict(ctx, "api") - model.predict(ctx, "api")).abs() < 1e-12);
        assert!((restored.global_mean() - model.global_mean()).abs() < 1e-12);
    }

    #[test]
    fn invalid_parameters_are_rejected() {
        assert!(HierarchicalBetaBernoulli::new(0.0, 1.0, 10.0).is_none());
        assert!(HierarchicalBetaBernoulli::new(1.0, -1.0, 10.0).is_none());
        assert!(HierarchicalBetaBernoulli::new(1.0, 1.0, 0.0).is_none());
        assert!(HierarchicalBetaBernoulli::new(1.0, 1.0, f64::NAN).is_none());
    }

    #[test]
    fn extreme_counts_remain_finite_and_normalized() {
        let mut model = HierarchicalBetaBernoulli::uniform();
        let ctx = NetworkContextId(8);
        model.observe(ctx, "all-success", Some(true));
        let p = model.posterior(ctx, "all-success", 0.95);
        assert!(p.mean.is_finite() && p.variance.is_finite());
        assert!((0.0..=1.0).contains(&p.mean));
    }
}
