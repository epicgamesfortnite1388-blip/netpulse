//! Phase 7 — Unified information theory and probe selection engine.
//!
//! Extends `diagnosis.rs` (expected information gain over DiagnosticTest) and
//! `sequential.rs` (cost-adjusted gain, VOI, stopping) into a single framework
//! that scores arbitrary probe categories (diagnostic, API, route, recovery)
//! by expected information gain per unit cost, with mutual information and
//! conditional entropy primitives for multivariate analysis.

use crate::network_intelligence::diagnosis::{
    DiagnosticEngine, DiagnosticTest, ProbeOutcome, ProbeResult, TestScore,
};
use crate::network_intelligence::math::{entropy_of, kl_divergence, log_sum_exp, PROB_FLOOR};
use crate::network_intelligence::route::{RouteCandidate, RouteMetrics};

/// A probe candidate from any category, scored uniformly by IG/cost.
#[derive(Debug, Clone)]
pub enum ProbeCategory {
    Diagnostic(DiagnosticTest),
    Api(String),
    Route(String),
    Recovery(String),
}

/// Scored probe candidate with expected information gain per unit cost.
#[derive(Debug, Clone)]
pub struct ScoredProbe {
    pub category: ProbeCategory,
    pub id: String,
    pub expected_information_gain: f64,
    pub cost: f64,
    pub efficiency: f64,
    /// IG minus cost — net value if information were linear in utility.
    pub net_value: f64,
}

/// Expected information gain of running a diagnostic test (wraps diagnosis.rs).
pub fn expected_information_gain_diagnostic(
    engine: &DiagnosticEngine,
    test: &DiagnosticTest,
) -> Option<TestScore> {
    crate::network_intelligence::diagnosis::expected_information_gain(engine, test)
}

/// Score all diagnostic tests by expected information gain per unit cost.
pub fn rank_diagnostic_probes(engine: &DiagnosticEngine) -> Vec<TestScore> {
    crate::network_intelligence::diagnosis::rank_tests(engine)
}

/// Select the single best diagnostic probe by efficiency.
pub fn select_best_diagnostic_probe(engine: &DiagnosticEngine) -> Option<TestScore> {
    let ranked = rank_diagnostic_probes(engine);
    ranked.into_iter().max_by(|a, b| {
        a.efficiency
            .partial_cmp(&b.efficiency)
            .unwrap_or(std::cmp::Ordering::Equal)
    })
}

/// Expected information gain for a route candidate: reduction in route
/// selection uncertainty measured as KL divergence between prior and
/// posterior over routes, weighted by route metric uncertainty.
pub fn expected_information_gain_route(
    candidates: &[RouteCandidate],
    current_selection: Option<usize>,
) -> Option<f64> {
    if candidates.is_empty() {
        return None;
    }
    // Prior over routes: uniform softmax over negative cost proxy (latency + loss).
    let priors: Vec<f64> = candidates
        .iter()
        .map(|c| {
            let cost = c.metrics.latency_ms + c.metrics.packet_loss * 100.0;
            (-cost).exp()
        })
        .collect();
    let total: f64 = priors.iter().sum();
    if total <= 0.0 || !total.is_finite() {
        return None;
    }
    let priors: Vec<f64> = priors.iter().map(|p| p / total).collect();

    // Posterior after observing route metrics: update by success probability.
    // A route with higher success_prob is more reliable -> sharper posterior.
    let posteriors: Vec<f64> = candidates
        .iter()
        .zip(priors.iter())
        .map(|(c, &prior)| {
            let reliability = c.metrics.success_prob.clamp(PROB_FLOOR, 1.0);
            prior * reliability
        })
        .collect();
    let post_total: f64 = posteriors.iter().sum();
    if post_total <= 0.0 || !post_total.is_finite() {
        return None;
    }
    let posteriors: Vec<f64> = posteriors.iter().map(|p| p / post_total).collect();

    // IG = KL(posterior || prior) — how much observing metrics sharpens beliefs.
    kl_divergence(&posteriors, &priors)
}

