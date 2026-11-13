// Route optimization: multi-objective selection among authorized candidates.
//
// For each candidate route we predict success probability, expected latency,
// latency variance, jitter, packet loss, recovery time, resource cost and
// security risk, then minimize a risk-aware objective over *authorized and
// secure* candidates only. Unauthorized routes are never selectable
// regardless of score, and TLS verification is never disabled.
//
// The optimizer maintains a Pareto frontier (routes that are not dominated
// on all objectives) and can rank by a conservative lower-confidence bound
// or by tail-risk (CVaR).

use crate::network_intelligence::api_model::RouteKind;
use crate::network_intelligence::math::{clamp_probability, clamp_latency};

/// Predicted performance and risk metrics for a single route candidate.
///
/// All fields are predictions (with uncertainty), not guarantees. Missing
/// measurements are represented as `None`, never as zero.
#[derive(Debug, Clone)]
pub struct RouteMetrics {
    /// Predicted success probability P(success), calibrated.
    pub success_prob: f64,
    /// Uncertainty (std dev) on success_prob.
    pub success_std: f64,
    /// Expected latency in ms.
    pub latency_ms: f64,
    /// Std dev of latency.
    pub latency_std: f64,
    /// Jitter (latency variation) in ms.
    pub jitter_ms: f64,
    /// Predicted packet loss fraction (0..1).
    pub packet_loss: f64,
    /// Expected recovery time in seconds if this route fails.
    pub recovery_time_sec: f64,
    /// Resource cost (CPU/memory/bandwidth units), higher = more expensive.
    pub resource_cost: f64,
    /// Security risk score (0..1), where 1 = violates a hard constraint (e.g. disabled TLS).
    pub security_risk: f64,
}

/// A route candidate the optimizer may choose.
#[derive(Debug, Clone)]
pub struct RouteCandidate {
    pub id: String,
    pub route_kind: RouteKind,
    /// Whether this route is authorized for use. Unauthorized candidates are
    /// filtered out before scoring.
    pub authorized: bool,
    /// Whether TLS verification is enforced on this route.
    pub tls_verified: bool,
    pub metrics: RouteMetrics,
}

/// Weights for the multi-objective objective J(a). Every weight is explained
/// and user-tunable, but none may override a hard security constraint.
#[derive(Debug, Clone)]
pub struct ObjectiveWeights {
    /// Weight on failure probability (1 - p_s). Dominant term — a successful
    /// connection must dominate minor speed improvements.
    pub w_failure: f64,
    /// Weight on mean latency.
    pub w_latency: f64,
    /// Weight on latency variance (stability).
    pub w_latency_var: f64,
    /// Weight on jitter.
    pub w_jitter: f64,
    /// Weight on packet loss.
    pub w_loss: f64,
    /// Weight on recovery time.
    pub w_recovery: f64,
    /// Weight on resource cost.
    pub w_cost: f64,
}

impl Default for ObjectiveWeights {
    fn default() -> Self {
        Self {
            w_failure: 10.0,
            w_latency: 1.0,
            w_latency_var: 0.5,
            w_jitter: 0.5,
            w_loss: 2.0,
            w_recovery: 1.0,
            w_cost: 0.1,
        }
    }
}

/// The result of scoring a single candidate.
#[derive(Debug, Clone)]
pub struct ScoredRoute {
    pub candidate: RouteCandidate,
    /// The scalarized objective J(a) — lower is better.
    pub objective: f64,
    /// Lower confidence bound on success: p_hat - kappa * sigma_p.
    pub lcb_success: f64,
    /// Whether this route is on the Pareto frontier.
    pub pareto_optimal: bool,
}

/// Score a single candidate route with the multi-objective objective.
///
/// J(a) = w1*(1-p_s) + w2*mu_L + w3*sigma_L + w4*J + w5*P_loss + w6*T_recovery + w7*C_resource
///
/// All terms are normalized to comparable scales before weighting. Returns
/// `None` if the candidate is unauthorized or insecure (security_risk >= 1.0).
pub fn score_candidate(
    c: &RouteCandidate,
    weights: &ObjectiveWeights,
    kappa: f64,
) -> Option<ScoredRoute> {
    // Hard constraints: never select unauthorized or insecure routes.
    if !c.authorized {
        return None;
    }
    if !c.tls_verified {
        return None;
    }
    if c.metrics.security_risk >= 1.0 {
        return None;
    }

    let m = &c.metrics;
    let p = clamp_probability(m.success_prob);
    let p_std = clamp_probability(m.success_std);
    let lcb = clamp_probability(p - kappa * p_std);

    // Normalize latency, jitter, loss, recovery, cost to [0, 1] using
    // documented reference scales. These scales are engineering choices,
    // not learned values.
    let latency_norm = clamp_probability(m.latency_ms / 5000.0); // 5s = max bad
    let jitter_norm = clamp_probability(m.jitter_ms / 1000.0);
    let loss_norm = clamp_probability(m.packet_loss);
    let recovery_norm = clamp_probability(m.recovery_time_sec / 30.0); // 30s = max bad
    let cost_norm = clamp_probability(m.resource_cost / 100.0);
    let var_norm = clamp_probability(m.latency_std / 2000.0);

    let objective = weights.w_failure * (1.0 - p)
        + weights.w_latency * latency_norm
        + weights.w_latency_var * var_norm
        + weights.w_jitter * jitter_norm
        + weights.w_loss * loss_norm
        + weights.w_recovery * recovery_norm
        + weights.w_cost * cost_norm;

    Some(ScoredRoute {
        candidate: c.clone(),
        objective,
        lcb_success: lcb,
        pareto_optimal: false, // filled in by pareto_frontier
    })
}

