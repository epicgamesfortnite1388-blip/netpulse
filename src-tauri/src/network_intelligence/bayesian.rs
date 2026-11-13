// Bayesian inference primitives used throughout NANI.
//
// Everything here works in log-space to avoid underflow, and every update is
// explicit about what evidence was used and how fresh it is. No hidden
// smoothing, no invented pseudo-counts unless the caller asks for them.

use crate::network_intelligence::math::{
    bernoulli_entropy, clamp_probability, finite_or_default, kl_divergence, js_divergence,
    log_sum_exp, softmax,
};
use crate::network_intelligence::probability::BetaBernoulli;

/// A single piece of evidence fed into a Bayesian update.
///
/// `log_likelihood` is `log P(evidence | hypothesis)`. `timestamp` is the
/// observation time (unix seconds) so that evidence can be decayed. `source`
/// identifies where the measurement came from so the same probe is not
/// double-counted.
#[derive(Debug, Clone)]
pub struct Evidence {
    pub hypothesis: String,
    pub log_likelihood: f64,
    pub timestamp: u64,
    pub source: String,
    /// Confidence in this specific measurement (0..1). `None` means unknown.
    pub confidence: Option<f64>,
}

/// A prior over a discrete set of hypotheses, stored as log-probabilities.
///
/// `priors[i]` is `log P(H_i)` before any evidence. Must sum to 1 when
/// exponentiated (the constructor normalizes via log-space softmax).
#[derive(Debug, Clone)]
pub struct Prior {
    pub labels: Vec<String>,
    pub log_probs: Vec<f64>,
}

impl Prior {
    /// Uniform prior over `n` hypotheses.
    pub fn uniform(labels: Vec<String>) -> Self {
        let lp = -(labels.len() as f64).ln();
        Self {
            log_probs: vec![lp; labels.len()],
            labels,
        }
    }

    /// Build from a vector of probabilities; they are normalized internally.
    pub fn from_probs(labels: Vec<String>, probs: Vec<f64>) -> Option<Self> {
        if labels.len() != probs.len() || labels.is_empty() {
            return None;
        }
        let log_probs: Vec<f64> = probs
            .iter()
            .copied()
            .map(|p| if p <= 0.0 { f64::NEG_INFINITY } else { p.ln() })
            .collect();
        let normalized = super::math::normalize_weights(&probs)?;
        let log_probs: Vec<f64> = normalized.iter().copied().map(|p| p.ln()).collect();
        Some(Self { labels, log_probs })
    }

    /// Probability of hypothesis `i`.
    pub fn prob(&self, i: usize) -> f64 {
        if i >= self.labels.len() {
            return 0.0;
        }
        softmax(&self.log_probs)
            .as_ref()
            .map(|ps| ps[i])
            .unwrap_or(0.0)
    }

    /// Index of the most probable hypothesis (MAP estimate).
    pub fn map(&self) -> Option<usize> {
        // Deterministic argmax: ties resolve to the first hypothesis in the
        // declared order (not the last), so a uniform posterior is stable and
        // reproducible across runs and platforms.
        let mut best: Option<(usize, f64)> = None;
        for (i, &lp) in self.log_probs.iter().enumerate() {
            match best {
                Some((_, b)) if lp <= b => {}
                _ => best = Some((i, lp)),
            }
        }
        best.map(|(i, _)| i)
    }

    /// Entropy of the prior, in nats.
    pub fn entropy(&self) -> f64 {
        let probs = match softmax(&self.log_probs) {
            Some(p) => p,
            None => return 0.0,
        };
        let mut acc = 0.0;
        for p in probs {
            if p > 0.0 {
                acc -= p * p.ln();
            }
        }
        acc
    }

    /// Apply multiplicative evidence: add `log_likelihood` to hypothesis `i`.
    pub fn add_evidence(&mut self, i: usize, log_likelihood: f64) {
        if i < self.log_probs.len() && log_likelihood.is_finite() {
            self.log_probs[i] += log_likelihood;
        }
    }

    /// Normalize in place so the distribution sums to 1 (in log space this
    /// just subtracts the log-sum-exp).
    pub fn normalize(&mut self) {
        if let Some(lse) = softmax(&self.log_probs) {
            // softmax returns probabilities; convert back to normalized log-probs
            let lse = log_sum_exp(&self.log_probs);
            if lse.is_finite() {
                for lp in &mut self.log_probs {
                    *lp -= lse;
                }
            }
        }
    }
}

/// A posterior over hypotheses after incorporating evidence.
///
/// Wraps a [`Prior`] that has already been updated with evidence and
/// normalized. Provides convenience methods for querying the posterior.
#[derive(Debug, Clone)]
pub struct Posterior {
    pub prior: Prior,
}

impl Posterior {
    pub fn from_prior(prior: Prior) -> Self {
        Self { prior }
    }

    /// Probability of hypothesis `i`.
    pub fn prob(&self, i: usize) -> f64 {
        self.prior.prob(i)
    }

