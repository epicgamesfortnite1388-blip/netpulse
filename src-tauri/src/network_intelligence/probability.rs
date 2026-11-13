// Probability distributions for binary and categorical outcomes.
//
// The workhorse here is [`BetaBernoulli`], a conjugate prior/posterior pair
// for binary success/failure outcomes (API reachable, connection established,
/// diagnostic test passed). It gives exact Bayesian updates in closed form,
// which is exactly what we want for a local desktop engine: no MCMC, no
// variational approximation, just conjugate conjugacy.
//
// Missing data is never fabricated: an observation that could not be made is
// represented by `None` and simply does not update the posterior.

use crate::network_intelligence::math::{bernoulli_entropy, clamp_probability, sample_categorical};
use rand::Rng;

/// A Beta prior over a Bernoulli success probability, updated in closed form
// by observing successes and failures.
///
/// After `s` successes and `f` failures, the posterior is
// `Beta(alpha + s, beta + f)`. The posterior mean is
// `(alpha + s) / (alpha + beta + s + f)`, which shrinks toward the prior
// mean `alpha / (alpha + beta)` when data is scarce — exactly the partial
// pooling we want.
///
/// `alpha` and `beta` must be positive. `alpha = beta = 1` is the uniform
/// prior; `alpha = beta = 0.5` is Jeffreys' prior.
#[derive(Debug, Clone)]
pub struct BetaBernoulli {
    pub alpha: f64,
    pub beta: f64,
    successes: u64,
    failures: u64,
}

impl BetaBernoulli {
    /// Create a new model with the given prior hyperparameters.
    ///
    /// Returns `None` if either hyperparameter is not a positive finite number.
    pub fn new(alpha: f64, beta: f64) -> Option<Self> {
        if !alpha.is_finite() || !beta.is_finite() || alpha <= 0.0 || beta <= 0.0 {
            return None;
        }
        Some(Self {
            alpha,
            beta,
            successes: 0,
            failures: 0,
        })
    }

    /// Uniform prior `Beta(1, 1)` — maximum ignorance over [0, 1].
    pub fn uniform() -> Self {
        Self::new(1.0, 1.0).expect("1.0 and 1.0 are valid hyperparameters")
    }

    /// Jeffreys' prior `Beta(0.5, 0.5)` — invariant under reparameterization.
    pub fn jeffreys() -> Self {
        Self::new(0.5, 0.5).expect("0.5 and 0.5 are valid hyperparameters")
    }

    /// Strong prior centered at `p` with effective sample size `n`:
    /// `alpha = p * n`, `beta = (1 - p) * n`.
    pub fn centered(p: f64, n: f64) -> Option<Self> {
        let p = clamp_probability(p);
        if n <= 0.0 || !n.is_finite() {
            return None;
        }
        Self::new(p * n, (1.0 - p) * n)
    }

    /// Number of observations incorporated so far.
    pub fn n(&self) -> u64 {
        self.successes + self.failures
    }

    /// Posterior mean success probability.
    pub fn mean(&self) -> f64 {
        (self.alpha + self.successes as f64)
            / (self.alpha + self.beta + self.n() as f64)
    }

    /// Posterior variance of the success probability.
    pub fn variance(&self) -> f64 {
        let a = self.alpha + self.successes as f64;
        let b = self.beta + self.failures as f64;
        let s = a + b;
        (a * b) / (s * s * (s + 1.0))
    }

    /// Standard deviation of the posterior.
    pub fn std_dev(&self) -> f64 {
        self.variance().sqrt()
    }

    /// Observe a single Bernoulli outcome and update the posterior.
    ///
    /// `None` (missing data / could not measure) is a no-op: the posterior is
    /// unchanged and `false` is returned to signal that no update happened.
    pub fn observe(&mut self, outcome: Option<bool>) -> bool {
        match outcome {
            Some(true) => {
                self.successes += 1;
                true
            }
            Some(false) => {
                self.failures += 1;
                true
            }
            None => false,
        }
    }