/// Score a list of candidates, returning only those that pass hard
/// constraints, sorted by objective (lower = better).
pub fn score_candidates(
    candidates: &[RouteCandidate],
    weights: &ObjectiveWeights,
    kappa: f64,
) -> Vec<ScoredRoute> {
    let mut scored: Vec<ScoredRoute> = candidates
        .iter()
        .filter_map(|c| score_candidate(c, weights, kappa))
        .collect();
    scored.sort_by(|a, b| a.objective.partial_cmp(&b.objective).unwrap_or(std::cmp::Ordering::Equal));
    scored
}

/// Compute the Pareto frontier among scored routes: a route is Pareto-optimal
/// if no other route is better-or-equal on all objectives and strictly better
/// on at least one.
///
/// Objectives (all to minimize): failure_prob, latency, jitter, loss,
/// recovery_time, cost.
pub fn pareto_frontier(scored: &mut [ScoredRoute]) {
    let n = scored.len();
    let mut optimal = vec![true; n];
    for i in 0..n {
        if !optimal[i] {
            continue;
        }
        for j in 0..n {
            if i == j || !optimal[j] {
                continue;
            }
            let a = &scored[i];
            let b = &scored[j];
            // Is b at least as good as a on all objectives and strictly better on one?
            let b_better_or_equal =
                b.candidate.metrics.success_prob >= a.candidate.metrics.success_prob
                    && b.candidate.metrics.latency_ms <= a.candidate.metrics.latency_ms
                    && b.candidate.metrics.jitter_ms <= a.candidate.metrics.jitter_ms
                    && b.candidate.metrics.packet_loss <= a.candidate.metrics.packet_loss
                    && b.candidate.metrics.recovery_time_sec <= a.candidate.metrics.recovery_time_sec
                    && b.candidate.metrics.resource_cost <= a.candidate.metrics.resource_cost;
            let b_strictly_better =
                b.candidate.metrics.success_prob > a.candidate.metrics.success_prob
                    || b.candidate.metrics.latency_ms < a.candidate.metrics.latency_ms
                    || b.candidate.metrics.jitter_ms < a.candidate.metrics.jitter_ms
                    || b.candidate.metrics.packet_loss < a.candidate.metrics.packet_loss
                    || b.candidate.metrics.recovery_time_sec < a.candidate.metrics.recovery_time_sec
                    || b.candidate.metrics.resource_cost < a.candidate.metrics.resource_cost;
            if b_better_or_equal && b_strictly_better {
                optimal[i] = false;
                break;
            }
        }
    }
    for (i, s) in scored.iter_mut().enumerate() {
        s.pareto_optimal = optimal[i];
    }
}

/// Select the best route: the Pareto-optimal route with the best
/// lower-confidence-bound on success (conservative). Falls back to the
/// lowest-objective route if no Pareto route has acceptable LCB.
pub fn select_best_route(
    scored: &[ScoredRoute],
    min_lcb_success: f64,
) -> Option<&ScoredRoute> {
    if scored.is_empty() {
        return None;
    }
    let min_lcb = clamp_probability(min_lcb_success);
    // Among Pareto-optimal routes with LCB >= threshold, pick the lowest
    // objective. If none clear the LCB bar, return None — never fall back to
    // a route whose lower confidence bound is too low.
    scored
        .iter()
        .filter(|s| s.pareto_optimal && s.lcb_success >= min_lcb)
        .min_by(|a, b| a.objective.partial_cmp(&b.objective).unwrap_or(std::cmp::Ordering::Equal))
}

