//! NANI Phase 2 — Sequential decision-making and stopping criteria.

/// Expected information gain for a candidate test given current entropy and
/// expected posterior entropy. Cost-adjusted score for test selection.
pub fn cost_adjusted_gain(info_gain: f64, cost: f64, epsilon: f64) -> f64 {
    let eps = epsilon.max(1e-12);
    info_gain / (cost + eps)
}

/// Determine whether to stop testing: stop when the best remaining gain is
/// below the threshold or when confidence is already sufficient.
pub fn should_stop(best_gain: f64, gain_threshold: f64, confidence: f64, confidence_target: f64) -> bool {
    if confidence >= confidence_target {
        return true;
    }
    best_gain < gain_threshold
}

/// Value of information: expected reduction in loss from taking a measurement.
pub fn value_of_information(prior_loss: f64, expected_posterior_loss: f64, cost: f64) -> f64 {
    (prior_loss - expected_posterior_loss) - cost
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gain_prefers_low_cost() {
        let a = cost_adjusted_gain(1.0, 1.0, 1e-9);
        let b = cost_adjusted_gain(1.0, 5.0, 1e-9);
        assert!(a > b);
    }

    #[test]
    fn stops_when_confident() {
        assert!(should_stop(0.5, 0.1, 0.95, 0.9));
        assert!(!should_stop(0.5, 0.1, 0.5, 0.9));
    }

    #[test]
    fn stops_when_gain_too_low() {
        assert!(should_stop(0.01, 0.1, 0.5, 0.9));
    }

    #[test]
    fn voi_can_be_negative() {
        assert!(value_of_information(0.5, 0.4, 0.2) < 0.0);
    }
}