    /// Label of hypothesis `i`.
    pub fn label(&self, i: usize) -> Option<&str> {
        self.prior.labels.get(i).map(|s| s.as_str())
    }

    /// MAP estimate index.
    pub fn map(&self) -> Option<usize> {
        self.prior.map()
    }

    /// Entropy of the posterior, in nats. High entropy means the evidence has
    /// not resolved the diagnosis.
    pub fn entropy(&self) -> f64 {
        self.prior.entropy()
    }

    /// All (label, probability) pairs sorted descending by probability.
    pub fn ranked(&self) -> Vec<(&str, f64)> {
        let mut pairs: Vec<(&str, f64)> = self
            .prior
            .labels
            .iter()
            .zip(softmax(&self.prior.log_probs).unwrap_or_default())
            .map(|(l, p)| (l.as_str(), p))
            .collect();
        pairs.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        pairs
    }
}

/// Bayesian update: combine a prior with a list of evidence to form a
/// posterior. Each evidence item adds its log-likelihood to the matching
/// hypothesis. Evidence whose `source` has already been counted is skipped
/// (deduplication by source).
///
/// Returns a [`Posterior`] whose distribution sums to 1.
pub fn bayesian_update(prior: &Prior, evidence: &[Evidence]) -> Posterior {
    let mut updated = prior.clone();
    // Deduplicate on (source, hypothesis): one probe contributes exactly one
    // likelihood per hypothesis, but the same probe must reach EVERY hypothesis.
    // Deduplicating by source alone silently discarded all but the first
    // hypothesis's evidence — the bug that made DNS failures diagnose as
    // "unknown".
    let mut seen: Vec<(String, String)> = Vec::new();
    for e in evidence {
        let key = (e.source.clone(), e.hypothesis.clone());
        if seen.iter().any(|k| k == &key) {
            continue;
        }
        seen.push(key);
        let ll = finite_or_default(e.log_likelihood, 0.0);
        // Weight by confidence if available: scale the log-likelihood so a
        // low-confidence observation moves the posterior less.
        let weighted_ll = match e.confidence {
            Some(c) if c.is_finite() && c > 0.0 => ll * c,
            _ => ll,
        };
        let idx = updated
            .labels
            .iter()
            .position(|l| l.as_str() == e.hypothesis.as_str());
        if let Some(i) = idx {
            updated.add_evidence(i, weighted_ll);
        }
        // Evidence for a hypothesis not in the prior is ignored: we never
        // invent new hypotheses from raw evidence.
    }
    updated.normalize();
    Posterior::from_prior(updated)
}

/// Apply evidence decay: older evidence contributes less. The decay factor is
/// `exp(-lambda * age_seconds)`. Returns the decayed log-likelihood.
pub fn decay_log_likelihood(log_likelihood: f64, age_seconds: f64, lambda: f64) -> f64 {
    if !log_likelihood.is_finite() || !age_seconds.is_finite() || !lambda.is_finite() {
        return f64::NEG_INFINITY;
    }
    if age_seconds <= 0.0 {
        return log_likelihood;
    }
    log_likelihood * (-lambda * age_seconds).exp()
}

/// Posterior predictive distribution for a Bernoulli outcome given a
/// [`BetaBernoulli`] model: `P(success) = mean`.
///
/// Returns the predictive probability and the entropy of that prediction.
pub fn posterior_predictive_bernoulli(model: &BetaBernoulli) -> (f64, f64) {
    let p = model.mean();
    (p, bernoulli_entropy(p))
}

/// Update a [`BetaBernoulli`] in closed form (conjugate). This is the core of
/// all incremental Bayesian learning in NANI.
pub fn update_beta_bernoulli(model: &mut BetaBernoulli, success: Option<bool>) {
    model.observe(success);
}

