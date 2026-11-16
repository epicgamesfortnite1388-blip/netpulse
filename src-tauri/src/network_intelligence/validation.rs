// Statistical validation metrics for the NANI engine.
//
// Brier score, log loss, and expected calibration error measure whether
// predicted probabilities match observed frequencies. A model predicting
// 90% success should achieve approximately 90% success among comparable
// predictions — calibration is what separates a trustworthy predictor from
// a confidently wrong one.
//
// All metrics work on (predicted_probability, observed_outcome) pairs where
// outcome is 0 or 1. Missing predictions are excluded, never treated as 0.5.

use crate::network_intelligence::math::{clamp_probability, log_sum_exp};

/// A single prediction-outcome pair for validation.
#[derive(Debug, Clone, Copy)]
pub struct Prediction {
    /// Predicted probability of success (0..1).
    pub p: f64,
    /// Observed outcome: 1.0 = success, 0.0 = failure.
    pub y: f64,
}

impl Prediction {
    pub fn new(p: f64, y: f64) -> Option<Self> {
        if !p.is_finite() || !y.is_finite() {
            return None;
        }
        if y != 0.0 && y != 1.0 {
            return None;
        }
        Some(Self {
            p: clamp_probability(p),
            y,
        })
    }
}

/// Brier score: mean squared error of predicted probabilities vs outcomes.
///
/// BS = (1/N) * sum((p_i - y_i)^2). Lower is better; 0 is perfect, 0.25 is
/// the score of always predicting 0.5 on balanced data.
///
/// Returns `None` for empty input.
pub fn brier_score(predictions: &[Prediction]) -> Option<f64> {
    if predictions.is_empty() {
        return None;
    }
    let mut acc = 0.0;
    for pr in predictions {
        let diff = pr.p - pr.y;
        acc += diff * diff;
    }
    Some(acc / predictions.len() as f64)
}

/// Log loss (negative log-likelihood): -(1/N) * sum[y*log(p) + (1-y)*log(1-p)].
///
/// Lower is better. A confident wrong prediction (p≈0, y=1) is heavily
/// penalized. Returns `None` for empty input or if any p is exactly 0/1 with
/// a mismatched outcome (infinite loss).
pub fn log_loss(predictions: &[Prediction]) -> Option<f64> {
    if predictions.is_empty() {
        return None;
    }
    let mut acc = 0.0_f64;
    for pr in predictions {
        let p = clamp_probability(pr.p); // avoid log(0)
        if pr.y == 1.0 {
            acc += p.ln();
        } else {
            acc += (1.0 - p).ln();
        }
    }
    Some(-acc / predictions.len() as f64)
}

/// Expected Calibration Error (ECE): difference between predicted
/// probabilities and observed frequencies across M probability bins.
///
/// ECE = sum_m (|B_m| / N) * |avg_confidence(B_m) - accuracy(B_m)|
///
/// Returns `None` for empty input.
pub fn expected_calibration_error(predictions: &[Prediction], n_bins: usize) -> Option<f64> {
    if predictions.is_empty() || n_bins == 0 {
        return None;
    }
    let n_bins = n_bins.min(20).max(1);
    let mut bin_counts: Vec<usize> = vec![0; n_bins];
    let mut bin_conf_sums: Vec<f64> = vec![0.0; n_bins];
    let mut bin_correct_sums: Vec<f64> = vec![0.0; n_bins];

    for pr in predictions {
        let bin = ((pr.p * n_bins as f64).floor() as usize).min(n_bins - 1);
        bin_counts[bin] += 1;
        bin_conf_sums[bin] += pr.p;
        bin_correct_sums[bin] += pr.y;
    }

    let total = predictions.len() as f64;
    let mut ece = 0.0;
    for m in 0..n_bins {
        if bin_counts[m] == 0 {
            continue;
        }
        let avg_conf = bin_conf_sums[m] / bin_counts[m] as f64;
        let accuracy = bin_correct_sums[m] / bin_counts[m] as f64;
        let weight = bin_counts[m] as f64 / total;
        ece += weight * (avg_conf - accuracy).abs();
    }
    Some(ece)
}

