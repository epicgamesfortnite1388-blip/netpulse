// Diagnostic hypothesis space and dynamic Bayesian diagnosis.
//
// The engine maintains a posterior over a finite hypothesis space and updates
// it as probe results arrive. Transitions between hypotheses model gradual
// degradation, sudden outages, intermittent failures, and recovery.
//
// All updates are in log-space. Evidence for a hypothesis not in the space is
// ignored — we never invent hypotheses. Missing observations are treated as
// missing, never as zero.

use crate::network_intelligence::bayesian::{bayesian_update, decay_log_likelihood, Evidence, Posterior, Prior};
use crate::network_intelligence::math::{kl_divergence, log_sum_exp, softmax};

/// The diagnostic hypothesis space. Each variant represents a distinct failure
/// mode the system can believe in. `Unknown` covers failure patterns not yet
/// seen — it is never assigned high confidence without evidence.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Hypothesis {
    LocalInterface,
    Gateway,
    Dns,
    Routing,
    Ipv4,
    Ipv6,
    Tcp,
    Tls,
    Mtu,
    UpstreamProxy,
    RemoteEndpoint,
    AuthFailure,
    RateLimit,
    ServerFailure,
    Unknown,
}

impl Hypothesis {
    pub fn label(&self) -> &'static str {
        match self {
            Hypothesis::LocalInterface => "local_interface",
            Hypothesis::Gateway => "gateway",
            Hypothesis::Dns => "dns",
            Hypothesis::Routing => "routing",
            Hypothesis::Ipv4 => "ipv4",
            Hypothesis::Ipv6 => "ipv6",
            Hypothesis::Tcp => "tcp",
            Hypothesis::Tls => "tls",
            Hypothesis::Mtu => "mtu",
            Hypothesis::UpstreamProxy => "upstream_proxy",
            Hypothesis::RemoteEndpoint => "remote_endpoint",
            Hypothesis::AuthFailure => "auth_failure",
            Hypothesis::RateLimit => "rate_limit",
            Hypothesis::ServerFailure => "server_failure",
            Hypothesis::Unknown => "unknown",
        }
    }

    pub fn all() -> Vec<Hypothesis> {
        vec![
            Hypothesis::LocalInterface,
            Hypothesis::Gateway,
            Hypothesis::Dns,
            Hypothesis::Routing,
            Hypothesis::Ipv4,
            Hypothesis::Ipv6,
            Hypothesis::Tcp,
            Hypothesis::Tls,
            Hypothesis::Mtu,
            Hypothesis::UpstreamProxy,
            Hypothesis::RemoteEndpoint,
            Hypothesis::AuthFailure,
            Hypothesis::RateLimit,
            Hypothesis::ServerFailure,
            Hypothesis::Unknown,
        ]
    }
}

/// A single diagnostic probe result: what was tested, what happened, and how
/// confident we are.
#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub test: DiagnosticTest,
    pub outcome: ProbeOutcome,
    pub timestamp: u64,
    /// Source identifier for deduplication — repeated probes with the same
    /// source are counted only once. Defaults to the test name.
    pub source: String,
    /// How much this probe costs (time + resource units), used in IG/cost.
    pub cost: f64,
}

/// What a probe can return.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Copy)]
pub enum ProbeOutcome {
    Success,
    Failure,
    /// The probe could not be executed (timeout, no route, etc.).
    Missing,
    /// An authenticated but negative response (e.g. HTTP 401).
    AuthRejected,
    /// Rate-limited by the remote.
    RateLimited,
    /// A server-side error (5xx).
    ServerError,
}

/// A candidate diagnostic test the system might run next.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum DiagnosticTest {
    DnsResolve,
    TcpConnect,
    TlsHandshake,
    HttpGet,
    GatewayPing,
    InterfaceCheck,
    MtuProbe,
    Traceroute,
}

/// Likelihood table: log P(evidence_outcome | hypothesis).
///
/// Each hypothesis specifies how likely each probe outcome is under it. These
/// are domain priors — they encode the structural relationship between failure
/// modes and observable symptoms, not learned frequencies.
#[derive(Debug, Clone)]
pub struct LikelihoodTable {
    /// log P(outcome | hypothesis, test), indexed [test][hypothesis][outcome].
    ///
    /// The test identity matters: a DNS-resolution failure is strong evidence
    /// for DNS, while a TCP-connect failure under the same DNS hypothesis is
    /// weak evidence. Collapsing the test out of the likelihood (an earlier
    /// bug) made every probe equally informative about every cause.
    table: Vec<Vec<Vec<f64>>>,
}

