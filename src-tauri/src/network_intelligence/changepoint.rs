//! NANI Bayesian Online Changepoint Detection (BOCPD)
//!
//! Implements Bayesian Online Changepoint Detection as described in
//! Adams & MacKay (2007). Detects both sudden and gradual changes in
//! network conditions without requiring a predefined threshold.
//!
//! Maintains a run-length distribution: P(r_t | x_{1:t}) where r_t is the
//! time since the last changepoint.
//!
//! Hazard function: probability of a changepoint at each step.
//! Default: constant hazard (geometric prior on run length).

use crate::network_intelligence::math::clamp_probability;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Hazard function: probability of a changepoint at each time step.
#[derive(Debug, Clone, Copy)]
pub enum HazardFunction {
    /// Constant hazard: constant probability of changepoint at each step.
    /// lambda = expected run length.
    Constant(f64),
}

impl HazardFunction {
    /// Compute the hazard probability P(r_t = 0 | r_{t-1} = r).
    pub fn hazard(&self, run_length: u64) -> f64 {
        match self {
            HazardFunction::Constant(lambda) => {
                // Geometric distribution: P(change at step n) = 1/lambda
                1.0 / (*lambda as f64)
            }
        }
    }

    /// Compute the survival probability P(r_t > r | r_{t-1} = r).
    pub fn survival(&self, run_length: u64) -> f64 {
        1.0 - self.hazard(run_length)
    }
}

/// Bayesian Online Changepoint Detection.
///
/// Maintains a distribution over run lengths (time since last changepoint).
/// When the probability of run length 0 becomes high, a changepoint is detected.
/// Sufficient statistics for one run length's Gaussian segment.
#[derive(Debug, Clone, Copy, Default)]
struct RunStats {
    n: f64,
    mean: f64,
    m2: f64,
}

impl RunStats {
    fn add(self, x: f64) -> Self {
        let n = self.n + 1.0;
        let delta = x - self.mean;
        let mean = self.mean + delta / n;
        let m2 = self.m2 + delta * (x - mean);
        Self { n, mean, m2 }
    }
}

#[derive(Debug, Clone)]
pub struct BayesianOnlineCPD {
    hazard: HazardFunction,
    /// Run length distribution: P(run_length | data_so_far).
    run_length_dist: HashMap<u64, f64>,
    /// Per-run sufficient statistics for the Gaussian segment likelihood.
    stats: HashMap<u64, RunStats>,
    /// Number of observations processed.
    n: u64,
    /// Maximum run length to track (bounds memory).
    max_run_length: u64,
    /// Decayed maximum of the instantaneous changepoint probability. A single
    /// shift spikes the instantaneous value for one step; alerting needs the
    /// evidence to remain visible while the new regime is still fresh.
    recent_cp: f64,
}

impl BayesianOnlineCPD {
    /// Create a new BOCPD with constant hazard.
    pub fn new(hazard: HazardFunction, max_run_length: u64) -> Option<Self> {
        if max_run_length == 0 {
            return None;
        }
        match hazard {
            HazardFunction::Constant(lambda) if !lambda.is_finite() || lambda <= 0.0 => return None,
            _ => {}
        }
        // Start with a single hypothesis: the current run has length 0.
        let mut run_length_dist = HashMap::new();
        run_length_dist.insert(0, 1.0);
        let mut stats = HashMap::new();
        stats.insert(0, RunStats::default());
        Some(Self {
            hazard,
            run_length_dist,
            stats,
            n: 0,
            max_run_length,
            recent_cp: 0.0,
        })
    }

    /// Default: constant hazard with expected run length 50, max run length 100.
    pub fn default_cpd() -> Self {
        Self::new(HazardFunction::Constant(50.0), 100).unwrap()
    }