/// Maximum calibration error: the worst per-bin gap (not weighted by bin size).
/// Useful for spotting a single badly calibrated probability range.
pub fn maximum_calibration_error(predictions: &[Prediction], n_bins: usize) -> Option<f64> {
    if predictions.is_empty() || n_bins == 0 {
        return None;
    }
    let n_bins = n_bins.min(20).max(1);
    let mut bin_counts: Vec<usize> = vec![0; n_bins];
    let mut bin_conf_sums: Vec<f64> = vec![0.0; n_bins];
    let mut bin_correct_sums: Vec<f64> = vec![0.0; n_bins];

    for pr in predictions {
        let bin = ((pr.p * n_bins as f64).floor() as usize).min(n_bins - 1);
        bin_counts[bin] += 1;
        bin_conf_sums[bin] += pr.p;
        bin_correct_sums[bin] += pr.y;
    }

    let mut max_gap = 0.0;
    for m in 0..n_bins {
        if bin_counts[m] == 0 {
            continue;
        }
        let avg_conf = bin_conf_sums[m] / bin_counts[m] as f64;
        let accuracy = bin_correct_sums[m] / bin_counts[m] as f64;
        let gap = (avg_conf - accuracy).abs();
        if gap > max_gap {
            max_gap = gap;
        }
    }
    Some(max_gap)
}

/// Comprehensive calibration report.
#[derive(Debug, Clone)]
pub struct CalibrationReport {
    pub n_predictions: usize,
    pub brier_score: f64,
    pub log_loss: f64,
    pub ece: f64,
    pub max_calibration_error: f64,
    /// Mean predicted probability.
    pub mean_predicted: f64,
    /// Observed success rate.
    pub observed_rate: f64,
}

impl CalibrationReport {
    pub fn compute(predictions: &[Prediction], n_bins: usize) -> Option<Self> {
        if predictions.is_empty() {
            return None;
        }
        let bs = brier_score(predictions)?;
        let ll = log_loss(predictions)?;
        let ece = expected_calibration_error(predictions, n_bins)?;
        let mce = maximum_calibration_error(predictions, n_bins)?;
        let mean_pred: f64 = predictions.iter().map(|pr| pr.p).sum::<f64>() / predictions.len() as f64;
        let obs_rate: f64 = predictions.iter().map(|pr| pr.y).sum::<f64>() / predictions.len() as f64;
        Some(Self {
            n_predictions: predictions.len(),
            brier_score: bs,
            log_loss: ll,
            ece,
            max_calibration_error: mce,
            mean_predicted: mean_pred,
            observed_rate: obs_rate,
        })
    }
}

/// Post-hoc calibration by temperature scaling.
///
/// `p' = sigmoid(logit(p) / T)`. `T` is fitted by minimizing log loss on
/// (prediction, outcome) samples that must not be the ones used to measure the
/// result. The transform is monotone, so it changes how much confidence a
/// posterior claims without reordering the hypotheses.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TemperatureScaling {
    temperature: f64,
}

impl TemperatureScaling {
    /// Identity transform (T = 1): applies no correction.
    pub fn identity() -> Self {
        Self { temperature: 1.0 }
    }

    /// The fitted temperature. `T > 1` means the raw predictions were
    /// overconfident and are being shrunk; `T < 1` means the opposite.
    pub fn temperature(&self) -> f64 {
        self.temperature
    }

    /// Fit `T` by minimizing mean log loss over `samples`.
    ///
    /// Returns the identity when there is nothing to learn from: an empty set,
    /// or outcomes that are all the same (log loss is then minimized at an
    /// extreme `T`, so any fitted value would be noise, not calibration).
    pub fn fit(samples: &[Prediction]) -> Self {
        let positives = samples.iter().filter(|p| p.y == 1.0).count();
        if samples.len() < 2 || positives == 0 || positives == samples.len() {
            return Self::identity();
        }

        // Coarse log-spaced sweep (0.2..5.0), then a bounded ternary refine
        // around the best point: deterministic, dependency-free, and unable to
        // wander into the flat tails where T -> 0 or T -> infinity.
        let steps = 120usize;
        let mut best_t = 1.0;
        let mut best = f64::INFINITY;
        for i in 0..=steps {
            let t = 0.2 * 25.0_f64.powf(i as f64 / steps as f64);
            let nll = mean_log_loss_at(samples, t);
            if nll < best {
                best = nll;
                best_t = t;
            }
        }

        let mut lo = (best_t / 1.25).max(0.05);
        let mut hi = (best_t * 1.25).min(20.0);
        for _ in 0..60 {
            let a = lo + (hi - lo) / 3.0;
            let b = hi - (hi - lo) / 3.0;
            if mean_log_loss_at(samples, a) <= mean_log_loss_at(samples, b) {
                hi = b;
            } else {
                lo = a;
            }
        }
        let refined = (lo + hi) / 2.0;
        let temperature = if mean_log_loss_at(samples, refined) <= best {
            refined
        } else {
            best_t
        };
        Self { temperature }
    }

