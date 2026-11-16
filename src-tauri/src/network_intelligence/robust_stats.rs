//! NANI Phase 4 — Robust statistics.
//!
//! Network measurements are noisy, non-stationary, and frequently heavy-tailed.
//! Robust statistics avoid relying on means and fixed global thresholds.
//!
//! Provides median, median absolute deviation (MAD), interquartile range, and
//! a robust anomaly score:
///
/// \[
///   A_t = \frac{|x_t - \operatorname{median}(X)|}{1.4826 \cdot MAD(X) + \epsilon}
/// \]
///
/// Values of A_t >> 1 indicate an outlier relative to the recent window.
///
/// All statistics are computed over a bounded sliding window of recent
/// observations, so memory stays bounded and stale data naturally drops out.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Robust summary statistics over a bounded sliding window of observations.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RobustStats {
    window: VecDeque<f64>,
    max_size: usize,
}

impl RobustStats {
    /// Create a new robust-statistics tracker with the given window size.
    pub fn new(max_size: usize) -> Self {
        Self {
            window: VecDeque::with_capacity(max_size),
            max_size: max_size.max(1),
        }
    }

    /// Number of observations currently in the window.
    pub fn len(&self) -> usize {
        self.window.len()
    }

    /// Whether the window is empty.
    pub fn is_empty(&self) -> bool {
        self.window.is_empty()
    }

    /// Record a new observation, evicting the oldest if the window is full.
    pub fn observe(&mut self, x: f64) {
        if !x.is_finite() {
            return; // ignore non-finite measurements
        }
        if self.window.len() >= self.max_size {
            self.window.pop_front();
        }
        self.window.push_back(x);
    }

    /// Median of the window (None if empty).
    pub fn median(&self) -> Option<f64> {
        if self.window.is_empty() {
            return None;
        }
        let mut v: Vec<f64> = self.window.iter().copied().collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = v.len();
        if n % 2 == 1 {
            Some(v[n / 2])
        } else {
            Some((v[n / 2 - 1] + v[n / 2]) / 2.0)
        }
    }

    /// Median absolute deviation (MAD) of the window (None if empty).
    ///
    /// MAD = median(|x_i - median(X)|).
    pub fn mad(&self) -> Option<f64> {
        let med = self.median()?;
        if self.window.is_empty() {
            return None;
        }
        let mut devs: Vec<f64> = self.window.iter().map(|x| (x - med).abs()).collect();
        devs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = devs.len();
        if n % 2 == 1 {
            Some(devs[n / 2])
        } else {
            Some((devs[n / 2 - 1] + devs[n / 2]) / 2.0)
        }
    }

    /// Arithmetic mean of the window (None if empty).
    ///
    /// Computed over the live window only; non-finite observations are rejected
    /// by [`observe`], so this cannot return NaN from dirty input.
    pub fn mean(&self) -> Option<f64> {
        if self.window.is_empty() {
            return None;
        }
        let sum: f64 = self.window.iter().copied().sum();
        Some(sum / self.window.len() as f64)
    }

    /// Unbiased sample variance (Bessel-corrected, n - 1).
    ///
    /// Returns `None` for fewer than two observations: a single sample carries
    /// no information about dispersion, and inventing `0.0` would falsely
    /// claim certainty.
    pub fn variance(&self) -> Option<f64> {
        let n = self.window.len();
        if n < 2 {
            return None;
        }
        let mean = self.mean()?;
        let ss: f64 = self.window.iter().map(|x| (x - mean) * (x - mean)).sum();
        Some(ss / (n - 1) as f64)
    }

    /// Sample standard deviation (None for fewer than two observations).
    pub fn std_dev(&self) -> Option<f64> {
        self.variance().map(f64::sqrt)
    }

    /// Symmetrically trimmed mean.
    ///
    /// `fraction` in `[0, 0.5)` is the proportion removed from *each* tail, so
    /// `0.1` discards the lowest and highest 10% of the window. Trimming is
    /// done after sorting; the number removed per tail is `floor(n * fraction)`.
    ///
    /// Returns `None` if the window is empty or `fraction` is outside `[0, 0.5)`.
    /// Nothing is removed when the window is too small for the fraction to drop
    /// at least one observation per tail — the untrimmed mean is returned.
    pub fn trimmed_mean(&self, fraction: f64) -> Option<f64> {
        if self.window.is_empty() || !(0.0..0.5).contains(&fraction) {
            return None;
        }
        let mut v: Vec<f64> = self.window.iter().copied().collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let k = (v.len() as f64 * fraction).floor() as usize;
        let slice = &v[k..v.len() - k];
        let sum: f64 = slice.iter().sum();
        Some(sum / slice.len() as f64)
    }

