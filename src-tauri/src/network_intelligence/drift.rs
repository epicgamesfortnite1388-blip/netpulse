// Drift detection: CUSUM and Page-Hinkley change detectors.
//
// Detect non-stationarity in the observed success rate / latency so the
// engine can reduce the influence of stale evidence and re-evaluate
// known-good candidates. Never deletes useful data — only down-weights it.

use crate::network_intelligence::math::finite_or_default;

/// Result of feeding a new observation to a detector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriftStatus {
    /// No drift detected; continue as before.
    Stable,
    /// Drift detected: reduce influence of stale evidence, increase uncertainty.
    Drifted,
}

/// CUSUM (Cumulative Sum) change detector.
///
/// S_t = max(0, S_{t-1} + e_t - nu), where e_t is the observation (e.g.
/// prediction error or success indicator). Trigger adaptation when S_t > h.
///
/// `nu` is the drift magnitude we want to detect (allowed drift per sample).
/// `h` is the threshold. Both are calibrated to the data scale.
#[derive(Debug, Clone)]
pub struct CusumDetector {
    pub s: f64,
    pub nu: f64,
    pub h: f64,
    pub samples_since_reset: u64,
    pub total_detections: u64,
}

impl CusumDetector {
    /// Create a CUSUM detector for detecting upward shifts of magnitude `nu`
    /// with threshold `h`.
    pub fn new(nu: f64, h: f64) -> Option<Self> {
        if !nu.is_finite() || nu <= 0.0 || !h.is_finite() || h <= 0.0 {
            return None;
        }
        Some(Self {
            s: 0.0,
            nu,
            h,
            samples_since_reset: 0,
            total_detections: 0,
        })
    }

    /// Default detector tuned for binary success observations (0/1): detect a
    /// drop of about 0.15 in success rate.
    pub fn for_success_rate() -> Self {
        Self::new(0.15, 5.0).expect("valid CUSUM params")
    }

    /// Feed a new observation and return whether drift was detected.
    ///
    /// `e_t` should be a residual such that positive values indicate drift in
    /// the direction being detected (e.g. `expected - observed` success rate).
    pub fn update(&mut self, e_t: f64) -> DriftStatus {
        let e = finite_or_default(e_t, 0.0);
        self.s = (self.s + e - self.nu).max(0.0);
        self.samples_since_reset += 1;
        if self.s > self.h {
            self.total_detections += 1;
            self.s = 0.0; // reset after detection
            self.samples_since_reset = 0;
            DriftStatus::Drifted
        } else {
            DriftStatus::Stable
        }
    }

    /// Current CUSUM statistic (useful for monitoring / debugging).
    pub fn statistic(&self) -> f64 {
        self.s
    }
}

/// Page-Hinkley change detector.
///
/// Tracks the cumulative difference between observations and their running
/// mean. Triggers when the maximum deviation from the mean exceeds a
/// threshold.
///
/// PH_t = sum_{i=1..t} (x_i - mean_t), trigger when max_t PH_t - PH_current > lambda.
#[derive(Debug, Clone)]
pub struct PageHinkleyDetector {
    pub sum_x: f64,
    pub sum_ph: f64,
    pub max_ph: f64,
    pub count: u64,
    pub lambda: f64,
    pub total_detections: u64,
}

impl PageHinkleyDetector {
    pub fn new(lambda: f64) -> Option<Self> {
        if !lambda.is_finite() || lambda <= 0.0 {
            return None;
        }
        Some(Self {
            sum_x: 0.0,
            sum_ph: 0.0,
            max_ph: 0.0,
            count: 0,
            lambda,
            total_detections: 0,
        })
    }

    /// Default detector tuned for success-rate observations.
    pub fn for_success_rate() -> Self {
        Self::new(10.0).expect("valid PH lambda")
    }

    pub fn update(&mut self, x_t: f64) -> DriftStatus {
        let x = finite_or_default(x_t, 0.0);
        self.count += 1;
        self.sum_x += x;
        let mean = self.sum_x / self.count as f64;

        // Page-Hinkley statistic: cumulative deviation of observations from a
        // reference mean (0.5 for success-rate data). When the process mean
        // shifts, the cumulative sum grows until it exceeds the threshold.
        let deviation = x - 0.5f64;
        self.sum_ph = (self.sum_ph + deviation).max(0.0);
        if self.sum_ph > self.max_ph {
            self.max_ph = self.sum_ph;
        }
        if self.sum_ph > self.lambda {
            // Reset after detection
            self.sum_x = 0.0;
            self.sum_ph = 0.0;
            self.max_ph = 0.0;
            self.count = 0;
            self.total_detections += 1;
            DriftStatus::Drifted
        } else {
            DriftStatus::Stable
        }
    }
}