    /// Calibrated probability for a raw prediction: `sigmoid(logit(p) / T)`.
    ///
    /// Monotone in `p` for any fixed `T > 0`, so it reshapes confidence without
    /// reordering hypotheses.
    pub fn apply(&self, p: f64) -> f64 {
        let p = clamp_probability(p);
        if !self.temperature.is_finite() || (self.temperature - 1.0).abs() < f64::EPSILON {
            return p;
        }
        let logit = (p / (1.0 - p)).ln();
        crate::network_intelligence::math::sigmoid(logit / self.temperature)
    }

    /// Apply the transform to every sample, keeping the outcomes.
    pub fn apply_all(&self, samples: &[Prediction]) -> Vec<Prediction> {
        samples
            .iter()
            .filter_map(|s| Prediction::new(self.apply(s.p), s.y))
            .collect()
    }
}

/// Post-hoc calibration by isotonic regression (pool-adjacent-violators).
///
/// Temperature scaling assumes one global direction of miscalibration. This
/// engine's errors are structural instead: some confidence ranges are too high
/// and others too low at the same time, which a single scale factor cannot fix
/// and can make worse. Isotonic regression fits the best monotone map from raw
/// confidence to observed frequency, so a 40% claim that is right half the time
/// is corrected upward while a 90% claim that is right 60% of the time is
/// corrected downward.
#[derive(Debug, Clone, PartialEq)]
pub struct IsotonicCalibrator {
    /// Sorted (raw confidence, calibrated confidence) knots.
    knots: Vec<(f64, f64)>,
}

impl IsotonicCalibrator {
    /// Identity: no correction.
    pub fn identity() -> Self {
        Self { knots: Vec::new() }
    }

    pub fn is_identity(&self) -> bool {
        self.knots.is_empty()
    }

    /// Fit the monotone map with weighted PAVA.
    ///
    /// Fewer than two distinct confidences, or a single outcome value, leave
    /// nothing to fit: the identity is returned rather than a step that would
    /// read as knowledge.
    pub fn fit(samples: &[Prediction]) -> Self {
        let positives = samples.iter().filter(|s| s.y == 1.0).count();
        if samples.len() < 2 || positives == 0 || positives == samples.len() {
            return Self::identity();
        }
        let mut sorted: Vec<Prediction> = samples.to_vec();
        sorted.sort_by(|a, b| a.p.partial_cmp(&b.p).unwrap_or(std::cmp::Ordering::Equal));

        // Each block keeps its own x values so a merged block can be placed at
        // the mean confidence it actually covers.
        struct Block {
            xs: Vec<f64>,
            sum_y: f64,
        }
        impl Block {
            fn mean_y(&self) -> f64 {
                self.sum_y / self.xs.len() as f64
            }
            fn mean_x(&self) -> f64 {
                self.xs.iter().sum::<f64>() / self.xs.len() as f64
            }
        }

        let mut blocks: Vec<Block> = Vec::new();
        for s in &sorted {
            blocks.push(Block {
                xs: vec![s.p],
                sum_y: s.y,
            });
            while blocks.len() > 1 {
                let last = blocks.len() - 1;
                if blocks[last - 1].mean_y() <= blocks[last].mean_y() {
                    break;
                }
                let rhs = blocks.pop().expect("non-empty");
                let lhs = blocks.pop().expect("non-empty");
                let mut xs = lhs.xs;
                xs.extend(rhs.xs);
                blocks.push(Block {
                    xs,
                    sum_y: lhs.sum_y + rhs.sum_y,
                });
            }
        }

        // Shrink each block toward the base rate with a small Beta prior. A
        // block with 0 hits out of 3 must not claim certainty: unsmoothed
        // isotonic produces exactly 0/1 and makes log loss explode on the very
        // samples it was supposed to fix. Shrinking by the same base rate for
        // every block keeps the fitted map monotone.
        let base_rate = positives as f64 / samples.len() as f64;
        let prior_weight = 2.0;
        let knots: Vec<(f64, f64)> = blocks
            .iter()
            .map(|b| {
                let n = b.xs.len() as f64;
                let smoothed = (b.sum_y + prior_weight * base_rate) / (n + prior_weight);
                (b.mean_x().clamp(0.0, 1.0), smoothed.clamp(0.0, 1.0))
            })
            .collect();
        Self { knots }
    }