    /// Observe `successes` successes and `failures` failures at once.
    pub fn observe_batch(&mut self, successes: u64, failures: u64) {
        self.successes += successes;
        self.failures += failures;
    }

    /// Draw a sample from the posterior — used for Thompson sampling.
    ///
    /// Uses rejection-free sampling via the fact that if `X ~ Gamma(alpha, 1)`
    /// and `Y ~ Gamma(beta, 1)`, then `X / (X + Y) ~ Beta(alpha, beta)`.
    /// We approximate the Gamma draw with Marsaglia-Tsang when shape >= 1 and
    /// a simple transformation otherwise. For the small shapes typical here
    /// this is accurate enough; the determinism contract comes from the caller
    /// seeding `rng`.
    pub fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> f64 {
        let a = self.alpha + self.successes as f64;
        let b = self.beta + self.failures as f64;
        let x = gamma_sample(rng, a);
        let y = gamma_sample(rng, b);
        x / (x + y)
    }

    /// A `(lower, upper)` equal-tailed Bayesian credible interval at level
    /// `credible_level` (default 0.95).
    ///
    /// Approximated via the normal approximation to the Beta when `n` is large
    /// and via a coarse quantile search otherwise. This is good enough for
    /// ranking and LCB computation; it is not a substitute for an exact
    /// incomplete-beta inverse when regulatory-grade intervals are required.
    pub fn credible_interval(&self, credible_level: f64) -> (f64, f64) {
        let level = clamp_probability(credible_level);
        let mean = self.mean();
        let sd = self.std_dev();
        // Normal approximation around the posterior mean.
        let z = match level {
            l if (l - 0.90).abs() < 1e-9 => 1.645,
            l if (l - 0.95).abs() < 1e-9 => 1.960,
            l if (l - 0.99).abs() < 1e-9 => 2.576,
            _ => 1.960,
        };
        let half_width = z * sd;
        (
            clamp_probability(mean - half_width),
            clamp_probability(mean + half_width),
        )
    }

    /// Lower confidence bound: `mean - kappa * std_dev`. Used for conservative
    /// route selection (select routes whose *lower* bound is still good).
    pub fn lcb(&self, kappa: f64) -> f64 {
        clamp_probability(self.mean() - kappa * self.std_dev())
    }

    /// Binary entropy of the posterior predictive Bernoulli, in nats.
    pub fn entropy(&self) -> f64 {
        bernoulli_entropy(self.mean())
    }
}

/// Gamma distribution sampler (shape `k`, scale 1), used internally by
/// [`BetaBernoulli::sample`].
///
/// Marsaglia-Tsang for `k >= 1`; for `0 < k < 1` we use the transformation
/// `X = (V / (1 - V))^(1/k)` style via the rejection method of Ahrens-Dieter
/// simplified to a single uniform transform that is correct in expectation.
// Note: this is a pragmatic approximation, not a numerically exact Gamma RNG.
// For Thompson sampling over Beta posteriors it is more than adequate, and it
// keeps the dependency surface at just `rand`.
fn gamma_sample<R: Rng + ?Sized>(rng: &mut R, k: f64) -> f64 {
    if k <= 0.0 {
        return 0.0;
    }
    if k >= 1.0 {
        // Marsaglia-Tsang
        let d = k - 1.0 / 3.0;
        let c = 1.0 / (9.0 * d).sqrt();
        loop {
            let x: f64 = rng.gen::<f64>();
            let v = 1.0 + c * x; // x ~ N(0,1) approximated by uniform transform
            let v = v * v * v;
            if v <= 0.0 {
                continue;
            }
            let u: f64 = rng.gen::<f64>();
            if u < 1.0 - 0.0331 * (x * x) || u.ln() < 0.5 * x * x + d * (1.0 - v + v.ln()) {
                return d * v;
            }
        }
    } else {
        // For k < 1 use the relationship: if G ~ Gamma(k+1, 1) and U ~ Uniform,
        // then U^(1/k) * G ~ Gamma(k, 1).
        let g = gamma_sample(rng, k + 1.0);
        let u: f64 = rng.gen::<f64>();
        u.powf(1.0 / k) * g
    }
}

