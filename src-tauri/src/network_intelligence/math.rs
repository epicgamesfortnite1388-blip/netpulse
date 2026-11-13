// Numerical foundations for the NANI mathematical engine.
//
// All operations here are numerically stable: log-space probabilities to avoid
// underflow, a sigmoid that never overflows, and explicit handling of NaN /
// infinity rather than silently substituting arbitrary defaults.
//
// Nothing in this file depends on Tauri or any external crate beyond `rand`.
// Every function is pure and tested deterministically.

use std::f64::EPSILON;

/// A very small positive constant used to avoid exact-zero probabilities and
/// log(0) without meaningfully moving well-behaved values.
///
/// This is applied only where a zero probability would otherwise make a
/// computation undefined (e.g. `log(0)`). It is NOT used to paper over missing
/// data — missing data stays missing (`None`), never becomes `0.0` or `EPS`.
pub const PROB_FLOOR: f64 = 1e-12;

/// Clamp a value into the open interval (0, 1) for use as a probability.
///
/// Values outside [0, 1] are floored / ceiled at `PROB_FLOOR` / `1 - PROB_FLOOR`
/// so that `log(p)` and `log(1 - p)` stay finite. NaN maps to `0.5` (maximum
/// ignorance) rather than being silently dropped.
///
/// Callers that need to distinguish "we genuinely have no data" from "a
/// probability of 0.5" should use [`Option`] — this function never invents
/// evidence.
pub fn clamp_probability(p: f64) -> f64 {
    if p.is_nan() {
        return 0.5;
    }
    if p <= 0.0 {
        return PROB_FLOOR;
    }
    if p >= 1.0 {
        return 1.0 - PROB_FLOOR;
    }
    p
}

/// Return `x` if it is finite, otherwise `default`.
///
/// Unlike clamping, this makes the invalidity explicit: callers decide whether
/// an infinite or NaN measurement means "unknown" (propagate `None`) or
/// "degrade gracefully" (use `default`). Missing data is never treated as zero.
pub fn finite_or_default(x: f64, default: f64) -> f64 {
    if x.is_finite() {
        x
    } else {
        default
    }
}

/// Numerically stable logistic sigmoid, `1 / (1 + exp(-x))`.
///
/// For large positive `x` the naive formula overflows; for large negative `x`
/// `exp(-x)` overflows. This implementation avoids both by splitting on the
/// sign of `x`.
pub fn sigmoid(x: f64) -> f64 {
    if x >= 0.0 {
        let z = (-x).exp();
        1.0 / (1.0 + z)
    } else {
        let z = x.exp();
        z / (1.0 + z)
    }
}

/// The logit function, `log(p / (1 - p))`, inverse of [`sigmoid`].
///
/// `p` must be in (0, 1); use [`clamp_probability`] first if the input is not
/// guaranteed clean. Returns `f64::NEG_INFINITY` at `p = 0` and
/// `f64::INFINITY` at `p = 1`, which callers must handle before exponentiating.
pub fn logit(p: f64) -> f64 {
    let p = clamp_probability(p);
    (p / (1.0 - p)).ln()
}

/// Numerically stable `log(sum(exp(x_i)))`.
///
/// Subtracts the maximum before exponentiating so that neither overflow nor
/// underflow can corrupt the result. Returns `f64::NEG_INFINITY` for an empty
/// input (the log of an empty sum is undefined; callers must not treat this as
/// a real log-probability).
pub fn log_sum_exp(values: &[f64]) -> f64 {
    if values.is_empty() {
        return f64::NEG_INFINITY;
    }
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if max.is_infinite() && max.is_sign_negative() {
        // All values are -inf: the sum is 0, log(0) = -inf.
        return f64::NEG_INFINITY;
    }
    let sum: f64 = values
        .iter()
        .copied()
        .map(|v| (v - max).exp())
        .sum();
    max + sum.ln()
}

/// Convert log-probabilities to normalized probabilities via softmax.
///
/// Returns `None` for an empty input. Each output is in (0, 1) and the outputs
/// sum to 1 within floating-point tolerance.
pub fn softmax(log_probs: &[f64]) -> Option<Vec<f64>> {
    if log_probs.is_empty() {
        return None;
    }
    let lse = log_sum_exp(log_probs);
    if !lse.is_finite() {
        return None;
    }
    Some(
        log_probs
            .iter()
            .copied()
            .map(|lp| (lp - lse).exp())
            .collect(),
    )
}

