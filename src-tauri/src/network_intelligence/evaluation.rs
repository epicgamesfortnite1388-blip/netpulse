//! Chronological evaluation and micro-benchmarks for the NANI engine.
//!
//! The harness answers two questions with executed code, not claims:
//!   1. Does dynamic Bayesian diagnosis beat a fixed first-failure rule on
//!      controlled, reproducible faults?
//!   2. What does one update / ranking / route score cost on this machine?
//!
//! Evaluation uses only conditions the probe set can actually distinguish.
//! IPv4-only/IPv6-only and intermittent loss are excluded from accuracy because
//! none of the probes observes address family or packet timing, so a "miss"
//! there would measure the instrument, not the model.

use crate::network_intelligence::diagnosis::{
    expected_information_gain, rank_tests, DiagnosticEngine, DiagnosticTest, ProbeOutcome,
    ProbeResult,
};
use crate::network_intelligence::route::{
    score_candidate, ObjectiveWeights, RouteCandidate, RouteMetrics,
};
use crate::network_intelligence::simulation::{NetworkCondition, NetworkSimulator};
use std::hint::black_box;
use std::time::Instant;

/// Conditions with an unambiguous ground-truth hypothesis.
const CONDITIONS: [(NetworkCondition, &str); 11] = [
    (NetworkCondition::DnsFailure, "dns"),
    (NetworkCondition::GatewayFailure, "gateway"),
    (NetworkCondition::RoutingFailure, "routing"),
    (NetworkCondition::TcpTimeout, "tcp"),
    (NetworkCondition::TlsFailure, "tls"),
    (NetworkCondition::MtuIssue, "mtu"),
    (NetworkCondition::UpstreamProxyDown, "upstream_proxy"),
    (NetworkCondition::RemoteEndpointDown, "remote_endpoint"),
    (NetworkCondition::AuthRejected, "auth_failure"),
    (NetworkCondition::RateLimited, "rate_limit"),
    (NetworkCondition::ServerError, "server_failure"),
];

fn probe_sequence() -> Vec<DiagnosticTest> {
    vec![
        DiagnosticTest::InterfaceCheck,
        DiagnosticTest::GatewayPing,
        DiagnosticTest::DnsResolve,
        DiagnosticTest::TcpConnect,
        DiagnosticTest::TlsHandshake,
        DiagnosticTest::MtuProbe,
        DiagnosticTest::Traceroute,
        DiagnosticTest::HttpGet,
    ]
}

/// Fixed baseline: the first failed probe decides the cause.
fn fixed_rule(probes: &[ProbeResult]) -> &'static str {
    for p in probes {
        match (&p.test, &p.outcome) {
            (DiagnosticTest::HttpGet, ProbeOutcome::AuthRejected) => return "auth_failure",
            (DiagnosticTest::HttpGet, ProbeOutcome::RateLimited) => return "rate_limit",
            (DiagnosticTest::HttpGet, ProbeOutcome::ServerError) => return "server_failure",
            (_, ProbeOutcome::Success) | (_, ProbeOutcome::Missing) => {}
            (DiagnosticTest::InterfaceCheck, _) => return "local_interface",
            (DiagnosticTest::GatewayPing, _) => return "gateway",
            (DiagnosticTest::DnsResolve, _) => return "dns",
            (DiagnosticTest::TcpConnect, _) => return "tcp",
            (DiagnosticTest::TlsHandshake, _) => return "tls",
            (DiagnosticTest::MtuProbe, _) => return "mtu",
            (DiagnosticTest::Traceroute, _) => return "routing",
            (DiagnosticTest::HttpGet, _) => return "remote_endpoint",
        }
    }
    "unknown"
}

#[derive(Debug, Clone)]
pub struct ConditionResult {
    pub truth: &'static str,
    pub trials: usize,
    pub nani_correct: usize,
    pub fixed_correct: usize,
}

#[derive(Debug, Clone)]
pub struct EvaluationResult {
    pub scenarios: usize,
    pub nani_correct: usize,
    pub fixed_correct: usize,
    pub nani_accuracy: f64,
    pub fixed_accuracy: f64,
    /// Wilson 95% interval for NANI accuracy.
    pub nani_ci95: (f64, f64),
    pub mean_uncertainty: f64,
    /// Brier score of the MAP diagnosis being correct.
    pub brier: f64,
    pub per_condition: Vec<ConditionResult>,
}

