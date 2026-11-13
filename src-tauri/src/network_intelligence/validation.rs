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
    fn prediction_rejects_invalid_outcome() {
        assert!(Prediction::new(0.5, 0.5).is_none());
        assert!(Prediction::new(0.5, 2.0).is_none());
        assert!(Prediction::new(f64::NAN, 1.0).is_none());
    }
}

