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
use crate::network_intelligence::validation::{
    brier_score, expected_calibration_error as validated_ece, log_loss, IsotonicCalibrator,
    Prediction, TemperatureScaling,
};
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
    /// Expected calibration error over 10 equal-width confidence bins.
    pub ece: f64,
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

/// One simulated diagnosis with everything evaluation needs from it.
#[derive(Debug, Clone)]
struct Trial {
    seed: u64,
    truth: &'static str,
    /// MAP confidence, i.e. the probability the engine claims for its answer.
    prob: f64,
    correct: bool,
    fixed_correct: bool,
    uncertainty: f64,
}

/// Run `seeds` deterministic trials per distinguishable condition, once.
///
/// Both accuracy evaluation and calibration fitting read this one run, so the
/// two numbers can never describe different simulations.
fn run_trials(seeds: u64) -> Vec<Trial> {
    let mut trials = Vec::new();
    for (condition, truth) in CONDITIONS {
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
            trials.push(Trial {
                seed,
                truth,
                prob,
                correct: label == truth,
                fixed_correct: fixed_rule(&probes) == truth,
                uncertainty: engine.uncertainty(),
            });
        }
    }
    trials
}

/// Run `seeds` deterministic trials per distinguishable condition.
pub fn evaluate(seeds: u64) -> EvaluationResult {
    let mut per_condition = Vec::new();
    let mut nani_correct = 0usize;
    let mut fixed_correct = 0usize;
    let mut brier_sum = 0.0;
    let mut uncertainty_sum = 0.0;
    let mut calibration: Vec<Prediction> = Vec::new();

    let trials = run_trials(seeds);
    let total = trials.len();
    for (_, truth) in CONDITIONS {
        let in_condition: Vec<&Trial> = trials.iter().filter(|t| t.truth == truth).collect();
        let mut c_nani = 0usize;
        let mut c_fixed = 0usize;
        for t in &in_condition {
            if t.correct {
                nani_correct += 1;
                c_nani += 1;
            }
            if t.fixed_correct {
                fixed_correct += 1;
                c_fixed += 1;
            }
            brier_sum += (t.prob - if t.correct { 1.0 } else { 0.0 }).powi(2);
            calibration.push(
                Prediction::new(t.prob, if t.correct { 1.0 } else { 0.0 })
                    .expect("MAP confidence is finite by construction"),
            );
            uncertainty_sum += t.uncertainty;
        }
        per_condition.push(ConditionResult {
            truth,
            trials: in_condition.len(),
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
        ece: validated_ece(&calibration, 10).unwrap_or(0.0),
        per_condition,
    }
}

/// Raw versus post-hoc-calibrated confidence on held-out simulator trials.
#[derive(Debug, Clone)]
pub struct CalibrationComparison {
    /// Trials the temperature was fitted on.
    pub fit_trials: usize,
    /// Trials the effect was measured on (never used for fitting).
    pub holdout_trials: usize,
    pub temperature: f64,
    pub raw_ece: f64,
    /// Held-out ECE under temperature scaling (one global scale factor).
    pub temperature_ece: f64,
    /// Held-out ECE under isotonic regression (monotone, non-parametric).
    pub calibrated_ece: f64,
    pub raw_brier: f64,
    pub calibrated_brier: f64,
    pub raw_log_loss: f64,
    pub calibrated_log_loss: f64,
    /// ECE over every trial, raw.
    pub full_raw_ece: f64,
    /// ECE over every trial, each half calibrated by a map fitted on the other
    /// half. Directly comparable with `full_raw_ece`: no sample is calibrated
    /// by a fit that has seen it.
    pub full_calibrated_ece: f64,
}

/// Fit a temperature on half of the simulator trials and measure calibration on
/// the other half.
///
/// The split is by seed parity, so both halves contain every condition and the
/// holdout is never seen while fitting. Measuring ECE on the fitting data would
/// reward the transform for memorising, which is why it is not done here.
pub fn evaluate_calibrated(seeds: u64, n_bins: usize) -> CalibrationComparison {
    let trials = run_trials(seeds);
    let prediction = |t: &Trial| {
        Prediction::new(t.prob, if t.correct { 1.0 } else { 0.0 })
            .expect("MAP confidence is finite by construction")
    };
    let fit: Vec<Prediction> = trials.iter().filter(|t| t.seed % 2 == 0).map(prediction).collect();
    let holdout: Vec<Prediction> = trials.iter().filter(|t| t.seed % 2 == 1).map(prediction).collect();

    let scaler = TemperatureScaling::fit(&fit);
    let temperature_calibrated = scaler.apply_all(&holdout);
    let isotonic = IsotonicCalibrator::fit(&fit);
    let calibrated = isotonic.apply_all(&holdout);

    // 2-fold cross-fit: fold A is calibrated by a map fitted only on B and vice
    // versa, so every trial contributes to a same-size comparison with the raw
    // full-suite ECE.
    let mut cross_fitted: Vec<Prediction> = IsotonicCalibrator::fit(&holdout).apply_all(&fit);
    cross_fitted.extend(calibrated.iter().copied());
    let mut all_raw: Vec<Prediction> = fit.clone();
    all_raw.extend(holdout.iter().copied());

    CalibrationComparison {
        fit_trials: fit.len(),
        holdout_trials: holdout.len(),
        temperature: scaler.temperature(),
        raw_ece: validated_ece(&holdout, n_bins).unwrap_or(0.0),
        temperature_ece: validated_ece(&temperature_calibrated, n_bins).unwrap_or(0.0),
        calibrated_ece: validated_ece(&calibrated, n_bins).unwrap_or(0.0),
        raw_brier: brier_score(&holdout).unwrap_or(0.0),
        calibrated_brier: brier_score(&calibrated).unwrap_or(0.0),
        raw_log_loss: log_loss(&holdout).unwrap_or(0.0),
        calibrated_log_loss: log_loss(&calibrated).unwrap_or(0.0),
        full_raw_ece: validated_ece(&all_raw, n_bins).unwrap_or(0.0),
        full_calibrated_ece: validated_ece(&cross_fitted, n_bins).unwrap_or(0.0),
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
            "NANI {}/{} = {:.3} (95% CI {:.3}..{:.3}) vs fixed {:.3}, Brier {:.3}, ECE {:.3}, H {:.3}",
            result.nani_correct,
            result.scenarios,
            result.nani_accuracy,
            result.nani_ci95.0,
            result.nani_ci95.1,
            result.fixed_accuracy,
            result.brier,
            result.ece,
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
    fn isotonic_calibration_cuts_held_out_calibration_error() {
        let cmp = evaluate_calibrated(20, 10);
        println!(
            "calibration: raw ECE {:.3} | temperature ECE {:.3} (T = {:.2}) | isotonic ECE {:.3} | Brier {:.3} -> {:.3}, log loss {:.3} -> {:.3} | fit {} trials, holdout {}",
            cmp.raw_ece,
            cmp.temperature_ece,
            cmp.temperature,
            cmp.calibrated_ece,
            cmp.raw_brier,
            cmp.calibrated_brier,
            cmp.raw_log_loss,
            cmp.calibrated_log_loss,
            cmp.fit_trials,
            cmp.holdout_trials
        );
        println!(
            "full suite ({} trials) cross-fitted: ECE {:.3} -> {:.3}",
            cmp.fit_trials + cmp.holdout_trials,
            cmp.full_raw_ece,
            cmp.full_calibrated_ece
        );
        assert!(cmp.fit_trials > 0 && cmp.holdout_trials > 0);
        assert!(cmp.temperature > 0.0 && cmp.temperature.is_finite());
        assert!(
            cmp.calibrated_ece < cmp.raw_ece,
            "held-out ECE must improve: {:.3} -> {:.3}",
            cmp.raw_ece,
            cmp.calibrated_ece
        );
        // The recorded pre-calibration figure for this suite.
        assert!(
            cmp.calibrated_ece < 0.146,
            "calibrated ECE {:.3} must beat the 0.146 baseline",
            cmp.calibrated_ece
        );
        assert!(
            cmp.full_calibrated_ece < cmp.full_raw_ece,
            "cross-fitted full-suite ECE must improve: {:.3} -> {:.3}",
            cmp.full_raw_ece,
            cmp.full_calibrated_ece
        );
        assert!(
            cmp.full_calibrated_ece < 0.146,
            "cross-fitted full-suite ECE {:.3} must beat 0.146",
            cmp.full_calibrated_ece
        );
        // Calibration must not be bought by wrecking the probabilities: a map
        // that outputs 0/1 would score ECE well and log loss terribly.
        assert!(
            cmp.calibrated_log_loss <= cmp.raw_log_loss * 1.1,
            "log loss {:.3} -> {:.3} degraded beyond noise",
            cmp.raw_log_loss,
            cmp.calibrated_log_loss
        );
    }

    #[test]
    fn calibration_evaluation_is_deterministic() {
        let a = evaluate_calibrated(6, 10);
        let b = evaluate_calibrated(6, 10);
        assert_eq!(a.temperature.to_bits(), b.temperature.to_bits());
        assert_eq!(a.raw_ece.to_bits(), b.raw_ece.to_bits());
        assert_eq!(a.calibrated_ece.to_bits(), b.calibrated_ece.to_bits());
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
        // Cargo runs tests in parallel, so a single timing sample can include
        // scheduler contention. Report the best of three identical runs; the
        // thresholds still catch a genuine complexity regression.
        let iterations = if cfg!(debug_assertions) { 200 } else { 2000 };
        let mut best: Option<BenchReport> = None;
        for _ in 0..3 {
            let candidate = benchmark(iterations);
            let worse = candidate
                .bayes_update_us
                .max(candidate.info_gain_us)
                .max(candidate.route_score_us);
            let best_worse = best.as_ref().map(|b| {
                b.bayes_update_us.max(b.info_gain_us).max(b.route_score_us)
            });
            if best_worse.map_or(true, |current| worse < current) {
                best = Some(candidate);
            }
        }
        let b = best.expect("at least one benchmark run");
        println!(
            "bench(best of 3): update {:.1}us, rank {:.1}us, route {:.1}us ({} iters)",
            b.bayes_update_us, b.info_gain_us, b.route_score_us, b.iterations
        );
        // Generous debug bounds; the release build is far below these.
        let cap_us = if cfg!(debug_assertions) { 6000.0 } else { 12000.0 };
        assert!(b.bayes_update_us < cap_us);

        // Ranking gets its OWN, much tighter cap. Sharing the update/route
        // budget let a regression pass silently: the pre-optimisation
        // clone-per-outcome ranker measured ~5000us per `rank_tests` call, which
        // is under the 6000us cap above, so the ~12x fast path
        // (`DiagnosticEngine::entropy_if_observed`) could be deleted and this
        // test would still go green.
        //
        // Measured on the reference dev machine (debug, 200 iters, best of 3):
        // rank ~365us. 1200us sits between the fast path and the old one — it
        // fails any regression back towards milliseconds — while still leaving
        // >3x headroom, so a loaded or slower machine does not fail it.
        let rank_cap_us = 1200.0;
        assert!(
            b.info_gain_us < rank_cap_us,
            "rank {:.1}us exceeds the {:.0}us information-gain budget \
             (fresh ranking is ~365us; the clone-per-outcome path was ~5000us)",
            b.info_gain_us,
            rank_cap_us
        );
        // Machine-normalised backstop: absolute microseconds move with the host,
        // but the RATIO between ranking and a single observe barely does. Today
        // one ranking costs ~2.4 observes; the clone-per-outcome path cost ~29.
        // This catches the regression even on a machine slow enough to make the
        // absolute cap ambiguous, and stays flat under load because both
        // timings inflate together.
        const MAX_RANK_PER_OBSERVE: f64 = 10.0;
        let per_observe = b.bayes_update_us.max(1.0);
        let rank_per_observe = b.info_gain_us / per_observe;
        assert!(
            rank_per_observe < MAX_RANK_PER_OBSERVE,
            "rank/observe ratio {:.1} exceeds {:.0} (rank {:.1}us / observe {:.1}us) \
             — ranking is rebuilding per-outcome state again",
            rank_per_observe,
            MAX_RANK_PER_OBSERVE,
            b.info_gain_us,
            b.bayes_update_us
        );

        assert!(b.route_score_us < cap_us);
    }
}

#[cfg(test)]
mod debug_tests {
    use super::*;
    #[test]
    fn debug_ranked() {
        for (condition, truth) in [
            (NetworkCondition::UpstreamProxyDown, "upstream_proxy"),
            (NetworkCondition::RoutingFailure, "routing"),
            (NetworkCondition::DnsFailure, "dns"),
        ] {
            let mut sim = NetworkSimulator::new(1, condition);
            let mut engine = DiagnosticEngine::new();
            for (i, test) in probe_sequence().iter().enumerate() {
                let mut r = sim.probe(test);
                r.timestamp = i as u64 + 1;
                println!("{} {:?} {:?}", truth, r.test, r.outcome);
                engine.observe(&r);
            }
            println!("truth={truth} ranked={:?}", &engine.ranked()[..5]);
        }
    }
}