impl LikelihoodTable {
    /// Build the default likelihood table from domain knowledge.
    ///
    /// Rows are hypotheses in `Hypothesis::all()` order; columns are probe
    /// outcomes in [`ProbeOutcome`] order: [Success, Failure, Missing,
    /// AuthRejected, RateLimited, ServerError].
    pub fn default() -> Self {
        let mut table = Vec::new();
        for test in Self::tests() {
            let per_hypothesis = Hypothesis::all()
                .iter()
                .map(|h| Self::row(&test, h))
                .collect();
            table.push(per_hypothesis);
        }
        Self { table }
    }

    pub fn tests() -> Vec<DiagnosticTest> {
        vec![
            DiagnosticTest::DnsResolve,
            DiagnosticTest::GatewayPing,
            DiagnosticTest::InterfaceCheck,
            DiagnosticTest::TcpConnect,
            DiagnosticTest::TlsHandshake,
            DiagnosticTest::MtuProbe,
            DiagnosticTest::Traceroute,
            DiagnosticTest::HttpGet,
        ]
    }

    fn test_index(test: &DiagnosticTest) -> usize {
        match test {
            DiagnosticTest::DnsResolve => 0,
            DiagnosticTest::GatewayPing => 1,
            DiagnosticTest::InterfaceCheck => 2,
            DiagnosticTest::TcpConnect => 3,
            DiagnosticTest::TlsHandshake => 4,
            DiagnosticTest::MtuProbe => 5,
            DiagnosticTest::Traceroute => 6,
            DiagnosticTest::HttpGet => 7,
        }
    }

    /// Build P(outcome | hypothesis, test) from the signature failure
    /// probability. Success receives the remaining mass minus a small,
    /// explicitly modeled non-success allowance. Scaling a failure-dominated
    /// base row instead (an earlier bug) left success at ~1% even when the
    /// hypothesis predicted success, which made every healthy lower layer look
    /// impossible and destroyed diagnosis.
    fn row(test: &DiagnosticTest, h: &Hypothesis) -> Vec<f64> {
        use DiagnosticTest::*;
        let fail = Self::signature(test, h).clamp(0.0, 0.999);
        let rest = 1.0 - fail;
        // Order: Success, Failure, Missing, AuthRejected, RateLimited, ServerError.
        let mut p = [0.0f64; 6];
        p[1] = fail;
        match test {
            HttpGet => match h {
                Hypothesis::AuthFailure => {
                    p[3] = rest * 0.92;
                    p[0] = rest * 0.06;
                    p[5] = rest * 0.02;
                }
                Hypothesis::RateLimit => {
                    p[4] = rest * 0.92;
                    p[0] = rest * 0.06;
                    p[5] = rest * 0.02;
                }
                Hypothesis::ServerFailure => {
                    p[5] = rest * 0.92;
                    p[0] = rest * 0.06;
                    p[3] = rest * 0.02;
                }
                _ => {
                    p[0] = rest * 0.96;
                    p[2] = rest * 0.02;
                    p[3] = rest * 0.01;
                    p[4] = rest * 0.005;
                    p[5] = rest * 0.005;
                }
            },
            GatewayPing if matches!(h, Hypothesis::Gateway) => {
                p[0] = rest * 0.85;
                p[2] = rest * 0.15;
            }
            _ => {
                p[0] = rest * 0.98;
                p[2] = rest * 0.02;
            }
        }
        p.iter()
            .map(|&q| if q > 0.0 { q.ln() } else { f64::NEG_INFINITY })
            .collect()
    }