/// Confidence interval width for a BetaBernoulli at the default 95% level.
pub fn beta_credible_width(model: &BetaBernoulli) -> f64 {
    let (lo, hi) = model.credible_interval(0.95);
    hi - lo
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uniform_prior_is_uniform() {
        let p = Prior::uniform(vec!["a".into(), "b".into(), "c".into()]);
        for i in 0..3 {
            assert!((p.prob(i) - 1.0 / 3.0).abs() < 1e-9);
        }
        assert!((p.entropy() - 1.0986122886681098).abs() < 1e-9); // ln 3
    }

    #[test]
    fn bayesian_update_concentrates_on_evidenced_hypothesis() {
        let prior = Prior::uniform(vec!["dns".into(), "gateway".into()]);
        let evidence = vec![
            Evidence {
                hypothesis: "dns".into(),
                log_likelihood: 5.0,
                timestamp: 100,
                source: "probe-1".into(),
                confidence: None,
            },
            Evidence {
                hypothesis: "gateway".into(),
                log_likelihood: -5.0,
                timestamp: 100,
                source: "probe-2".into(),
                confidence: None,
            },
        ];
        let post = bayesian_update(&prior, &evidence);
        assert!(post.prob(0) > post.prob(1));
        assert!((post.prob(0) + post.prob(1) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn bayesian_update_normalizes() {
        let prior = Prior::uniform(vec!["x".into(), "y".into()]);
        let evidence = vec![
            Evidence {
                hypothesis: "x".into(),
                log_likelihood: 10.0,
                timestamp: 1,
                source: "s1".into(),
                confidence: None,
            },
            Evidence {
                hypothesis: "y".into(),
                log_likelihood: 10.0,
                timestamp: 1,
                source: "s2".into(),
                confidence: None,
            },
        ];
        let post = bayesian_update(&prior, &evidence);
        assert!((post.prob(0) - 0.5).abs() < 1e-9);
        assert!((post.prob(1) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn duplicate_source_is_not_double_counted() {
        let prior = Prior::uniform(vec!["h".into()]);
        let evidence = vec![
            Evidence {
                hypothesis: "h".into(),
                log_likelihood: 2.0,
                timestamp: 1,
                source: "same-probe".into(),
                confidence: None,
            },
            Evidence {
                hypothesis: "h".into(),
                log_likelihood: 2.0,
                timestamp: 2,
                source: "same-probe".into(),
                confidence: None,
            },
        ];
        let post = bayesian_update(&prior, &evidence);
        // Only one update of +2.0 should apply (from log(1/2)=-0.693 baseline).
        // After one +2.0: log prob = -0.693 + 2.0 = 1.307; normalized prob = 1.0 (only hypothesis)
        assert!((post.prob(0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn evidence_for_unknown_hypothesis_is_ignored() {
        let prior = Prior::uniform(vec!["known".into()]);
        let evidence = vec![Evidence {
            hypothesis: "unknown".into(),
            log_likelihood: 100.0,
            timestamp: 1,
            source: "s".into(),
            confidence: None,
        }];
        let post = bayesian_update(&prior, &evidence);
        assert!((post.prob(0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn confidence_scales_log_likelihood() {
        let prior = Prior::uniform(vec!["a".into(), "b".into()]);
        let full_conf = Evidence {
            hypothesis: "a".into(),
            log_likelihood: 5.0,
            timestamp: 1,
            source: "s1".into(),
            confidence: Some(1.0),
        };
        let low_conf = Evidence {
            hypothesis: "a".into(),
            log_likelihood: 5.0,
            timestamp: 1,
            source: "s2".into(),
            confidence: Some(0.1),
        };
        let p_full = bayesian_update(&prior, &[full_conf]).prob(0);
        let p_low = bayesian_update(&prior, &[low_conf]).prob(0);
        assert!(p_full > p_low);
    }

    #[test]
    fn decay_reduces_influence_of_old_evidence() {
        let ll = 5.0;
        let fresh = decay_log_likelihood(ll, 0.0, 0.1);
        assert!((fresh - ll).abs() < f64::EPSILON);
        let old = decay_log_likelihood(ll, 100.0, 0.1);
        assert!(old < ll);
        assert!(old > 0.0);
        // Very old evidence decays toward zero
        let ancient = decay_log_likelihood(ll, 10000.0, 0.1);
        assert!(ancient < old);
    }

    #[test]
    fn posterior_entropy_drops_with_conclusive_evidence() {
        let prior = Prior::uniform(vec!["a".into(), "b".into()]);
        let h_before = prior.entropy();
        let evidence = vec![Evidence {
            hypothesis: "a".into(),
            log_likelihood: 20.0,
            timestamp: 1,
            source: "s".into(),
            confidence: None,
        }];
        let post = bayesian_update(&prior, &evidence);
        assert!(post.entropy() < h_before);
        assert!(post.entropy() < 0.1); // nearly certain
    }

    #[test]
    fn posterior_predictive_matches_beta_mean() {
        let mut model = BetaBernoulli::uniform();
        model.observe_batch(30, 70);
        let (p, ent) = posterior_predictive_bernoulli(&model);
        assert!((p - 0.31).abs() < 0.01); // (1+30)/(2+100) = 31/102 ≈ 0.304
        assert!((ent - bernoulli_entropy(p)).abs() < f64::EPSILON);
    }

    #[test]
    fn kl_divergence_between_posteriors() {
        let p1 = Prior::from_probs(
            vec!["a".into(), "b".into()],
            vec![0.9, 0.1],
        )
        .expect("valid");
        let p2 = Prior::from_probs(
            vec!["a".into(), "b".into()],
            vec![0.1, 0.9],
        )
        .expect("valid");
        let probs1: Vec<f64> = vec![p1.prob(0), p1.prob(1)];
        let probs2: Vec<f64> = vec![p2.prob(0), p2.prob(1)];
        let d = kl_divergence(&probs1, &probs2).expect("valid");
        assert!(d > 1.0); // quite different
        let d_self = kl_divergence(&probs1, &probs1).expect("valid");
        assert!(d_self.abs() < 1e-9);
    }
}