    /// Calibrated confidence for `p`, interpolating between fitted knots and
    /// clamping outside them.
    pub fn apply(&self, p: f64) -> f64 {
        let p = clamp_probability(p);
        if self.knots.is_empty() {
            return p;
        }
        let first = self.knots[0];
        if p <= first.0 {
            return first.1;
        }
        let last = self.knots[self.knots.len() - 1];
        if p >= last.0 {
            return last.1;
        }
        for pair in self.knots.windows(2) {
            let (x0, y0) = pair[0];
            let (x1, y1) = pair[1];
            if p >= x0 && p <= x1 {
                if (x1 - x0).abs() < f64::EPSILON {
                    return y1;
                }
                let t = (p - x0) / (x1 - x0);
                return y0 + t * (y1 - y0);
            }
        }
        last.1
    }

    /// Apply the map to every sample, keeping the outcomes.
    pub fn apply_all(&self, samples: &[Prediction]) -> Vec<Prediction> {
        samples
            .iter()
            .filter_map(|s| Prediction::new(self.apply(s.p), s.y))
            .collect()
    }
}

fn mean_log_loss_at(samples: &[Prediction], temperature: f64) -> f64 {
    let scaler = TemperatureScaling { temperature };
    let mut acc = 0.0;
    for s in samples {
        let p = scaler.apply(s.p);
        acc += if s.y == 1.0 { p.ln() } else { (1.0 - p).ln() };
    }
    -acc / samples.len() as f64
}