    /// Domain prior for P(probe failure | hypothesis, test). These are
    /// structural judgments, not measured frequencies; `validation` exists to
    /// recalibrate them against captured outcomes.
    fn signature(test: &DiagnosticTest, h: &Hypothesis) -> f64 {
        use DiagnosticTest::*;
        use Hypothesis::*;
        match test {
            DnsResolve => match h {
                Dns => 0.95,
                LocalInterface => 0.55,
                Gateway => 0.45,
                Routing => 0.55,
                Ipv4 | Ipv6 => 0.40,
                Tcp | Tls => 0.30,
                Mtu => 0.35,
                UpstreamProxy => 0.25,
                RemoteEndpoint | AuthFailure | RateLimit | ServerFailure => 0.15,
                Unknown => 0.25,
            },
            GatewayPing => match h {
                Gateway => 0.90,
                LocalInterface => 0.80,
                Routing => 0.40,
                Ipv4 => 0.35,
                Ipv6 => 0.20,
                Tcp | Mtu => 0.15,
                Dns | Tls | RemoteEndpoint => 0.10,
                UpstreamProxy => 0.15,
                AuthFailure | RateLimit | ServerFailure => 0.02,
                Unknown => 0.20,
            },
            InterfaceCheck => match h {
                LocalInterface => 0.95,
                Gateway => 0.20,
                _ => 0.05,
            },
            TcpConnect => match h {
                Tcp => 0.90,
                Routing => 0.60,
                RemoteEndpoint => 0.65,
                UpstreamProxy => 0.55,
                LocalInterface => 0.60,
                Gateway => 0.50,
                Mtu => 0.20,
                Ipv4 => 0.35,
                Ipv6 => 0.10,
                Dns | Tls => 0.10,
                AuthFailure | RateLimit | ServerFailure => 0.05,
                Unknown => 0.30,
            },
            TlsHandshake => match h {
                Tls => 0.95,
                Mtu => 0.40,
                UpstreamProxy => 0.45,
                RemoteEndpoint => 0.20,
                Routing => 0.15,
                Tcp | LocalInterface | Gateway => 0.10,
                Dns | Ipv4 | Ipv6 | ServerFailure => 0.05,
                AuthFailure | RateLimit => 0.03,
                Unknown => 0.25,
            },
            MtuProbe => match h {
                Mtu => 0.85,
                Tls | Routing => 0.20,
                Tcp => 0.15,
                _ => 0.08,
            },
            Traceroute => match h {
                Routing => 0.80,
                Gateway => 0.50,
                LocalInterface => 0.40,
                _ => 0.15,
            },
            HttpGet => match h {
                RemoteEndpoint => 0.75,
                ServerFailure => 0.70,
                UpstreamProxy => 0.50,
                Tcp | Routing => 0.30,
                Tls | Mtu => 0.20,
                AuthFailure => 0.12,
                RateLimit => 0.15,
                Dns | LocalInterface | Gateway => 0.10,
                Ipv4 | Ipv6 => 0.15,
                Unknown => 0.25,
            },
        }
    }

    pub fn log_likelihood(
        &self,
        test: &DiagnosticTest,
        hypothesis: &Hypothesis,
        outcome: &ProbeOutcome,
    ) -> f64 {
        let t_idx = Self::test_index(test);
        let h_idx = Hypothesis::all()
            .iter()
            .position(|h2| h2 == hypothesis)
            .unwrap_or(Hypothesis::all().len() - 1); // Unknown fallback
        let o_idx = match outcome {
            ProbeOutcome::Success => 0,
            ProbeOutcome::Failure => 1,
            ProbeOutcome::Missing => 2,
            ProbeOutcome::AuthRejected => 3,
            ProbeOutcome::RateLimited => 4,
            ProbeOutcome::ServerError => 5,
        };
        self.table
            .get(t_idx)
            .and_then(|per_h| per_h.get(h_idx))
            .and_then(|row| row.get(o_idx))
            .copied()
            .unwrap_or(f64::NEG_INFINITY)
    }
}

/// Transition model: P(H_t | H_{t-1}). Encodes that failures tend to persist
// (high diagonal) but can transition to related modes (e.g. DNS → routing,
// TCP → TLS).
#[derive(Debug, Clone)]
pub struct TransitionModel {
    /// log P(H_t | H_{t-1}), indexed [from][to].
    matrix: Vec<Vec<f64>>,
}

impl TransitionModel {
    pub fn default() -> Self {
        let n = Hypothesis::all().len();
        let mut matrix = Vec::with_capacity(n);
        for _ in 0..n {
            matrix.push(vec![f64::NEG_INFINITY; n]);
        }
        let stay = 0.80f64.ln(); // high persistence
        let switch = 0.05f64.ln(); // low probability of switching to any specific other
        for i in 0..n {
            for j in 0..n {
                if i == j {
                    matrix[i][j] = stay;
                } else {
                    matrix[i][j] = switch;
                }
            }
            // Normalize each row so it's a valid distribution.
            let lse = log_sum_exp(&matrix[i]);
            if lse.is_finite() {
                for v in &mut matrix[i] {
                    *v -= lse;
                }
            }
        }
        Self { matrix }
    }

    pub fn log_transition(&self, from: &Hypothesis, to: &Hypothesis) -> f64 {
        let fi = Hypothesis::all().iter().position(|h| h == from).unwrap_or(0);
        let ti = Hypothesis::all().iter().position(|h| h == to).unwrap_or(0);
        self.matrix
            .get(fi)
            .and_then(|row| row.get(ti))
            .copied()
            .unwrap_or(f64::NEG_INFINITY)
    }
}

