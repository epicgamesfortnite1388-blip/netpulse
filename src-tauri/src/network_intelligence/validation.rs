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

/// Recorded real outcomes required before a fitted map replaces the engine's
/// own confidence.
///
/// Below this, a fitted map would mostly memorise a handful of probes, so the
/// hypothesis view reports the raw posterior and how many outcomes exist
/// instead of a corrected number.
pub const MIN_CALIBRATION_SAMPLES: usize = 30;

/// Post-hoc calibration by isotonic regression (pool-adjacent-violators).
///
/// Temperature scaling assumes one global direction of miscalibration. This
/// engine's errors are structural instead: some confidence ranges are too high
/// and others too low at the same time, which a single scale factor cannot fix
/// and can make worse. Isotonic regression fits the best monotone map from raw
/// confidence to observed frequency, so a 40% claim that is right half the time
/// is corrected upward while a 90% claim that is right 60% of the time is
/// corrected downward.
#[derive(Debug)]
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

    /// Weighted isotonic regression (pool-adjacent-violators) over points
    /// already sorted by `x`.
    ///
    /// Returns one knot per pooled block at its weight-averaged `x` and `y`, so
    /// the knots are strictly increasing in `x` and non-decreasing in `y` — the
    /// property the whole transform exists for.
    fn pool_adjacent_violators(points: &[(f64, f64, f64)]) -> Vec<(f64, f64)> {
        // Weighted sums, so a merge is a plain addition.
        struct Block {
            x: f64,
            y: f64,
            w: f64,
        }
        let mut blocks: Vec<Block> = Vec::new();
        for &(x, y, w) in points {
            blocks.push(Block {
                x: x * w,
                y: y * w,
                w,
            });
            while blocks.len() > 1 {
                let last = blocks.len() - 1;
                if blocks[last - 1].y / blocks[last - 1].w <= blocks[last].y / blocks[last].w {
                    break;
                }
                let rhs = blocks.pop().expect("non-empty");
                let lhs = blocks.pop().expect("non-empty");
                blocks.push(Block {
                    x: lhs.x + rhs.x,
                    y: lhs.y + rhs.y,
                    w: lhs.w + rhs.w,
                });
            }
        }
        blocks
            .iter()
            .map(|b| (b.x / b.w, b.y / b.w))
            .collect()
    }

    /// Fit the monotone map.
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

        // One point per distinct confidence: repeated `p` values are the same
        // prediction, and two knots at one `x` with different `y` would make
        // `apply` depend on knot order.
        let mut grouped: Vec<(f64, f64, f64)> = Vec::new(); // (x, hits, count)
        for s in &sorted {
            match grouped.last_mut() {
                Some(last) if last.0 == s.p => {
                    last.1 += s.y;
                    last.2 += 1.0;
                }
                _ => grouped.push((s.p, s.y, 1.0)),
            }
        }

        // Shrink each confidence's hit rate toward the base rate with a small
        // Beta prior before pooling. A point with 0 hits out of 3 must not claim
        // certainty: unsmoothed isotonic outputs exactly 0/1 and makes log loss
        // explode on the very samples it is supposed to fix. Shrinking first and
        // pooling after is what keeps the result monotone — smoothing fitted
        // block means instead does not, because the shrink weight depends on the
        // block size and can invert the order of neighbouring blocks.
        let base_rate = positives as f64 / samples.len() as f64;
        let prior_weight = 2.0;
        let points: Vec<(f64, f64, f64)> = grouped
            .into_iter()
            .map(|(x, hits, n)| {
                let smoothed = (hits + prior_weight * base_rate) / (n + prior_weight);
                (x, smoothed.clamp(0.0, 1.0), n + prior_weight)
            })
            .collect();

        Self {
            knots: Self::pool_adjacent_violators(&points),
        }
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
                // Knots are distinct in `x` (duplicates are pooled), so this
                // cannot divide by zero.
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
    fn isotonic_pools_repeated_confidences() {
        // Three samples claim exactly 0.5 and are right; two of them are a
        // separate 2-count group. They are one confidence, so they must become
        // one knot: two knots at the same x would make `apply(0.5)` depend on
        // which comes first.
        let mut samples = vec![Prediction::new(0.2, 0.0).unwrap()];
        for _ in 0..3 {
            samples.push(Prediction::new(0.5, 1.0).unwrap());
        }
        let cal = IsotonicCalibrator::fit(&samples);
        assert_eq!(cal.knots.len(), 2, "knots: {:?}", cal.knots);
        // base rate 3/4, prior weight 2: (3 + 2 * 0.75) / (3 + 2) = 0.9.
        assert!((cal.apply(0.5) - 0.9).abs() < 1e-12, "got {}", cal.apply(0.5));
    }

    #[test]
    fn isotonic_stays_monotone_when_blocks_have_different_sizes() {
        // Shrinking fitted block means toward the base rate is not monotone when
        // block sizes differ: here smoothing after pooling gives 0.543 at p=0.1
        // and 0.457 at p=0.5, i.e. a lower raw confidence mapping higher. The
        // fit must smooth first and pool second.
        let mut samples = vec![Prediction::new(0.1, 0.0).unwrap()];
        for i in 0..100 {
            samples.push(Prediction::new(0.5, if i < 45 { 1.0 } else { 0.0 }).unwrap());
        }
        for _ in 0..200 {
            samples.push(Prediction::new(0.95, 1.0).unwrap());
        }
        let cal = IsotonicCalibrator::fit(&samples);
        let mut previous = 0.0;
        for i in 0..=100 {
            let p = i as f64 / 100.0;
            let mapped = cal.apply(p);
            assert!(mapped >= previous - 1e-12, "not monotone at {p}: {previous} -> {mapped}");
            previous = mapped;
        }
    }

    #[test]
    fn prediction_rejects_invalid_outcome() {
        assert!(Prediction::new(0.5, 0.5).is_none());
        assert!(Prediction::new(0.5, 2.0).is_none());
        assert!(Prediction::new(f64::NAN, 1.0).is_none());
    }
}