    /// Winsorized mean.
    ///
    /// `fraction` in `[0, 0.5)` is the proportion replaced at *each* tail by the
    /// nearest retained order statistic (rather than dropped). This keeps every
    /// observation's weight but caps the influence of extremes, which is the
    /// right trade-off when a genuine latency spike must still count as a
    /// sample while not dominating the estimate.
    ///
    /// Returns `None` if the window is empty or `fraction` is outside `[0, 0.5)`.
    pub fn winsorized_mean(&self, fraction: f64) -> Option<f64> {
        if self.window.is_empty() || !(0.0..0.5).contains(&fraction) {
            return None;
        }
        let mut v: Vec<f64> = self.window.iter().copied().collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = v.len();
        let k = (n as f64 * fraction).floor() as usize;
        let sum: f64 = if k == 0 {
            v.iter().sum()
        } else {
            let lo = v[k];
            let hi = v[n - 1 - k];
            let tails: f64 = v[..k].iter().map(|_| lo).sum::<f64>()
                + v[n - k..].iter().map(|_| hi).sum::<f64>();
            let middle: f64 = v[k..n - k].iter().sum();
            tails + middle
        };
        Some(sum / n as f64)
    }

    /// Interquartile range (Q3 - Q1) of the window (None if empty).
    pub fn iqr(&self) -> Option<f64> {
        if self.window.is_empty() {
            return None;
        }
        let mut v: Vec<f64> = self.window.iter().copied().collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = v.len();
        let q1 = quantile(&v, 0.25);
        let q3 = quantile(&v, 0.75);
        Some(q3 - q1)
    }

    /// Robust anomaly score:
    ///
    /// \[ A_t = |x_t - median(X)| / (1.4826 * MAD(X) + eps) \]
    ///
    /// Returns None if the window is empty or MAD is zero (no dispersion).
    /// Values >> 1 indicate an outlier relative to the recent window.
    pub fn anomaly_score(&self, x: f64) -> Option<f64> {
        if self.window.is_empty() {
            return None;
        }
        if !x.is_finite() {
            return None;
        }
        let med = self.median()?;
        let mad = self.mad()?;
        let eps = 1e-6;
        let denom = 1.4826 * mad + eps;
        Some((x - med).abs() / denom)
    }

    /// P50 (median) of the window.
    pub fn p50(&self) -> Option<f64> {
        self.median()
    }

    /// P90 of the window.
    pub fn p90(&self) -> Option<f64> {
        Self::quantile_window(&self.window, 0.90)
    }

    /// P95 of the window.
    pub fn p95(&self) -> Option<f64> {
        Self::quantile_window(&self.window, 0.95)
    }

    /// P99 of the window.
    pub fn p99(&self) -> Option<f64> {
        Self::quantile_window(&self.window, 0.99)
    }

    /// Quantile at level `p` computed on the window's current observations.
    fn quantile_window(window: &VecDeque<f64>, p: f64) -> Option<f64> {
        if window.is_empty() {
            return None;
        }
        let mut v: Vec<f64> = window.iter().copied().collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        Some(quantile(&v, p))
    }
}