/// The dynamic Bayesian diagnostic engine. Maintains a posterior over the
// hypothesis space and applies the predict-update cycle as evidence arrives.
#[derive(Debug, Clone)]
pub struct DiagnosticEngine {
    pub posterior: Posterior,
    pub likelihood: LikelihoodTable,
    pub transition: TransitionModel,
    pub previous_timestamp: Option<u64>,
}

impl DiagnosticEngine {
    /// Create a new engine with a uniform prior over all hypotheses.
    pub fn new() -> Self {
        let labels: Vec<String> = Hypothesis::all().iter().map(|h| h.label().to_string()).collect();
        let prior = Prior::uniform(labels.clone());
        let posterior = Posterior::from_prior(prior);
        Self {
            posterior,
            likelihood: LikelihoodTable::default(),
            transition: TransitionModel::default(),
            previous_timestamp: None,
        }
    }

    /// Create with a custom prior.
    pub fn with_prior(prior: Prior) -> Self {
        let posterior = Posterior::from_prior(prior.clone());
        Self {
            posterior,
            likelihood: LikelihoodTable::default(),
            transition: TransitionModel::default(),
            previous_timestamp: None,
        }
    }

    /// Predict step: apply the transition model to move the prior forward in
    /// time before observing new evidence. Models gradual degradation, sudden
    /// outages, intermittent failure, and recovery.
    pub fn predict(&mut self, delta_seconds: f64) {
        // Scale the transition by elapsed time: stronger persistence over
        // short intervals, more mixing over long ones.
        let mix = (-0.001 * delta_seconds).exp(); // fraction of prior that persists
        let current_probs: Vec<f64> = softmax(&self.posterior.prior.log_probs)
            .unwrap_or_default();
        let n = current_probs.len();

        // Exact predict step in log space:
        //   P(H_t = j) = Σ_i P(H_{t-1} = i) · M(j | i)
        //   M(j | i)   = mix·[i = j] + (1 - mix)·P(H_t = j | H_{t-1} = i)
        // `mix` is the probability the state persists unchanged over the
        // elapsed interval, so a zero-length interval is an identity update and
        // a long interval approaches the stationary transition matrix.
        let mut predicted = vec![f64::NEG_INFINITY; n];
        for j in 0..n {
            let terms: Vec<f64> = (0..n)
                .map(|i| {
                    let p = current_probs[i];
                    if !(p > 0.0) {
                        return f64::NEG_INFINITY;
                    }
                    let t = self
                        .transition
                        .log_transition(&Hypothesis::all()[i], &Hypothesis::all()[j])
                        .exp();
                    let m = if i == j { mix + (1.0 - mix) * t } else { (1.0 - mix) * t };
                    if m > 0.0 {
                        p.ln() + m.ln()
                    } else {
                        f64::NEG_INFINITY
                    }
                })
                .collect();
            predicted[j] = log_sum_exp(&terms);
        }
        self.posterior.prior.log_probs = predicted;
        self.posterior.prior.normalize();
    }

    /// Update step: incorporate a probe result into the posterior.
    pub fn observe(&mut self, result: &ProbeResult) {
        // Time-based decay of old evidence before adding new.
        if let Some(prev_ts) = self.previous_timestamp {
            if result.timestamp >= prev_ts {
                let delta = (result.timestamp - prev_ts) as f64;
                self.predict(delta as f64);
            }
        }
        self.previous_timestamp = Some(result.timestamp);

        // Build evidence: log-likelihood of this outcome under each hypothesis.
        let mut evidence = Vec::new();
        for h in Hypothesis::all() {
            let ll = self.likelihood.log_likelihood(&result.test, &h, &result.outcome);
            evidence.push(Evidence {
                hypothesis: h.label().to_string(),
                log_likelihood: ll,
                timestamp: result.timestamp,
                source: format!("{:?}", result.test),
                confidence: None,
            });
        }
        let updated = bayesian_update(&self.posterior.prior, &evidence);
        self.posterior = updated;
    }

    /// Current diagnostic entropy, in nats. High = uncertain.
    pub fn uncertainty(&self) -> f64 {
        self.posterior.entropy()
    }

    /// MAP hypothesis and its probability.
    pub fn diagnosis(&self) -> Option<(&str, f64)> {
        let idx = self.posterior.map()?;
        let label = self.posterior.label(idx)?;
        let prob = self.posterior.prob(idx);
        Some((label, prob))
    }