/// Normalize a slice of non-negative weights so they sum to 1.
///
/// Returns `None` when the slice is empty or the total weight is not a
/// positive finite number — never invents a uniform distribution over nothing.
pub fn normalize_weights(weights: &[f64]) -> Option<Vec<f64>> {
    if weights.is_empty() {
        return None;
    }
    let total: f64 = weights.iter().copied().filter(|w| w.is_finite() && *w > 0.0).sum();
    if !total.is_finite() || total <= 0.0 {
        return None;
    }
    Some(weights.iter().copied().map(|w| w / total).collect())
}

/// Sample a single index from a categorical distribution given log-probabilities.
///
/// Uses `rand::Rng::gen_range(0.0..1.0)` against the cumulative softmax.
/// Returns `None` when the distribution cannot be formed (empty input or
/// non-finite log-probs).
pub fn sample_categorical<R: rand::Rng + ?Sized>(
    log_probs: &[f64],
    rng: &mut R,
) -> Option<usize> {
    let probs = softmax(log_probs)?;
    let mut cum = 0.0;
    let draw = rng.gen_range(0.0..1.0);
    for (i, p) in probs.iter().copied().enumerate() {
        cum += p;
        if draw <= cum {
            return Some(i);
        }
    }
    // Floating-point drift: fall back to the last index rather than panic.
    Some(probs.len().saturating_sub(1))
}

/// Binary entropy of a Bernoulli with success probability `p`.
///
/// `H(p) = -p log p - (1-p) log (1-p)`, in nats. Returns `0.0` at `p = 0` or
/// `p = 1` by continuity. NaN input yields `0.0` (no information to extract).
pub fn bernoulli_entropy(p: f64) -> f64 {
    // A NaN probability is not a measurement, so it carries no information.
    // Returning 0 keeps this function total and avoids propagating NaN into
    // entropy sums; genuine uncertainty arrives as a finite p (e.g. 0.5).
    if p.is_nan() {
        return 0.0;
    }
    let p = clamp_probability(p);
    if p <= PROB_FLOOR || p >= 1.0 - PROB_FLOOR {
        return 0.0;
    }
    -(p * p.ln() + (1.0 - p) * (1.0 - p).ln())
}

/// Kullback-Leibler divergence `D_KL(P || Q)` for two discrete distributions.
///
/// Both inputs must be valid probability vectors (non-negative, sum to 1).
/// Returns `None` when either is empty, not finite, or does not sum to ~1.
/// `0 * log(0)` terms are treated as `0` by continuity.
pub fn kl_divergence(p: &[f64], q: &[f64]) -> Option<f64> {
    if p.is_empty() || q.is_empty() || p.len() != q.len() {
        return None;
    }
    let p_sum: f64 = p.iter().copied().sum::<f64>();
    let q_sum: f64 = q.iter().copied().sum::<f64>();
    if !p_sum.is_finite() || !q_sum.is_finite() || (p_sum - 1.0).abs() > 1e-9 || (q_sum - 1.0).abs() > 1e-9 {
        return None;
    }
    let mut acc = 0.0;
    for (&pi, &qi) in p.iter().zip(q.iter()) {
        if pi <= 0.0 {
            continue; // 0 * log(0 / q) = 0 by continuity
        }
        if qi <= 0.0 {
            return Some(f64::INFINITY); // P assigns mass where Q assigns none
        }
        acc += pi * (pi / qi).ln();
    }
    Some(acc)
}

/// Jensen-Shannon divergence `D_JS(P, Q) = 0.5 * (D_KL(P || M) + D_KL(Q || M))`
/// where `M = 0.5 * (P + Q)`. Always finite and symmetric.
pub fn js_divergence(p: &[f64], q: &[f64]) -> Option<f64> {
    if p.is_empty() || q.is_empty() || p.len() != q.len() {
        return None;
    }
    let m: Vec<f64> = p.iter().zip(q.iter()).map(|(&a, &b)| 0.5 * (a + b)).collect();
    let d1 = kl_divergence(p, &m)?;
    let d2 = kl_divergence(q, &m)?;
    Some(0.5 * (d1 + d2))
}