/// Wilson score interval for a binomial proportion.
fn wilson(successes: usize, n: usize) -> (f64, f64) {
    if n == 0 {
        return (0.0, 0.0);
    }
    let p = successes as f64 / n as f64;
    let z = 1.96;
    let z2 = z * z;
    let denom = 1.0 + z2 / n as f64;
    let centre = p + z2 / (2.0 * n as f64);
    let margin = z * ((p * (1.0 - p) / n as f64) + z2 / (4.0 * n as f64 * n as f64)).sqrt();
    (((centre - margin) / denom).max(0.0), ((centre + margin) / denom).min(1.0))
}

/// Run `seeds` deterministic trials per distinguishable condition.
pub fn evaluate(seeds: u64) -> EvaluationResult {
    let mut per_condition = Vec::new();
    let mut nani_correct = 0usize;
    let mut fixed_correct = 0usize;
    let mut brier_sum = 0.0;
    let mut uncertainty_sum = 0.0;
    let mut total = 0usize;

    for (condition, truth) in CONDITIONS {
        let mut c_nani = 0usize;
        let mut c_fixed = 0usize;
        for seed in 0..seeds {
            let mut sim = NetworkSimulator::new(seed, condition);
            let mut engine = DiagnosticEngine::new();
            let mut probes = Vec::new();
            for (i, test) in probe_sequence().iter().enumerate() {
                let mut result = sim.probe(test);
                // Distinct timestamps exercise the transition model without
                // claiming wall-clock duration.
                result.timestamp = i as u64 + 1;
                engine.observe(&result);
                probes.push(result);
            }

            let (label, prob) = engine.diagnosis().unwrap_or(("unknown", 0.0));
            let is_correct = label == truth;
            if is_correct {
                nani_correct += 1;
                c_nani += 1;
            }
            if fixed_rule(&probes) == truth {
                fixed_correct += 1;
                c_fixed += 1;
            }
            brier_sum += (prob - if is_correct { 1.0 } else { 0.0 }).powi(2);
            uncertainty_sum += engine.uncertainty();
            total += 1;
        }
        per_condition.push(ConditionResult {
            truth,
            trials: seeds as usize,
            nani_correct: c_nani,
            fixed_correct: c_fixed,
        });
    }

    EvaluationResult {
        scenarios: total,
        nani_correct,
        fixed_correct,
        nani_accuracy: nani_correct as f64 / total as f64,
        fixed_accuracy: fixed_correct as f64 / total as f64,
        nani_ci95: wilson(nani_correct, total),
        mean_uncertainty: uncertainty_sum / total as f64,
        brier: brier_sum / total as f64,
        per_condition,
    }
}

#[derive(Debug, Clone)]
pub struct BenchReport {
    pub iterations: usize,
    /// One Bayesian observe on an 8-probe engine, microseconds.
    pub bayes_update_us: f64,
    /// Ranking all tests by expected information gain, microseconds.
    pub info_gain_us: f64,
    /// Scoring one route candidate, microseconds.
    pub route_score_us: f64,
}

fn bench_candidate() -> RouteCandidate {
    RouteCandidate {
        id: "bench".into(),
        route_kind: crate::network_intelligence::api_model::RouteKind::Direct,
        authorized: true,
        tls_verified: true,
        metrics: RouteMetrics {
            success_prob: 0.92,
            success_std: 0.04,
            latency_ms: 80.0,
            latency_std: 15.0,
            jitter_ms: 8.0,
            packet_loss: 0.01,
            recovery_time_sec: 3.0,
            resource_cost: 5.0,
            security_risk: 0.0,
        },
    }
}