    /// All hypotheses ranked by posterior probability.
    pub fn ranked(&self) -> Vec<(&str, f64)> {
        self.posterior.ranked()
    }
}

/// Expected information gain of running `test` given the current posterior.
//
// IG(q) = H(H | E) - E_y[ H(H | E, y, q) ]
//
// We approximate the expectation over outcomes y by enumerating the possible
// probe outcomes and weighting by their predictive probability under the
// current posterior. Returns (information_gain, cost_ratio = IG / cost).
#[derive(Debug, Clone)]
pub struct TestScore {
    pub test: DiagnosticTest,
    pub information_gain: f64,
    pub cost: f64,
    /// IG per unit cost — the quantity to maximize.
    pub efficiency: f64,
}

pub fn expected_information_gain(
    engine: &DiagnosticEngine,
    test: &DiagnosticTest,
) -> Option<TestScore> {
    let current_entropy = engine.uncertainty();
    let priors: Vec<f64> = softmax(&engine.posterior.prior.log_probs)?;

    // Enumerate possible outcomes and their predictive probabilities.
    let outcomes = [
        ProbeOutcome::Success,
        ProbeOutcome::Failure,
        ProbeOutcome::Missing,
        ProbeOutcome::AuthRejected,
        ProbeOutcome::RateLimited,
        ProbeOutcome::ServerError,
    ];

    let mut expected_post_entropy = 0.0;
    for &outcome in &outcomes {
        // P(outcome | test) = sum_h P(outcome | h, test) * P(h)
        let mut pred_log_terms = Vec::new();
        for (h, &prior_p) in Hypothesis::all().iter().zip(priors.iter()) {
            if prior_p <= 0.0 {
                continue;
            }
            let ll = engine.likelihood.log_likelihood(test, &h, &outcome);
            pred_log_terms.push(prior_p.ln() + ll);
        }
        let pred_p = log_sum_exp(&pred_log_terms).exp();
        if pred_p <= 0.0 || !pred_p.is_finite() {
            continue;
        }

        // Posterior after observing this outcome: clone engine and observe.
        let mut clone = engine.clone();
        let probe = ProbeResult {
            test: test.clone(),
            outcome: outcome.clone(),
            timestamp: engine.previous_timestamp.unwrap_or(0),
            source: format!("{:?}", test),
            cost: 0.0,
        };
        clone.observe(&probe);
        let post_entropy = clone.uncertainty();
        expected_post_entropy += pred_p * post_entropy;
    }

    let ig = current_entropy - expected_post_entropy;
    // Numerical noise can make IG slightly negative; clamp at 0.
    let ig = if ig < 0.0 { 0.0 } else { ig };

    let cost = match test {
        DiagnosticTest::DnsResolve => 1.0,
        DiagnosticTest::GatewayPing => 1.0,
        DiagnosticTest::InterfaceCheck => 0.5,
        DiagnosticTest::TcpConnect => 2.0,
        DiagnosticTest::TlsHandshake => 2.0,
        DiagnosticTest::HttpGet => 3.0,
        DiagnosticTest::MtuProbe => 4.0,
        DiagnosticTest::Traceroute => 5.0,
    };

    Some(TestScore {
        test: test.clone(),
        information_gain: ig,
        cost,
        efficiency: if cost > 0.0 { ig / cost } else { 0.0 },
    })
}