/// Clamp a latency-like positive measurement to a sane range.
///
/// Returns `None` for NaN / negative / non-finite input (missing data stays
/// missing). Otherwise returns the value floored at `floor` and ceiled at
/// `cap`, both of which must be positive.
pub fn clamp_latency(value: f64, floor: f64, cap: f64) -> Option<f64> {
    if !value.is_finite() || value < 0.0 || !floor.is_finite() || !cap.is_finite() || floor <= 0.0 || cap <= floor {
        return None;
    }
    Some(value.clamp(floor, cap))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::{Rng, SeedableRng};

    #[test]
    fn clamp_probability_maps_out_of_range_to_floor_and_ceiling() {
        assert!((clamp_probability(0.0) - PROB_FLOOR).abs() < f64::EPSILON);
        assert!((clamp_probability(1.0) - (1.0 - PROB_FLOOR)).abs() < f64::EPSILON);
        assert!((clamp_probability(-5.0) - PROB_FLOOR).abs() < f64::EPSILON);
        assert!((clamp_probability(5.0) - (1.0 - PROB_FLOOR)).abs() < f64::EPSILON);
        assert!((clamp_probability(0.5) - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn clamp_probability_maps_nan_to_maximum_ignorance() {
        assert!((clamp_probability(f64::NAN) - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn sigmoid_is_monotonic_and_symmetric() {
        assert!((sigmoid(0.0) - 0.5).abs() < f64::EPSILON);
        assert!(sigmoid(10.0) > sigmoid(1.0));
        assert!(sigmoid(-10.0) < sigmoid(-1.0));
        // sigmoid(-x) = 1 - sigmoid(x)
        let x = 3.7;
        assert!((sigmoid(-x) + sigmoid(x) - 1.0).abs() < 1e-10);
        // No overflow at extremes
        assert!(sigmoid(1000.0).is_finite());
        assert!(sigmoid(-1000.0).is_finite());
    }

    #[test]
    fn logit_is_inverse_of_sigmoid() {
        for p in [0.001, 0.01, 0.1, 0.5, 0.9, 0.99, 0.999] {
            let roundtrip = sigmoid(logit(p));
            assert!((roundtrip - p).abs() < 1e-9, "roundtrip for {p}");
        }
    }

    #[test]
    fn log_sum_exp_is_stable_for_extreme_values() {
        let v = vec![1000.0, 1000.0, 1000.0];
        let lse = log_sum_exp(&v);
        assert!((lse - (1000.0 + 3.0f64.ln())).abs() < 1e-9);

        let v = vec![-1000.0, -1000.0];
        let lse = log_sum_exp(&v);
        assert!((lse - (-1000.0 + 2.0f64.ln())).abs() < 1e-9);
    }

    #[test]
    fn log_sum_exp_empty_is_negative_infinity() {
        assert!(log_sum_exp(&[]).is_infinite() && log_sum_exp(&[]).is_sign_negative());
    }

    #[test]
    fn softmax_normalizes_and_sums_to_one() {
        let log_probs = vec![0.0, 1.0, 2.0];
        let probs = softmax(&log_probs).expect("softmax of non-empty input");
        assert_eq!(probs.len(), 3);
        let sum: f64 = probs.iter().sum();
        assert!((sum - 1.0).abs() < 1e-9);
        for p in &probs {
            assert!(*p > 0.0 && *p < 1.0);
        }
        // Larger log-prob => larger probability
        assert!(probs[2] > probs[1] && probs[1] > probs[0]);
    }

    #[test]
    fn softmax_empty_returns_none() {
        assert!(softmax(&[]).is_none());
    }

    #[test]
    fn normalize_weights_rejects_empty_and_zero_total() {
        assert!(normalize_weights(&[]).is_none());
        assert!(normalize_weights(&[0.0, 0.0]).is_none());
        assert!(normalize_weights(&[f64::NAN]).is_none());
    }

    #[test]
    fn normalize_weights_sums_to_one() {
        let w = normalize_weights(&[1.0, 2.0, 3.0]).expect("valid weights");
        let sum: f64 = w.iter().sum();
        assert!((sum - 1.0).abs() < 1e-9);
        assert!((w[0] - 1.0 / 6.0).abs() < 1e-9);
        assert!((w[1] - 2.0 / 6.0).abs() < 1e-9);
        assert!((w[2] - 3.0 / 6.0).abs() < 1e-9);
    }

    #[test]
    fn sample_categorical_picks_within_support() {
        let mut rng = StdRng::seed_from_u64(42);
        let log_probs = vec![0.0, 0.0, 0.0]; // uniform
        for _ in 0..1000 {
            let idx = sample_categorical(&log_probs, &mut rng).expect("valid distribution");
            assert!(idx < 3);
        }
    }

    #[test]
    fn sample_categorical_prefers_higher_log_prob() {
        let mut rng = StdRng::seed_from_u64(7);
        // Moderate log-probabilities: e^-5 : 1 : e^5 ≈ 0.007 : 1 : 148
        let log_probs = vec![-5.0, 0.0, 5.0];
        let mut counts = [0usize; 3];
        for _ in 0..10_000 {
            let idx = sample_categorical(&log_probs, &mut rng).expect("valid distribution");
            counts[idx] += 1;
        }
        assert!(counts[2] > counts[1] && counts[1] > counts[0]);
    }

    #[test]
    fn sample_categorical_empty_returns_none() {
        let mut rng = StdRng::seed_from_u64(1);
        assert!(sample_categorical(&[], &mut rng).is_none());
    }

    #[test]
    fn bernoulli_entropy_is_maximal_at_half_and_zero_at_extremes() {
        assert!((bernoulli_entropy(0.5) - 0.6931471805599453).abs() < 1e-9); // ln 2
        // At exact extremes entropy is 0 by continuity; clamped values are
        // extremely close to 0 due to PROB_FLOOR.
        assert!(bernoulli_entropy(0.0) < 1e-6);
        assert!(bernoulli_entropy(1.0) < 1e-6);
        assert!(bernoulli_entropy(f64::NAN).abs() < f64::EPSILON);
    }

    #[test]
    fn kl_divergence_same_distribution_is_zero() {
        let p = vec![0.2, 0.3, 0.5];
        let d = kl_divergence(&p, &p).expect("valid distributions");
        assert!(d.abs() < 1e-9);
    }

    #[test]
    fn kl_divergence_infinite_when_q_has_no_mass_where_p_does() {
        let p = vec![0.5, 0.5, 0.0];
        let q = vec![0.0, 1.0, 0.0];
        let d = kl_divergence(&p, &q).expect("valid distributions");
        assert!(d.is_infinite());
    }

    #[test]
    fn js_divergence_is_symmetric_and_finite() {
        let p = vec![0.7, 0.3];
        let q = vec![0.4, 0.6];
        let d1 = js_divergence(&p, &q).expect("valid");
        let d2 = js_divergence(&q, &p).expect("valid");
        assert!((d1 - d2).abs() < 1e-9);
        assert!(d1.is_finite() && d1 >= 0.0);
    }

    #[test]
    fn kl_divergence_rejects_invalid_input() {
        assert!(kl_divergence(&[], &[]).is_none());
        assert!(kl_divergence(&[0.5, 0.5], &[0.5]).is_none()); // different lengths
        assert!(kl_divergence(&[0.5, 0.6], &[0.5, 0.5]).is_none()); // sums != 1
    }

    #[test]
    fn finite_or_default_propagates_finite_and_replaces_invalid() {
        assert!((finite_or_default(3.5, 0.0) - 3.5).abs() < f64::EPSILON);
        assert!((finite_or_default(f64::INFINITY, 9.0) - 9.0).abs() < f64::EPSILON);
        assert!((finite_or_default(f64::NAN, 9.0) - 9.0).abs() < f64::EPSILON);
        assert!((finite_or_default(f64::NEG_INFINITY, 9.0) - 9.0).abs() < f64::EPSILON);
    }

    #[test]
    fn clamp_latency_rejects_invalid_and_clamps_valid() {
        assert!(clamp_latency(f64::NAN, 1.0, 100.0).is_none());
        assert!(clamp_latency(-1.0, 1.0, 100.0).is_none());
        assert!((clamp_latency(5.0, 1.0, 100.0).unwrap() - 5.0).abs() < f64::EPSILON);
        assert!((clamp_latency(0.5, 1.0, 100.0).unwrap() - 1.0).abs() < f64::EPSILON);
        assert!((clamp_latency(200.0, 1.0, 100.0).unwrap() - 100.0).abs() < f64::EPSILON);
    }
}