    /// Add an observation (prediction error or residual).
    /// The observation x_t is used to update the run length distribution
    /// via the predictive distribution of the observation model.
    ///
    /// For simplicity, we use a Gaussian observation model with unknown
    /// mean and variance. The predictive probability is computed using
    /// a Normal-Inverse-Gamma prior.
    pub fn observe(&mut self, x: f64) {
        if !x.is_finite() {
            return;
        }

        self.n += 1;

        let mut new_dist: HashMap<u64, f64> = HashMap::new();
        let mut new_stats: HashMap<u64, RunStats> = HashMap::new();

        // r_t = 0: a changepoint happened at this step. Its prior probability is
        // the hazard summed over the previous run lengths, weighted by how well
        // each one predicted the observation.
        let mut cp_prob = 0.0;
        for (&r, &prob) in self.run_length_dist.iter() {
            if prob <= 0.0 {
                continue;
            }
            let likelihood = self.predictive_probability(r, x);
            cp_prob += prob * self.hazard.hazard(r) * likelihood;
        }
        new_dist.insert(0, cp_prob);
        new_stats.insert(0, RunStats::default().add(x));

        // r_t = r_prev + 1: no changepoint; the segment continues.
        for (&r, &prob) in self.run_length_dist.iter() {
            if prob <= 0.0 || r + 1 > self.max_run_length {
                continue;
            }
            let likelihood = self.predictive_probability(r, x);
            let growth = prob * self.hazard.survival(r) * likelihood;
            if growth <= 0.0 {
                continue;
            }
            *new_dist.entry(r + 1).or_insert(0.0) += growth;
            let stats = self.stats.get(&r).copied().unwrap_or_default();
            new_stats.insert(r + 1, stats.add(x));
        }

        // Normalize (the likelihoods are unnormalized by design).
        let total: f64 = new_dist.values().sum();
        if total > 0.0 {
            for prob in new_dist.values_mut() {
                *prob /= total;
            }
        } else {
            new_dist.clear();
            new_dist.insert(0, 1.0);
            new_stats.clear();
            new_stats.insert(0, RunStats::default().add(x));
        }

        self.run_length_dist = new_dist;
        self.stats = new_stats;
        let instantaneous = self.run_length_dist.get(&0).copied().unwrap_or(0.0);
        self.recent_cp = instantaneous.max(self.recent_cp * 0.95);
    }

    /// Recent changepoint evidence: the instantaneous probability of a change
    /// at this step, smoothed with a decaying maximum (half-life ≈ 14 steps).
    pub fn changepoint_probability(&self) -> f64 {
        self.recent_cp
    }

    /// Probability that a changepoint happened at exactly this step.
    pub fn instantaneous_changepoint_probability(&self) -> f64 {
        self.run_length_dist.get(&0).copied().unwrap_or(0.0)
    }

    /// Get the most likely run length.
    pub fn most_likely_run_length(&self) -> u64 {
        self.run_length_dist
            .iter()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(r, _)| *r)
            .unwrap_or(0)
    }

    /// Get the expected run length.
    pub fn expected_run_length(&self) -> f64 {
        self.run_length_dist
            .iter()
            .map(|(&r, &p)| r as f64 * p)
            .sum()
    }

    /// Predictive probability P(x_t | run_length = r, x_{1:t-1}).
    ///
    /// Uses a simple Gaussian model: P(x | r) = N(x | mean_r, var_r).
    /// For simplicity, we approximate with a fixed variance.
    fn predictive_probability(&self, run_length: u64, x: f64) -> f64 {
        let Some(stats) = self.stats.get(&run_length) else {
            return 1.0;
        };
        if stats.n <= 0.0 {
            return 1.0;
        }
        // Gaussian predictive with a weak variance floor. The floor prevents a
        // constant segment from producing a numerically infinite likelihood,
        // while a genuine distribution shift still makes a long run very
        // unlikely — which is exactly what raises the changepoint probability.
        let variance = (stats.m2 / stats.n).max(1e-2);
        let z = x - stats.mean;
        (-0.5 * z * z / variance).exp() / (2.0 * std::f64::consts::PI * variance).sqrt()
    }

    /// Number of observations processed.
    pub fn n(&self) -> u64 {
        self.n
    }
}

impl Default for BayesianOnlineCPD {
    fn default() -> Self {
        Self::default_cpd()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bocpd_detects_changepoint() {
        let mut cpd = BayesianOnlineCPD::default_cpd();

        // Feed observations from one distribution (mean = 0)
        for _ in 0..20 {
            cpd.observe(0.0);
        }

        let cp_before = cpd.changepoint_probability();
        assert!(cp_before < 0.5, "Should not detect changepoint before change: {cp_before}");

        // Feed observations from a different distribution (mean = 10)
        for _ in 0..20 {
            cpd.observe(10.0);
        }

        let cp_after = cpd.changepoint_probability();
        // After sustained observations from a different distribution,
        // changepoint probability should increase
        assert!(cp_after > cp_before, "Changepoint probability should increase: {cp_after}");
    }

    #[test]
    fn bocpd_run_length_tracks() {
        let mut cpd = BayesianOnlineCPD::default_cpd();

        // Feed 5 observations from one distribution
        for _ in 0..5 {
            cpd.observe(0.0);
        }

        // Run length should be around 5
        let rl = cpd.most_likely_run_length();
        assert!(rl >= 5, "Run length should be ~5: {rl}");
    }

    #[test]
    fn bocpd_rejects_invalid_params() {
        assert!(BayesianOnlineCPD::new(HazardFunction::Constant(0.0), 10).is_none());
        assert!(BayesianOnlineCPD::new(HazardFunction::Constant(10.0), 0).is_none());
    }
}