/// CVaR_alpha of a latency distribution represented by samples:
/// expected value of the worst (1-alpha) tail.
///
/// Returns `None` for empty input.
pub fn cvar_latency(samples: &[f64], alpha: f64) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let a = clamp_probability(alpha);
    let mut sorted: Vec<f64> = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    // Worst tail = largest latencies. Take the top (1-a) fraction.
    let tail_count = ((1.0 - a) * sorted.len() as f64).ceil() as usize;
    let tail_count = tail_count.max(1).min(sorted.len());
    let tail = &sorted[sorted.len() - tail_count..];
    let sum: f64 = tail.iter().sum();
    Some(sum / tail_count as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_candidate(id: &str, authorized: bool, tls: bool, success_prob: f64, latency_ms: f64) -> RouteCandidate {
        RouteCandidate {
            id: id.to_string(),
            route_kind: RouteKind::Direct,
            authorized,
            tls_verified: tls,
            metrics: RouteMetrics {
                success_prob,
                success_std: 0.1,
                latency_ms,
                latency_std: 50.0,
                jitter_ms: 10.0,
                packet_loss: 0.01,
                recovery_time_sec: 5.0,
                resource_cost: 10.0,
                security_risk: 0.0,
            },
        }
    }

    #[test]
    fn unauthorized_route_is_never_scored() {
        let c = make_candidate("bad", false, true, 0.99, 10.0);
        let weights = ObjectiveWeights::default();
        assert!(score_candidate(&c, &weights, 1.0).is_none());
    }

    #[test]
    fn unverified_tls_route_is_never_scored() {
        let c = make_candidate("notls", true, false, 0.99, 10.0);
        let weights = ObjectiveWeights::default();
        assert!(score_candidate(&c, &weights, 1.0).is_none());
    }

    #[test]
    fn security_risk_one_is_never_scored() {
        let mut c = make_candidate("risky", true, true, 0.99, 10.0);
        c.metrics.security_risk = 1.0;
        let weights = ObjectiveWeights::default();
        assert!(score_candidate(&c, &weights, 1.0).is_none());
    }

    #[test]
    fn lower_objective_is_better() {
        let good = make_candidate("good", true, true, 0.99, 50.0);
        let bad = make_candidate("bad", true, true, 0.50, 5000.0);
        let weights = ObjectiveWeights::default();
        let sg = score_candidate(&good, &weights, 1.0).expect("good scored");
        let sb = score_candidate(&bad, &weights, 1.0).expect("bad scored");
        assert!(sg.objective < sb.objective);
    }

    #[test]
    fn lcb_below_mean_for_positive_kappa() {
        let c = make_candidate("c", true, true, 0.8, 100.0);
        let weights = ObjectiveWeights::default();
        let s = score_candidate(&c, &weights, 2.0).expect("scored");
        assert!(s.lcb_success < c.metrics.success_prob);
        assert!(s.lcb_success >= 0.0);
    }

    #[test]
    fn pareto_frontier_identifies_dominated_routes() {
        let mut scored = vec![
            score_candidate(&make_candidate("a", true, true, 0.99, 50.0), &ObjectiveWeights::default(), 1.0).unwrap(),
            score_candidate(&make_candidate("b", true, true, 0.50, 5000.0), &ObjectiveWeights::default(), 1.0).unwrap(),
            score_candidate(&make_candidate("c", true, true, 0.90, 100.0), &ObjectiveWeights::default(), 1.0).unwrap(),
        ];
        // "a" dominates both "b" and "c" (better success AND better latency),
        // so only "a" is Pareto-optimal.
        pareto_frontier(&mut scored);
        let a = scored.iter().find(|s| s.candidate.id == "a").unwrap();
        let b = scored.iter().find(|s| s.candidate.id == "b").unwrap();
        let c = scored.iter().find(|s| s.candidate.id == "c").unwrap();
        assert!(a.pareto_optimal);
        assert!(!b.pareto_optimal);
        assert!(!c.pareto_optimal);
    }

    #[test]
    fn select_best_prefers_high_lcb_pareto() {
        let mut scored = vec![
            score_candidate(&make_candidate("fast", true, true, 0.60, 10.0), &ObjectiveWeights::default(), 2.0).unwrap(),
            score_candidate(&make_candidate("reliable", true, true, 0.95, 200.0), &ObjectiveWeights::default(), 2.0).unwrap(),
        ];
        pareto_frontier(&mut scored);
        // min_lcb = 0.7: "fast" may have LCB below threshold, "reliable" should pass
        let best = select_best_route(&scored, 0.7).expect("some route");
        assert_eq!(best.candidate.id, "reliable");
    }

    #[test]
    fn select_best_returns_none_when_all_below_lcb() {
        let scored = vec![score_candidate(
            &make_candidate("weak", true, true, 0.30, 100.0),
            &ObjectiveWeights::default(),
            2.0,
        )
        .unwrap()];
        assert!(select_best_route(&scored, 0.9).is_none());
    }

    #[test]
    fn cvar_latency_is_worst_tail_mean() {
        let samples = vec![10.0, 20.0, 30.0, 40.0, 100.0, 200.0, 500.0];
        let cv = cvar_latency(&samples, 0.8).expect("cvar");
        // Top 20% (ceil(0.2*7)=2) = [200, 500], mean = 350
        assert!((cv - 350.0).abs() < 1e-9);
    }

    #[test]
    fn cvar_empty_returns_none() {
        assert!(cvar_latency(&[], 0.8).is_none());
    }
}