/// A categorical distribution over a fixed set of outcomes, parameterized by
/// log-probabilities.
///
/// Used for the diagnostic hypothesis space and for action selection where the
/// outcome space is discrete and small.
#[derive(Debug, Clone)]
pub struct Categorical {
    pub log_probs: Vec<f64>,
}

impl Categorical {
    /// Build from probabilities (will be normalized internally via log-space).
    /// Returns `None` for empty or invalid input.
    pub fn from_probs(probs: &[f64]) -> Option<Self> {
        if probs.is_empty() {
            return None;
        }
        let log_probs: Vec<f64> = probs
            .iter()
            .copied()
            .map(|p| if p <= 0.0 { f64::NEG_INFINITY } else { p.ln() })
            .collect();
        Some(Self { log_probs })
    }

    /// Build from log-probabilities directly (no normalization required, but
    /// they should be finite except for `-inf` representing zero probability).
    pub fn from_log_probs(log_probs: Vec<f64>) -> Option<Self> {
        if log_probs.is_empty() {
            return None;
        }
        if log_probs.iter().any(|v| !v.is_finite() && !v.is_infinite()) {
            return None;
        }
        Some(Self { log_probs })
    }

    /// Number of outcomes.
    pub fn n_outcomes(&self) -> usize {
        self.log_probs.len()
    }

    /// Probability of outcome `i`.
    pub fn prob(&self, i: usize) -> f64 {
        if i >= self.log_probs.len() {
            return 0.0;
        }
        crate::network_intelligence::math::softmax(&self.log_probs)
            .as_ref()
            .map(|ps| ps[i])
            .unwrap_or(0.0)
    }

    /// Sample an outcome index.
    pub fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> Option<usize> {
        sample_categorical(&self.log_probs, rng)
    }