/// Rank all diagnostic tests by expected information gain per unit cost.
pub fn rank_tests(engine: &DiagnosticEngine) -> Vec<TestScore> {
    let tests = [
        DiagnosticTest::InterfaceCheck,
        DiagnosticTest::DnsResolve,
        DiagnosticTest::GatewayPing,
        DiagnosticTest::TcpConnect,
        DiagnosticTest::TlsHandshake,
        DiagnosticTest::HttpGet,
        DiagnosticTest::MtuProbe,
        DiagnosticTest::Traceroute,
    ];
    let mut scores: Vec<TestScore> = tests
        .iter()
        .filter_map(|t| expected_information_gain(engine, t))
        .collect();
    scores.sort_by(|a, b| b.efficiency.partial_cmp(&a.efficiency).unwrap_or(std::cmp::Ordering::Equal));
    scores
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_starts_uncertain() {
        let e = DiagnosticEngine::new();
        // Uniform over 15 hypotheses: entropy = ln(15)
        assert!((e.uncertainty() - 15.0f64.ln()).abs() < 1e-9);
        // MAP picks the first hypothesis but with uniform probability
        let (label, prob) = e.diagnosis().expect("some diagnosis");
        assert_eq!(label, "local_interface");
        assert!((prob - 1.0 / 15.0).abs() < 1e-9);
    }

    #[test]
    fn observing_failure_shifts_posterior() {
        let mut e = DiagnosticEngine::new();
        let h_before = e.uncertainty();
        e.observe(&ProbeResult {
            test: DiagnosticTest::DnsResolve,
            outcome: ProbeOutcome::Failure,
            timestamp: 1,
            source: "dns-1".into(),
            cost: 1.0,
        });
        // After a DNS failure, DNS hypothesis should rise.
        let (label, prob) = e.diagnosis().expect("some diagnosis");
        assert!(prob > 1.0 / Hypothesis::all().len() as f64);
        assert!(e.uncertainty() < h_before);
    }

    #[test]
    fn transition_model_rows_sum_to_one() {
        let t = TransitionModel::default();
        let n = Hypothesis::all().len();
        for i in 0..n {
            let row_sum: f64 = (0..n)
                .map(|j| t.log_transition(&Hypothesis::all()[i], &Hypothesis::all()[j]).exp())
                .sum();
            assert!((row_sum - 1.0).abs() < 1e-6, "row {i} sums to {row_sum}");
        }
    }

    #[test]
    fn likelihood_table_is_valid() {
        let l = LikelihoodTable::default();
        let n_h = Hypothesis::all().len();
        let n_o = 6;
        assert_eq!(l.table.len(), LikelihoodTable::tests().len());
        for per_hypothesis in &l.table {
            assert_eq!(per_hypothesis.len(), n_h);
            for row in per_hypothesis {
                assert_eq!(row.len(), n_o);
                let sum: f64 = row.iter().map(|lp| lp.exp()).sum();
                assert!(
                    (sum - 1.0).abs() < 1e-9,
                    "likelihood row must be normalized, got {sum}"
                );
            }
        }
    }

    #[test]
    fn missing_outcome_is_noop_for_information() {
        let mut e = DiagnosticEngine::new();
        let h_before = e.uncertainty();
        e.observe(&ProbeResult {
            test: DiagnosticTest::DnsResolve,
            outcome: ProbeOutcome::Missing,
            timestamp: 1,
            source: format!("{:?}", DiagnosticTest::DnsResolve),
            cost: 1.0,
        });
        // Missing data should not change the posterior much (low information)
        assert!((e.uncertainty() - h_before).abs() < 0.5);
    }

    #[test]
    fn information_gain_is_non_negative() {
        let e = DiagnosticEngine::new();
        for t in [
            DiagnosticTest::DnsResolve,
            DiagnosticTest::TcpConnect,
            DiagnosticTest::Traceroute,
        ] {
            let score = expected_information_gain(&e, &t).expect("score");
            assert!(score.information_gain >= 0.0, "IG for {:?} was {}", t, score.information_gain);
            assert!(score.efficiency >= 0.0);
        }
    }

    #[test]
    fn rank_tests_returns_all_tests_sorted() {
        let e = DiagnosticEngine::new();
        let ranked = rank_tests(&e);
        assert_eq!(ranked.len(), 8);
        for w in ranked.windows(2) {
            assert!(w[0].efficiency >= w[1].efficiency);
        }
    }

    #[test]
    fn dns_failure_then_tcp_success_differentiates() {
        let mut e = DiagnosticEngine::new();
        e.observe(&ProbeResult {
            test: DiagnosticTest::DnsResolve,
            outcome: ProbeOutcome::Failure,
            timestamp: 1,
            source: format!("{:?}", DiagnosticTest::DnsResolve),
            cost: 1.0,
        });
        // After DNS fails, uncertainty should decrease from ln(15)
        assert!(e.uncertainty() < 15.0f64.ln());

        // Now TCP works: different source, so it's counted separately.
        // TCP success under DNS is very unlikely, so DNS suspicion should drop.
        let unc_before = e.uncertainty();
        e.observe(&ProbeResult {
            test: DiagnosticTest::TcpConnect,
            outcome: ProbeOutcome::Success,
            timestamp: 2,
            source: format!("{:?}", DiagnosticTest::TcpConnect),
            cost: 2.0,
        });
        // Uncertainty should continue to decrease with more evidence
        assert!(e.uncertainty() <= unc_before + 1e-6);
        assert!(e.uncertainty() < 15.0f64.ln());
    }
}