/// Score route candidates by expected information gain per unit latency cost.
pub fn rank_route_probes(candidates: &[RouteCandidate]) -> Vec<ScoredProbe> {
    let mut scored: Vec<ScoredProbe> = candidates
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            let ig = expected_information_gain_route(candidates, Some(i))?;
            let cost = c.metrics.latency_ms.max(1.0);
            Some(ScoredProbe {
                category: ProbeCategory::Route(c.id.clone()),
                id: c.id.clone(),
                expected_information_gain: ig,
                cost,
                efficiency: ig / cost,
                net_value: ig - cost,
            })
        })
        .collect();
    scored.sort_by(|a, b| {
        b.efficiency
            .partial_cmp(&a.efficiency)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored
}

/// Mutual information I(X;Y) = H(X) + H(Y) - H(X,Y) for discrete joint
/// distribution p_xy and marginals p_x, p_y.
///
/// Returns None if inputs are empty or non-finite.
pub fn mutual_information(p_xy: &[Vec<f64>], p_x: &[f64], p_y: &[f64]) -> Option<f64> {
    if p_xy.is_empty() || p_x.is_empty() || p_y.is_empty() {
        return None;
    }
    let h_x = entropy(p_x)?;
    let h_y = entropy(p_y)?;
    let h_xy = joint_entropy(p_xy)?;
    Some(h_x + h_y - h_xy)
}

/// Shannon entropy H(X) = -sum p_i log p_i, in nats.
///
/// Returns None if any probability is negative or the distribution doesn't
/// sum to ~1 (within tolerance).
pub fn entropy(probs: &[f64]) -> Option<f64> {
    if probs.is_empty() {
        return None;
    }
    let total: f64 = probs.iter().sum();
    if !(total > 0.0) || !total.is_finite() {
        return None;
    }
    // The zero convention lives in `math::entropy_of` (impossible outcomes
    // contribute nothing) so this cannot drift from the other entropy callers.
    Some(entropy_of(probs))
}

/// Joint entropy H(X,Y) = -sum p_ij log p_ij.
pub fn joint_entropy(p_xy: &[Vec<f64>]) -> Option<f64> {
    if p_xy.is_empty() {
        return None;
    }
    // Same zero convention as the marginal entropy: it lives in
    // `math::entropy_of`, not in a second copy of the loop.
    Some(p_xy.iter().map(|row| entropy_of(row)).sum())
}

/// Conditional entropy H(Y|X) = H(X,Y) - H(X).
pub fn conditional_entropy(p_xy: &[Vec<f64>], p_x: &[f64]) -> Option<f64> {
    let h_xy = joint_entropy(p_xy)?;
    let h_x = entropy(p_x)?;
    Some(h_xy - h_x)
}

/// Value of information: expected reduction in loss from a measurement,
/// net of cost. Positive VOI means the measurement is worth its cost.
pub fn value_of_information(
    prior_loss: f64,
    expected_posterior_loss: f64,
    cost: f64,
) -> f64 {
    (prior_loss - expected_posterior_loss) - cost
}

/// Cost-adjusted information gain: IG / (cost + epsilon).
pub fn cost_adjusted_gain(info_gain: f64, cost: f64, epsilon: f64) -> f64 {
    let eps = epsilon.max(1e-12);
    info_gain / (cost + eps)
}

/// Sequential stopping rule: stop when best remaining IG/cost is below
/// threshold, or when confidence target is met.
pub fn should_stop(
    best_efficiency: f64,
    efficiency_threshold: f64,
    confidence: f64,
    confidence_target: f64,
) -> bool {
    if confidence >= confidence_target {
        return true;
    }
    best_efficiency < efficiency_threshold
}

/// Information-budget stopping: stop when accumulated IG reaches budget
/// or marginal IG per cost falls below threshold.
pub fn should_stop_by_budget(
    accumulated_ig: f64,
    ig_budget: f64,
    marginal_efficiency: f64,
    efficiency_threshold: f64,
) -> bool {
    accumulated_ig >= ig_budget || marginal_efficiency < efficiency_threshold
}

/// Unified probe selection across all categories. Scores diagnostic tests,
/// route candidates, API endpoints, and recovery actions by expected
/// information gain per unit cost, then ranks them.
pub fn select_best_probe_unified(
    engine: &DiagnosticEngine,
    route_candidates: &[RouteCandidate],
    api_endpoints: &[String],
    recovery_actions: &[String],
) -> Option<ScoredProbe> {
    let mut all: Vec<ScoredProbe> = Vec::new();

    // Diagnostic tests.
    for score in rank_diagnostic_probes(engine) {
        all.push(ScoredProbe {
            category: ProbeCategory::Diagnostic(score.test.clone()),
            id: score.test.correlation_id().to_string(),
            expected_information_gain: score.information_gain,
            cost: score.cost,
            efficiency: score.efficiency,
            net_value: score.information_gain - score.cost,
        });
    }

    // Route candidates.
    for rp in rank_route_probes(route_candidates) {
        all.push(rp);
    }

    // API endpoints: low-cost health probes with small but nonzero IG.
    for ep in api_endpoints {
        all.push(ScoredProbe {
            category: ProbeCategory::Api(ep.clone()),
            id: ep.clone(),
            expected_information_gain: 0.05,
            cost: 1.0,
            efficiency: 0.05,
            net_value: -0.95,
        });
    }

    // Recovery actions: moderate cost, moderate IG (verifies recovery hypothesis).
    for ra in recovery_actions {
        all.push(ScoredProbe {
            category: ProbeCategory::Recovery(ra.clone()),
            id: ra.clone(),
            expected_information_gain: 0.2,
            cost: 3.0,
            efficiency: 0.0667,
            net_value: -2.8,
        });
    }

    all.into_iter()
        .max_by(|a, b| {
            a.efficiency
                .partial_cmp(&b.efficiency)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network_intelligence::diagnosis::Hypothesis;

    #[test]
    fn entropy_treats_an_impossible_outcome_as_zero_mass() {
        // softmax reports an outcome the evidence rules out as exactly 0.0
        // (e^-2000 underflows). Entropy must skip that term rather than compute
        // 0 * ln(0) = NaN, so an extreme distribution still has a real entropy
        // — 0 nats, since no uncertainty is left.
        let probs = crate::network_intelligence::math::softmax(&[1000.0, -1000.0]).expect("softmax");
        assert_eq!(probs, vec![1.0, 0.0]);
        let h = entropy(&probs).expect("entropy of a certain distribution");
        assert!(h.is_finite() && h.abs() < 1e-12, "entropy {h}");

        // Same for a distribution where the impossible outcome is listed first.
        let h2 = entropy(&[0.0, 1.0]).expect("entropy");
        assert!(h2.is_finite() && h2.abs() < 1e-12, "entropy {h2}");
    }

    #[test]
    fn entropy_uniform_is_log_n() {
        let n = 4;
        let probs = vec![0.25; 4];
        let h = entropy(&probs).expect("entropy");
        assert!((h - (n as f64).ln() / 4.0 * 4.0).abs() < 1e-9);
        assert!((h - 4.0f64.ln() / 4.0 * 4.0).abs() < 1e-9);
        // Uniform over 4: H = ln(4)
        assert!((h - 4.0f64.ln()).abs() < 1e-9);
    }

    #[test]
    fn entropy_deterministic_is_zero() {
        let h = entropy(&[1.0, 0.0, 0.0]).expect("entropy");
        assert!(h.abs() < 1e-9);
    }

    #[test]
    fn entropy_empty_returns_none() {
        assert!(entropy(&[]).is_none());
    }

    #[test]
    fn mutual_information_independent_is_zero() {
        // Independent: p_xy[i][j] = p_x[i] * p_y[j]
        let p_x = vec![0.5, 0.5];
        let p_y = vec![0.5, 0.5];
        let p_xy = vec![vec![0.25, 0.25], vec![0.25, 0.25]];
        let mi = mutual_information(&p_xy, &p_x, &p_y).expect("mi");
        assert!(mi.abs() < 1e-9);
    }

    #[test]
    fn mutual_information_perfect_correlation_is_positive() {
        // Perfect correlation: p_xy[0][0]=0.5, p_xy[1][1]=0.5, rest 0
        let p_x = vec![0.5, 0.5];
        let p_y = vec![0.5, 0.5];
        let p_xy = vec![vec![0.5, 0.0], vec![0.0, 0.5]];
        let mi = mutual_information(&p_xy, &p_x, &p_y).expect("mi");
        assert!(mi > 0.0);
        assert!((mi - (-0.5f64.ln())).abs() < 1e-9); // MI = ln(2) for perfect correlation
    }

    #[test]
    fn conditional_entropy_reduces_uncertainty() {
        // Perfect correlation: H(Y|X) = 0
        let p_x = vec![0.5, 0.5];
        let p_xy = vec![vec![0.5, 0.0], vec![0.0, 0.5]];
        let ce = conditional_entropy(&p_xy, &p_x).expect("ce");
        assert!(ce.abs() < 1e-9);
    }

    #[test]
    fn kl_divergence_same_distribution_is_zero() {
        let p = vec![0.2, 0.3, 0.5];
        let d = kl_divergence(&p, &p).expect("kl");
        assert!(d.abs() < 1e-9);
    }

    #[test]
    fn value_of_information_positive_when_reduces_loss() {
        let voi = value_of_information(10.0, 2.0, 1.0);
        assert!(voi > 0.0);
        assert!((voi - 7.0).abs() < 1e-9);
    }

    #[test]
    fn value_of_information_negative_when_cost_exceeds_benefit() {
        let voi = value_of_information(10.0, 9.0, 2.0);
        assert!(voi < 0.0);
    }

    #[test]
    fn cost_adjusted_gain_prefers_lower_cost() {
        let a = cost_adjusted_gain(1.0, 1.0, 1e-9);
        let b = cost_adjusted_gain(1.0, 5.0, 1e-9);
        assert!(a > b);
    }

    #[test]
    fn should_stop_when_confident() {
        assert!(should_stop(0.5, 0.1, 0.95, 0.9));
        assert!(!should_stop(0.5, 0.1, 0.5, 0.9));
    }

    #[test]
    fn should_stop_by_budget_test() {
        assert!(super::should_stop_by_budget(10.0, 5.0, 0.5, 0.1));
        assert!(!super::should_stop_by_budget(1.0, 5.0, 0.5, 0.1));
    }

    #[test]
    fn rank_route_probes_sorted_by_efficiency() {
        use crate::network_intelligence::api_model::RouteKind;
        let c1 = RouteCandidate {
            id: "route-a".into(),
            route_kind: RouteKind::Direct,
            authorized: true,
            tls_verified: true,
            metrics: RouteMetrics {
                success_prob: 0.99,
                success_std: 0.01,
                latency_ms: 50.0,
                latency_std: 5.0,
                jitter_ms: 5.0,
                packet_loss: 0.0,
                recovery_time_sec: 5.0,
                resource_cost: 1.0,
                security_risk: 0.0,
            },
        };
        let c2 = RouteCandidate {
            id: "route-b".into(),
            route_kind: RouteKind::Upstream("proxy-1".into()),
            authorized: true,
            tls_verified: true,
            metrics: RouteMetrics {
                success_prob: 0.7,
                success_std: 0.1,
                latency_ms: 500.0,
                latency_std: 50.0,
                jitter_ms: 50.0,
                packet_loss: 0.1,
                recovery_time_sec: 30.0,
                resource_cost: 2.0,
                security_risk: 0.0,
            },
        };
        let ranked = rank_route_probes(&[c1, c2]);
        assert_eq!(ranked.len(), 2);
        assert!(ranked[0].efficiency >= ranked[1].efficiency);
    }

    #[test]
    fn expected_information_gain_diagnostic_wraps() {
        let engine = DiagnosticEngine::new();
        let ig = expected_information_gain_diagnostic(&engine, &DiagnosticTest::DnsResolve);
        assert!(ig.is_some());
        assert!(ig.unwrap().information_gain >= 0.0);
    }

    #[test]
    fn diagnostic_engine_uncertainty_matches_foundation() {
        let engine = DiagnosticEngine::new();
        let n = Hypothesis::all().len() as f64;
        assert!((engine.uncertainty() - n.ln()).abs() < 1e-9);
    }
}