/// Quantile at level `p` in [0, 1] computed on a sorted slice.
fn quantile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let p = p.clamp(0.0, 1.0);
    let n = sorted.len();
    if n == 1 {
        return sorted[0];
    }
    let idx = p * (n - 1) as f64;
    let lo = idx as usize;
    let hi = (lo + 1).min(n - 1);
    let frac = idx - lo as f64;
    sorted[lo] + frac * (sorted[hi] - sorted[lo])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_of_odd_count() {
        let mut s = RobustStats::new(10);
        for x in [1.0, 5.0, 3.0] {
            s.observe(x);
        }
        assert!((s.median().unwrap() - 3.0).abs() < f64::EPSILON);
    }

    #[test]
    fn median_of_even_count() {
        let mut s = RobustStats::new(10);
        for x in [1.0, 2.0, 3.0, 4.0] {
            s.observe(x);
        }
        assert!((s.median().unwrap() - 2.5).abs() < f64::EPSILON);
    }

    #[test]
    fn mad_of_constant_is_zero() {
        let mut s = RobustStats::new(10);
        for _ in 0..5 {
            s.observe(7.0);
        }
        assert!((s.mad().unwrap() - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn anomaly_score_flags_outlier() {
        let mut s = RobustStats::new(20);
        for _ in 0..10 {
            s.observe(10.0);
        }
        // Baseline: median=10, MAD=0 → anomaly score of a far value is large.
        let score = s.anomaly_score(50.0).unwrap();
        assert!(score > 1.0, "outlier should score high: {score}");
        // A value near the median should score low.
        let normal = s.anomaly_score(10.0).unwrap();
        assert!(normal < 1.0, "normal value should score low: {normal}");
    }

    #[test]
    fn empty_window_returns_none() {
        let s = RobustStats::new(10);
        assert!(s.median().is_none());
        assert!(s.mad().is_none());
        assert!(s.anomaly_score(5.0).is_none());
    }

    #[test]
    fn window_is_bounded() {
        let mut s = RobustStats::new(3);
        s.observe(1.0);
        s.observe(2.0);
        s.observe(3.0);
        s.observe(4.0); // evicts 1.0
        assert_eq!(s.len(), 3);
        assert!((s.median().unwrap() - 3.0).abs() < f64::EPSILON);
    }

    #[test]
    fn non_finite_observations_are_ignored() {
        let mut s = RobustStats::new(10);
        s.observe(1.0);
        s.observe(f64::NAN);
        s.observe(f64::INFINITY);
        s.observe(2.0);
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn mean_and_sample_variance_match_definitions() {
        let mut s = RobustStats::new(10);
        for x in [2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0] {
            s.observe(x);
        }
        // mean = 40/8 = 5; sample variance = 32/7
        assert!((s.mean().unwrap() - 5.0).abs() < 1e-12);
        assert!((s.variance().unwrap() - 32.0 / 7.0).abs() < 1e-12);
        assert!((s.std_dev().unwrap() - (32.0f64 / 7.0).sqrt()).abs() < 1e-12);
    }

    #[test]
    fn variance_requires_two_observations() {
        let mut s = RobustStats::new(10);
        assert!(s.mean().is_none());
        assert!(s.variance().is_none());
        s.observe(1.0);
        assert!(s.variance().is_none());
        assert!(s.std_dev().is_none());
        s.observe(3.0);
        assert!((s.variance().unwrap() - 2.0).abs() < 1e-12);
    }

    #[test]
    fn trimmed_mean_discards_both_tails() {
        let mut s = RobustStats::new(20);
        for x in [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 1000.0] {
            s.observe(x);
        }
        // 10% of 10 = 1 per tail: drops 1 and 1000, mean of 2..9 = 5.5
        assert!((s.trimmed_mean(0.1).unwrap() - 5.5).abs() < 1e-12);
        // Little trimming barely changes a normal-looking set, but removes the spike.
        assert!((s.mean().unwrap() - 104.5).abs() < 1e-12);
    }

    #[test]
    fn trimmed_mean_with_too_small_a_window_keeps_everything() {
        let mut s = RobustStats::new(10);
        s.observe(1.0);
        s.observe(2.0);
        s.observe(3.0);
        // 10% of 3 floors to 0 removals per tail.
        assert!((s.trimmed_mean(0.1).unwrap() - 2.0).abs() < 1e-12);
    }

    #[test]
    fn trimmed_and_winsorized_reject_invalid_fractions() {
        let mut s = RobustStats::new(10);
        s.observe(1.0);
        assert!(s.trimmed_mean(-0.1).is_none());
        assert!(s.trimmed_mean(0.5).is_none());
        assert!(s.trimmed_mean(f64::NAN).is_none());
        assert!(s.winsorized_mean(0.5).is_none());
        assert!(RobustStats::new(4).trimmed_mean(0.1).is_none());
    }

    #[test]
    fn winsorized_mean_caps_extremes_instead_of_dropping_them() {
        let mut s = RobustStats::new(20);
        for x in [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 1000.0] {
            s.observe(x);
        }
        // 10% of 10 = 1 per tail: 1 -> 2 (lowest retained), 1000 -> 9.
        // (2*1 + 2+3+..+9 + 9*1 extra for 1000->9) => 2+2+3+4+5+6+7+8+9+9 = 55
        assert!((s.winsorized_mean(0.1).unwrap() - 5.5).abs() < 1e-12);
        // Winsorizing keeps the sample count, so it cannot exceed the raw mean.
        assert!(s.winsorized_mean(0.1).unwrap() < s.mean().unwrap());
    }

    #[test]
    fn p90_p95_p99() {
        let mut s = RobustStats::new(20);
        for i in 1..=20 {
            s.observe(i as f64);
        }
        assert!((s.p90().unwrap() - 18.1).abs() < 0.2);
        assert!((s.p95().unwrap() - 19.05).abs() < 0.2);
        assert!((s.p99().unwrap() - 19.9).abs() < 0.2);
    }
}