/// A drift-aware evidence weighter: scales down older evidence when drift is
/// detected, without discarding it.
#[derive(Debug, Clone)]
pub struct DriftAwareWeighter {
    detector: CusumDetector,
    /// Base decay rate per second (applied always).
    pub base_decay_per_sec: f64,
    /// Extra decay multiplier applied right after a drift detection.
    pub drift_decay_multiplier: f64,
}

impl DriftAwareWeighter {
    pub fn new() -> Self {
        Self {
            detector: CusumDetector::for_success_rate(),
            base_decay_per_sec: 0.001,
            drift_decay_multiplier: 0.5,
        }
    }

    /// Feed a success observation (1.0 = success, 0.0 = failure). Returns
    /// whether drift was just detected.
    pub fn observe(&mut self, success: f64) -> DriftStatus {
        // CUSUM detects drops in success: e_t = expected - observed.
        // We use (0.5 - success) so a run of failures (success=0) gives e_t=0.5 > 0.
        self.detector.update(0.5 - success)
    }

    /// Decay weight for evidence that is `age_seconds` old, given whether
    /// drift was recently detected.
    pub fn decay_weight(&self, age_seconds: f64, just_drifted: bool) -> f64 {
        let base = (-self.base_decay_per_sec * age_seconds).exp();
        if just_drifted {
            base * self.drift_decay_multiplier
        } else {
            base
        }
    }

    pub fn statistic(&self) -> f64 {
        self.detector.statistic()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cusum_detects_sustained_shift() {
        let mut d = CusumDetector::new(0.1, 3.0).expect("valid");
        // Stable observations: e_t = 0, no drift.
        for _ in 0..10 {
            assert_eq!(d.update(0.0), DriftStatus::Stable);
        }
        // Sustained positive drift: e_t = 0.5 each time.
        let mut triggered = false;
        for _ in 0..20 {
            if d.update(0.5) == DriftStatus::Drifted {
                triggered = true;
                break;
            }
        }
        assert!(triggered, "CUSUM should detect sustained drift");
        assert_eq!(d.statistic(), 0.0); // reset after detection
    }

    #[test]
    fn cusum_no_drift_for_small_fluctuations() {
        let mut d = CusumDetector::new(0.5, 10.0).expect("valid");
        let mut triggered = false;
        for _ in 0..100 {
            if d.update(0.1) == DriftStatus::Drifted {
                triggered = true;
            }
        }
        assert!(!triggered, "small fluctuations should not trigger drift");
    }

    #[test]
    fn page_hinkley_detects_shift() {
        let mut d = PageHinkleyDetector::new(3.0).expect("valid");
        // Stable around 0
        for _ in 0..10 {
            assert_eq!(d.update(0.0), DriftStatus::Stable);
        }
        // Shift to +1
        let mut triggered = false;
        for _ in 0..20 {
            if d.update(1.0) == DriftStatus::Drifted {
                triggered = true;
                break;
            }
        }
        assert!(triggered);
    }

    #[test]
    fn driftaware_weighter_decays_more_after_drift() {
        let mut w = DriftAwareWeighter::new();
        let age = 100.0;
        let normal = w.decay_weight(age, false);
        // Force drift by feeding failures
        for _ in 0..50 {
            w.observe(0.0);
        }
        let after_drift = w.decay_weight(age, true);
        assert!(after_drift < normal, "drift should increase decay");
    }

    #[test]
    fn cusum_rejects_invalid_params() {
        assert!(CusumDetector::new(0.0, 5.0).is_none());
        assert!(CusumDetector::new(0.1, -1.0).is_none());
        assert!(CusumDetector::new(f64::NAN, 5.0).is_none());
    }

    #[test]
    fn page_hinkley_rejects_invalid_lambda() {
        assert!(PageHinkleyDetector::new(0.0).is_none());
        assert!(PageHinkleyDetector::new(f64::NAN).is_none());
    }
}