/// Measure update, ranking and route-scoring cost. `black_box` prevents the
/// optimizer from deleting the measured work.
pub fn benchmark(iterations: usize) -> BenchReport {
    let iterations = iterations.max(1);
    let mut engine = DiagnosticEngine::new();
    let mut sim = NetworkSimulator::new(11, NetworkCondition::Healthy);
    let start = Instant::now();
    for i in 0..iterations {
        let mut r = sim.probe(&DiagnosticTest::DnsResolve);
        r.timestamp = i as u64 + 1;
        engine.observe(black_box(&r));
    }
    let bayes_update_us = start.elapsed().as_secs_f64() * 1e6 / iterations as f64;

    let start = Instant::now();
    for _ in 0..iterations {
        black_box(rank_tests(black_box(&engine)));
    }
    let info_gain_us = start.elapsed().as_secs_f64() * 1e6 / iterations as f64;

    let candidate = bench_candidate();
    let weights = ObjectiveWeights::default();
    let start = Instant::now();
    for _ in 0..iterations {
        black_box(score_candidate(black_box(&candidate), &weights, 1.5));
    }
    let route_score_us = start.elapsed().as_secs_f64() * 1e6 / iterations as f64;

    BenchReport {
        iterations,
        bayes_update_us,
        info_gain_us,
        route_score_us,
    }
}

/// Sanity check used by tests: a single test's IG must equal the value returned
/// when ranking all tests (the two code paths share the same estimator).
pub fn ig_consistency() -> bool {
    let engine = DiagnosticEngine::new();
    let ranked = rank_tests(&engine);
    for score in &ranked {
        if let Some(single) = expected_information_gain(&engine, &score.test) {
            if (single.information_gain - score.information_gain).abs() > 1e-9 {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nani_beats_fixed_first_failure_rule() {
        let result = evaluate(20);
        println!(
            "NANI {}/{} = {:.3} (95% CI {:.3}..{:.3}) vs fixed {:.3}, Brier {:.3}, H {:.3}",
            result.nani_correct,
            result.scenarios,
            result.nani_accuracy,
            result.nani_ci95.0,
            result.nani_ci95.1,
            result.fixed_accuracy,
            result.brier,
            result.mean_uncertainty
        );
        for c in &result.per_condition {
            println!(
                "  {:<18} NANI {:>2}/{}  fixed {:>2}/{}",
                c.truth, c.nani_correct, c.trials, c.fixed_correct, c.trials
            );
        }
        assert!(
            result.nani_accuracy > result.fixed_accuracy,
            "NANI {:.3} must beat fixed {:.3}",
            result.nani_accuracy,
            result.fixed_accuracy
        );
        assert!(result.nani_accuracy > 0.5, "accuracy must exceed chance");
        assert!(result.brier < 0.25, "Brier {:.3} must beat a coin flip", result.brier);
    }

    #[test]
    fn evaluation_is_deterministic() {
        let a = evaluate(5);
        let b = evaluate(5);
        assert_eq!(a.nani_correct, b.nani_correct);
        assert_eq!(a.fixed_correct, b.fixed_correct);
        assert_eq!(a.brier.to_bits(), b.brier.to_bits());
    }

    #[test]
    fn information_gain_matches_ranker() {
        assert!(ig_consistency());
    }

    #[test]
    fn benchmarks_are_within_budget() {
        let b = benchmark(if cfg!(debug_assertions) { 200 } else { 2000 });
        println!(
            "bench: update {:.1}us, rank {:.1}us, route {:.1}us ({} iters)",
            b.bayes_update_us, b.info_gain_us, b.route_score_us, b.iterations
        );
        // Generous debug bounds; the release build is far below these.
        let cap_us = if cfg!(debug_assertions) { 5000.0 } else { 500.0 };
        assert!(b.bayes_update_us < cap_us);
        assert!(b.info_gain_us < cap_us);
        assert!(b.route_score_us < cap_us);
    }
}

#[cfg(test)]
mod debug_tests {
    use super::*;

    #[test]
    fn debug_ranked() {
        for (condition, truth) in [
            (NetworkCondition::DnsFailure, "dns"),
            (NetworkCondition::GatewayFailure, "gateway"),
            (NetworkCondition::AuthRejected, "auth_failure"),
            (NetworkCondition::TcpTimeout, "tcp"),
        ] {
            let mut sim = NetworkSimulator::new(1, condition);
            let mut engine = DiagnosticEngine::new();
            let mut probes = Vec::new();
            for (i, test) in probe_sequence().iter().enumerate() {
                let mut r = sim.probe(test);
                r.timestamp = i as u64 + 1;
                println!("{:?} {:?} {:?}", truth, r.test, r.outcome);
                engine.observe(&r);
                probes.push(r);
            }
            println!("truth={truth} ranked={:?}", &engine.ranked()[..4]);
            println!("fixed={}", fixed_rule(&probes));
        }
    }
}