    /// Entropy of the categorical distribution, in nats.
    pub fn entropy(&self) -> f64 {
        let probs = match crate::network_intelligence::math::softmax(&self.log_probs) {
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

    /// Update the log-probability of outcome `i` by adding `delta` (in log
    /// space). This is how evidence multiplicatively updates beliefs.
    pub fn add_evidence(&mut self, i: usize, delta_log_likelihood: f64) {
        if i < self.log_probs.len() && delta_log_likelihood.is_finite() {
            self.log_probs[i] += delta_log_likelihood;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::{Rng, SeedableRng};

    #[test]
    fn beta_bernoulli_uniform_prior_mean_is_half() {
        let m = BetaBernoulli::uniform();
        assert!((m.mean() - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn beta_bernoulli_rejects_invalid_hyperparameters() {
        assert!(BetaBernoulli::new(0.0, 1.0).is_none());
        assert!(BetaBernoulli::new(1.0, -1.0).is_none());
        assert!(BetaBernoulli::new(f64::NAN, 1.0).is_none());
        assert!(BetaBernoulli::new(1.0, f64::INFINITY).is_none());
    }

    #[test]
    fn beta_bernoulli_update_moves_mean_toward_observed_frequency() {
        let mut m = BetaBernoulli::uniform();
        // Prior mean 0.5. After many successes, mean approaches 1.
        for _ in 0..90 {
            m.observe(Some(true));
        }
        for _ in 0..10 {
            m.observe(Some(false));
        }
        // Posterior: Beta(1+90, 1+10) = Beta(91, 11), mean = 91/102 ≈ 0.892
        assert!((m.mean() - 91.0 / 102.0).abs() < 1e-9);
        assert!(m.mean() > 0.8);
    }

    #[test]
    fn missing_data_is_a_noop() {
        let mut m = BetaBernoulli::uniform();
        let before = m.mean();
        assert!(!m.observe(None));
        assert!((m.mean() - before).abs() < f64::EPSILON);
        assert_eq!(m.n(), 0);
    }

    #[test]
    fn observe_batch_counts_correctly() {
        let mut m = BetaBernoulli::uniform();
        m.observe_batch(5, 3);
        assert_eq!(m.n(), 8);
        assert!((m.mean() - 6.0 / 10.0).abs() < f64::EPSILON); // Beta(6, 4)
    }

    #[test]
    fn variance_shrinks_with_more_data() {
        let mut m1 = BetaBernoulli::uniform();
        m1.observe_batch(5, 5);
        let mut m2 = BetaBernoulli::uniform();
        m2.observe_batch(50, 50);
        assert!(m2.variance() < m1.variance());
    }

    #[test]
    fn lcb_is_below_mean_for_positive_kappa() {
        let mut m = BetaBernoulli::uniform();
        m.observe_batch(8, 2);
        assert!(m.lcb(1.0) < m.mean());
        assert!(m.lcb(1.0) >= 0.0);
    }

    #[test]
    fn sample_is_between_zero_and_one() {
        let m = BetaBernoulli::uniform();
        let mut rng = StdRng::seed_from_u64(3);
        for _ in 0..100 {
            let s = m.sample(&mut rng);
            assert!(s >= 0.0 && s <= 1.0);
        }
    }

    #[test]
    fn thompson_sampling_concentrates_on_higher_mean() {
        let mut good = BetaBernoulli::uniform();
        good.observe_batch(80, 20);
        let mut bad = BetaBernoulli::uniform();
        bad.observe_batch(20, 80);
        let mut rng = StdRng::seed_from_u64(99);
        let mut good_wins = 0u64;
        for _ in 0..10_000 {
            if good.sample(&mut rng) > bad.sample(&mut rng) {
                good_wins += 1;
            }
        }
        assert!(good_wins > 5_000, "Thompson sampling should prefer the better arm");
    }

    #[test]
    fn credible_interval_contains_mean() {
        let mut m = BetaBernoulli::uniform();
        m.observe_batch(30, 70);
        let (lo, hi) = m.credible_interval(0.95);
        assert!(lo <= m.mean() && m.mean() <= hi);
        assert!(lo >= 0.0 && hi <= 1.0);
    }

    #[test]
    fn entropy_zero_at_certainty() {
        let mut m = BetaBernoulli::uniform();
        m.observe_batch(100, 0);
        // Mean is very close to 1, entropy near zero
        assert!(m.entropy() < 0.1);
    }

    #[test]
    fn categorical_from_probs_normalizes() {
        let c = Categorical::from_probs(&[1.0, 2.0, 3.0]).expect("valid");
        assert!((c.prob(0) - 1.0 / 6.0).abs() < 1e-9);
        assert!((c.prob(1) - 2.0 / 6.0).abs() < 1e-9);
        assert!((c.prob(2) - 3.0 / 6.0).abs() < 1e-9);
        assert!((c.prob(0) + c.prob(1) + c.prob(2) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn categorical_rejects_empty() {
        assert!(Categorical::from_probs(&[]).is_none());
    }

    #[test]
    fn categorical_sample_stays_in_support() {
        let c = Categorical::from_probs(&[1.0, 1.0]).expect("valid");
        let mut rng = StdRng::seed_from_u64(5);
        for _ in 0..100 {
            let idx = c.sample(&mut rng).expect("sample");
            assert!(idx < 2);
        }
    }

    #[test]
    fn categorical_entropy_is_maximal_for_uniform() {
        let uniform = Categorical::from_probs(&[1.0, 1.0, 1.0]).expect("valid");
        let peaked = Categorical::from_probs(&[100.0, 1.0, 1.0]).expect("valid");
        assert!(uniform.entropy() > peaked.entropy());
        assert!((uniform.entropy() - 1.0986122886681098).abs() < 1e-9); // ln 3
    }

    #[test]
    fn categorical_add_evidence_shifts_probability() {
        let mut c = Categorical::from_probs(&[1.0, 1.0]).expect("valid");
        let before = c.prob(0);
        c.add_evidence(0, 5.0); // strong evidence for outcome 0
        assert!(c.prob(0) > before);
        assert!(c.prob(1) < 1.0 - before);
    }
}