/// Perfectly calibrated predictor: p_i == frequency of y_i in its bin.
/// ECE should be ~0, Brier score low.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brier_score_perfect_predictions_is_zero() {
        let preds = vec![
            Prediction::new(1.0, 1.0).unwrap(),
            Prediction::new(0.0, 0.0).unwrap(),
            Prediction::new(1.0, 1.0).unwrap(),
        ];
        assert!((brier_score(&preds).unwrap() - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn brier_score_always_half_on_balanced_is_quarter() {
        let preds = vec![
            Prediction::new(0.5, 1.0).unwrap(),
            Prediction::new(0.5, 0.0).unwrap(),
        ];
        assert!((brier_score(&preds).unwrap() - 0.25).abs() < f64::EPSILON);
    }

    #[test]
    fn brier_score_empty_returns_none() {
        assert!(brier_score(&[]).is_none());
    }

    #[test]
    fn log_loss_perfect_is_zero() {
        let preds = vec![
            Prediction::new(0.99, 1.0).unwrap(),
            Prediction::new(0.01, 0.0).unwrap(),
        ];
        let ll = log_loss(&preds).unwrap();
        assert!(ll < 0.1);
    }

    #[test]
    fn log_loss_confident_wrong_is_large() {
        let good = log_loss(&[Prediction::new(0.9, 1.0).unwrap()]).unwrap();
        let bad = log_loss(&[Prediction::new(0.1, 1.0).unwrap()]).unwrap();
        assert!(bad > good, "confident wrong should have higher loss");
    }

    #[test]
    fn ece_perfectly_calibrated_is_near_zero() {
        // 100 predictions at p=0.8, 80% succeed
        let mut preds = Vec::new();
        for _ in 0..80 {
            preds.push(Prediction::new(0.8, 1.0).unwrap());
        }
        for _ in 0..20 {
            preds.push(Prediction::new(0.8, 0.0).unwrap());
        }
        let ece = expected_calibration_error(&preds, 10).unwrap();
        assert!(ece < 0.05, "ECE should be near 0 for calibrated predictions, got {ece}");
    }

    #[test]
    fn ece_miscalibrated_is_high() {
        // Predict 0.9 but only 10% succeed
        let mut preds = Vec::new();
        for _ in 0..10 {
            preds.push(Prediction::new(0.9, 1.0).unwrap());
        }
        for _ in 0..90 {
            preds.push(Prediction::new(0.9, 0.0).unwrap());
        }
        let ece = expected_calibration_error(&preds, 10).unwrap();
        assert!(ece > 0.5, "miscalibrated predictions should have high ECE, got {ece}");
    }

    #[test]
    fn calibration_report_fields_make_sense() {
        let preds = vec![
            Prediction::new(0.9, 1.0).unwrap(),
            Prediction::new(0.9, 1.0).unwrap(),
            Prediction::new(0.1, 0.0).unwrap(),
            Prediction::new(0.1, 0.0).unwrap(),
        ];
        let report = CalibrationReport::compute(&preds, 4).unwrap();
        assert_eq!(report.n_predictions, 4);
        assert!((report.mean_predicted - 0.5).abs() < f64::EPSILON);
        assert!((report.observed_rate - 0.5).abs() < f64::EPSILON);
        assert!(report.brier_score >= 0.0);
        assert!(report.log_loss >= 0.0);
        assert!(report.ece >= 0.0);
        assert!(report.max_calibration_error >= 0.0);
    }

    #[test]
    fn empty_predictions_return_none_for_all_metrics() {
        assert!(brier_score(&[]).is_none());
        assert!(log_loss(&[]).is_none());
        assert!(expected_calibration_error(&[], 10).is_none());
        assert!(CalibrationReport::compute(&[], 10).is_none());
    }

    #[test]
    fn temperature_scaling_shrinks_overconfidence() {
        // Predictions claim 0.9 but only half of them are right.
        let mut samples = Vec::new();
        for i in 0..100 {
            samples.push(Prediction::new(0.9, if i % 2 == 0 { 1.0 } else { 0.0 }).unwrap());
        }
        let scaler = TemperatureScaling::fit(&samples);
        assert!(scaler.temperature() > 1.0, "T = {}", scaler.temperature());
        let calibrated = scaler.apply(0.9);
        assert!(calibrated < 0.9, "calibrated {calibrated} should shrink");
        assert!(calibrated > 0.5, "calibrated {calibrated} should stay above chance");
    }

    #[test]
    fn temperature_scaling_expands_underconfidence() {
        // Predictions claim 0.6 but nine in ten are right.
        let mut samples = Vec::new();
        for i in 0..100 {
            samples.push(Prediction::new(0.6, if i % 10 == 0 { 0.0 } else { 1.0 }).unwrap());
        }
        let scaler = TemperatureScaling::fit(&samples);
        assert!(scaler.temperature() < 1.0, "T = {}", scaler.temperature());
        assert!(scaler.apply(0.6) > 0.6);
    }

    #[test]
    fn temperature_scaling_reduces_fit_log_loss() {
        let mut samples = Vec::new();
        for i in 0..200 {
            let p = if i % 3 == 0 { 0.85 } else { 0.4 };
            samples.push(Prediction::new(p, if i % 4 == 0 { 0.0 } else { 1.0 }).unwrap());
        }
        let before = log_loss(&samples).unwrap();
        let scaler = TemperatureScaling::fit(&samples);
        let after = log_loss(&scaler.apply_all(&samples)).unwrap();
        assert!(after <= before, "log loss {before:.4} -> {after:.4}");
    }

    #[test]
    fn temperature_scaling_is_monotone() {
        let scaler = TemperatureScaling::fit(&[
            Prediction::new(0.8, 1.0).unwrap(),
            Prediction::new(0.8, 0.0).unwrap(),
            Prediction::new(0.3, 0.0).unwrap(),
        ]);
        let low = scaler.apply(0.2);
        let mid = scaler.apply(0.5);
        let high = scaler.apply(0.9);
        assert!(low < mid && mid < high, "{low} {mid} {high}");
    }

    #[test]
    fn temperature_scaling_identity_cases() {
        // No fitted temperature without both outcomes present.
        let all_hits = [Prediction::new(0.7, 1.0).unwrap()];
        assert_eq!(TemperatureScaling::fit(&all_hits).temperature(), 1.0);
        assert_eq!(TemperatureScaling::fit(&[]).temperature(), 1.0);
        // Identity leaves a prediction untouched and keeps 0/1 finite.
        let id = TemperatureScaling::identity();
        assert!((id.apply(0.37) - 0.37).abs() < 1e-12);
        assert!(id.apply(0.0).is_finite() && id.apply(1.0).is_finite());
    }

    #[test]
    fn isotonic_reduces_ece_on_structurally_miscalibrated_data() {
        // Low confidence is too low and high confidence is too high at the same
        // time: no single temperature can fix this, a monotone map can.
        let mut samples = Vec::new();
        for i in 0..200 {
            // 0.2 claimed, 60% correct
            samples.push(Prediction::new(0.2, if i % 10 < 6 { 1.0 } else { 0.0 }).unwrap());
            // 0.9 claimed, 60% correct
            samples.push(Prediction::new(0.9, if i % 10 < 6 { 1.0 } else { 0.0 }).unwrap());
        }
        let before = expected_calibration_error(&samples, 10).unwrap();
        let calibrated = IsotonicCalibrator::fit(&samples).apply_all(&samples);
        let after = expected_calibration_error(&calibrated, 10).unwrap();
        assert!(after < before * 0.5, "ECE {before:.3} -> {after:.3}");
        assert!(after < 0.15, "still miscalibrated: {after:.3}");
    }

    #[test]
    fn isotonic_is_monotone_and_smoothed() {
        let mut samples = Vec::new();
        for i in 0..90 {
            samples.push(Prediction::new(0.1, if i < 6 { 1.0 } else { 0.0 }).unwrap());
            samples.push(Prediction::new(0.6, if i < 45 { 1.0 } else { 0.0 }).unwrap());
            samples.push(Prediction::new(0.95, if i < 80 { 1.0 } else { 0.0 }).unwrap());
        }
        let cal = IsotonicCalibrator::fit(&samples);
        let mut previous = 0.0;
        for i in 0..=100 {
            let p = i as f64 / 100.0;
            let mapped = cal.apply(p);
            assert!(mapped >= previous - 1e-12, "not monotone at {p}");
            // Never claims certainty: the very low block has 6/90 hits.
            assert!(mapped > 0.0 && mapped < 1.0, "mapped {mapped} at {p}");
            previous = mapped;
        }
    }

    #[test]
    fn isotonic_identity_without_both_outcomes() {
        assert!(IsotonicCalibrator::fit(&[]).is_identity());
        assert!(IsotonicCalibrator::fit(&[Prediction::new(0.5, 1.0).unwrap()]).is_identity());
        let all_miss = [
            Prediction::new(0.5, 0.0).unwrap(),
            Prediction::new(0.7, 0.0).unwrap(),
        ];
        assert!(IsotonicCalibrator::fit(&all_miss).is_identity());
        // Identity passes values through unchanged, including the endpoints.
        let id = IsotonicCalibrator::identity();
        assert!((id.apply(0.42) - 0.42).abs() < 1e-12);
        assert!(id.apply(0.0).is_finite() && id.apply(1.0).is_finite());
    }

    #[test]
    fn isotonic_clamps_outside_its_fitted_range() {
        let samples = [
            Prediction::new(0.3, 1.0).unwrap(),
            Prediction::new(0.3, 0.0).unwrap(),
            Prediction::new(0.8, 1.0).unwrap(),
            Prediction::new(0.8, 1.0).unwrap(),
        ];
        let cal = IsotonicCalibrator::fit(&samples);
        let low = cal.apply(0.01);
        let high = cal.apply(0.99);
        assert!(low <= high, "{low} > {high}");
        assert!(low.is_finite() && high.is_finite());
    }

    #[test]
    fn prediction_rejects_invalid_outcome() {
        assert!(Prediction::new(0.5, 0.5).is_none());
        assert!(Prediction::new(0.5, 2.0).is_none());
        assert!(Prediction::new(f64::NAN, 1.0).is_none());
    }
}

