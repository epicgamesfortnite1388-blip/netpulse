// Diagnostic hypothesis space and dynamic Bayesian diagnosis.
//
// The engine maintains a posterior over a finite hypothesis space and updates
// it as probe results arrive. Transitions between hypotheses model gradual
// degradation, sudden outages, intermittent failures, and recovery.
//
// All updates are in log-space. Evidence for a hypothesis not in the space is
// ignored — we never invent hypotheses. Missing observations are treated as
// missing, never as zero.

use crate::network_intelligence::bayesian::{
    bayesian_update, decay_log_likelihood, evidence_movement, Evidence, Posterior, Prior,
};
use crate::network_intelligence::evidence::correlation::CorrelationModel;
use crate::network_intelligence::math::{entropy_of, kl_divergence, log_sum_exp, softmax};

/// The diagnostic hypothesis space. Each variant represents a distinct failure
/// mode the system can believe in. `Unknown` covers failure patterns not yet
/// seen — it is never assigned high confidence without evidence.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Hypothesis {
    Gateway,
    Dns,
    DnsInconsistency,
    Routing,
    Ipv4,
    Ipv6,
    Tcp,
    Tls,
    Mtu,
    QuicUdpFailure,
    UpstreamProxy,
    RemoteEndpoint,
    AuthFailure,
    RateLimit,
    ApplicationFailure,
    ServerFailure,
    CongestionOrPacketLoss,
    NetworkInterferenceOrFiltering,
    Unknown,
}

impl Hypothesis {
    pub fn label(&self) -> &'static str {
        match self {
            Hypothesis::Gateway => "gateway",
            Hypothesis::Dns => "dns",
            Hypothesis::DnsInconsistency => "dns_inconsistency",
            Hypothesis::Routing => "routing",
            Hypothesis::Ipv4 => "ipv4",
            Hypothesis::Ipv6 => "ipv6",
            Hypothesis::Tcp => "tcp",
            Hypothesis::Tls => "tls",
            Hypothesis::Mtu => "mtu",
            Hypothesis::QuicUdpFailure => "quic_udp_failure",
            Hypothesis::UpstreamProxy => "upstream_proxy",
            Hypothesis::RemoteEndpoint => "remote_endpoint",
            Hypothesis::AuthFailure => "auth_failure",
            Hypothesis::RateLimit => "rate_limit",
            Hypothesis::ApplicationFailure => "application_failure",
            Hypothesis::ServerFailure => "server_failure",
            Hypothesis::CongestionOrPacketLoss => "congestion_or_packet_loss",
            Hypothesis::NetworkInterferenceOrFiltering => "network_interference_or_filtering",
            Hypothesis::Unknown => "unknown",
        }
    }

    pub fn all() -> Vec<Hypothesis> {
        vec![
            Hypothesis::Gateway,
            Hypothesis::Dns,
            Hypothesis::DnsInconsistency,
            Hypothesis::Routing,
            Hypothesis::Ipv4,
            Hypothesis::Ipv6,
            Hypothesis::Tcp,
            Hypothesis::Tls,
            Hypothesis::Mtu,
            Hypothesis::QuicUdpFailure,
            Hypothesis::UpstreamProxy,
            Hypothesis::RemoteEndpoint,
            Hypothesis::AuthFailure,
            Hypothesis::RateLimit,
            Hypothesis::ApplicationFailure,
            Hypothesis::ServerFailure,
            Hypothesis::CongestionOrPacketLoss,
            Hypothesis::NetworkInterferenceOrFiltering,
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

impl DiagnosticTest {
    /// Stable id used by the correlated-evidence model. Independent of the
    /// Rust variant name so the dependency structure can be configured without
    /// changing the diagnostic enum.
    pub fn correlation_id(&self) -> &'static str {
        match self {
            DiagnosticTest::DnsResolve => "dns-lookup",
            DiagnosticTest::TcpConnect => "tcp-connect",
            DiagnosticTest::TlsHandshake => "tls-handshake",
            DiagnosticTest::HttpGet => "http-reachability",
            DiagnosticTest::GatewayPing => "gateway-ping",
            DiagnosticTest::InterfaceCheck => "interface-check",
            DiagnosticTest::MtuProbe => "mtu-probe",
            DiagnosticTest::Traceroute => "traceroute",
        }
    }
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
                Hypothesis::ApplicationFailure | Hypothesis::ServerFailure => {
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
    ///
    /// `Unknown` is the residual "no specific fault evidenced" state and takes
    /// a small failure probability on every test. Without a residual, a probe
    /// that succeeds still has to hand its mass to *some* fault hypothesis, and
    /// the winner is whichever fault hides best from good news — which made a
    /// fully healthy health check promote a cause instead of clearing one.
    fn signature(test: &DiagnosticTest, h: &Hypothesis) -> f64 {
        use DiagnosticTest::*;
        use Hypothesis::*;
        // Failure propagates upward: a dead interface breaks DNS, TCP, TLS,
        // HTTP and MTU probes; a TLS-only fault leaves every lower layer
        // healthy. These numbers are structural priors for recalibration by
        // `validation`, not measured frequencies.
        match test {
            DnsResolve => match h {
                Dns => 0.97,
                DnsInconsistency => 0.95,
                Gateway => 0.55,
                Routing => 0.50,
                Ipv4 | Ipv6 => 0.15,
                Tcp => 0.05,
                Tls | Mtu => 0.05,
                UpstreamProxy => 0.05,
                RemoteEndpoint | AuthFailure | RateLimit | ApplicationFailure | ServerFailure => 0.02,
                QuicUdpFailure => 0.10,
                CongestionOrPacketLoss => 0.30,
                NetworkInterferenceOrFiltering => 0.30,
                Unknown => 0.02,
            },
            GatewayPing => match h {
                Gateway => 0.95,
                Routing => 0.45,
                Ipv4 => 0.40,
                Ipv6 => 0.25,
                Tcp | UpstreamProxy => 0.20,
                Mtu => 0.15,
                Dns => 0.15,
                Tls => 0.10,
                RemoteEndpoint => 0.02,
                DnsInconsistency => 0.30,
                QuicUdpFailure => 0.30,
                AuthFailure | RateLimit | ApplicationFailure | ServerFailure => 0.02,
                CongestionOrPacketLoss => 0.30,
                NetworkInterferenceOrFiltering => 0.30,
                Unknown => 0.02,
            },
            // The `LocalInterface` hypothesis was removed in the 19-hypothesis
            // refactor. A leftover `LocalInterface => ...` arm here was parsed by
            // Rust as an irrefutable binding, giving EVERY hypothesis a 0.97
            // failure probability and making the arms below unreachable. An
            // interface failure now points weakly at the gateway (the closest
            // surviving lower-layer hypothesis) and is otherwise non-specific.
            InterfaceCheck => match h {
                Gateway => 0.25,
                Unknown => 0.02,
                _ => 0.05,
            },
            TcpConnect => match h {
                Tcp => 0.90,
                Gateway => 0.85,
                Routing => 0.85,
                RemoteEndpoint => 0.80,
                // Direct probes bypass an upstream proxy, so a dead proxy does
                // not make direct TCP fail. Only HTTP (which is proxied) does.
                UpstreamProxy => 0.05,
                Mtu => 0.30,
                Ipv4 => 0.35,
                Ipv6 => 0.10,
                Dns => 0.10,
                DnsInconsistency => 0.20,
                Tls => 0.05,
                AuthFailure | RateLimit | ApplicationFailure | ServerFailure => 0.05,
                QuicUdpFailure => 0.40,
                CongestionOrPacketLoss => 0.30,
                NetworkInterferenceOrFiltering => 0.30,
                Unknown => 0.02,
            },
            TlsHandshake => match h {
                Tls | Gateway | Tcp => 0.95,
                Routing | RemoteEndpoint => 0.90,
                Mtu => 0.60,
                UpstreamProxy => 0.05,
                Dns => 0.10,
                Ipv4 | Ipv6 => 0.10,
                DnsInconsistency => 0.20,
                ApplicationFailure | ServerFailure => 0.05,
                QuicUdpFailure => 0.40,
                AuthFailure | RateLimit => 0.03,
                CongestionOrPacketLoss => 0.30,
                NetworkInterferenceOrFiltering => 0.30,
                Unknown => 0.02,
            },
            MtuProbe => match h {
                Mtu => 0.90,
                Gateway => 0.90,
                Routing => 0.80,
                RemoteEndpoint => 0.10,
                Tcp => 0.50,
                UpstreamProxy => 0.05,
                Tls => 0.20,
                Dns => 0.30,
                DnsInconsistency => 0.40,
                QuicUdpFailure => 0.40,
                CongestionOrPacketLoss => 0.80,
                NetworkInterferenceOrFiltering => 0.50,
                Unknown => 0.02,
                _ => 0.08,
            },
            Traceroute => match h {
                Routing | Gateway => 0.90,
                RemoteEndpoint => 0.70,
                Ipv4 | Ipv6 => 0.50,
                Dns => 0.30,
                DnsInconsistency => 0.40,
                QuicUdpFailure => 0.40,
                CongestionOrPacketLoss => 0.80,
                NetworkInterferenceOrFiltering => 0.50,
                Unknown => 0.02,
                _ => 0.15,
            },
            HttpGet => match h {
                Gateway | Routing => 0.95,
                UpstreamProxy | RemoteEndpoint => 0.90,
                Tls => 0.90,
                Tcp => 0.85,
                // A 5xx is observed as ProbeOutcome::ServerError, not as a
                // transport failure; expecting Failure here made every HTTP
                // failure look like a server application error.
                ApplicationFailure | ServerFailure => 0.10,
                Mtu => 0.60,
                Ipv4 | Ipv6 => 0.50,
                Dns => 0.30,
                DnsInconsistency => 0.30,
                QuicUdpFailure => 0.40,
                RateLimit => 0.02,
                AuthFailure => 0.02,
                CongestionOrPacketLoss => 0.30,
                NetworkInterferenceOrFiltering => 0.40,
                Unknown => 0.02,
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

    /// Override the log-likelihood of a single (test, hypothesis, outcome)
    /// cell. Used by the likelihood calibrator to fold observed outcomes back
    /// into the diagnostic model.
    pub fn set_log_likelihood(
        &mut self,
        test: &DiagnosticTest,
        hypothesis: &Hypothesis,
        outcome: &ProbeOutcome,
        log_prob: f64,
    ) {
        let t_idx = Self::test_index(test);
        let h_idx = Hypothesis::all()
            .iter()
            .position(|h| h == hypothesis)
            .unwrap_or_else(|| panic!("unknown hypothesis {:?}", hypothesis));
        let o_idx = match outcome {
            ProbeOutcome::Success => 0,
            ProbeOutcome::Failure => 1,
            ProbeOutcome::Missing => 2,
            ProbeOutcome::AuthRejected => 3,
            ProbeOutcome::RateLimited => 4,
            ProbeOutcome::ServerError => 5,
        };
        let lp = log_prob.clamp(f64::NEG_INFINITY, 0.0);
        self.table[t_idx][h_idx][o_idx] = lp;
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
    /// Explicit dependency structure over recently observed probes. Correlated
    /// probes share a causal path and must not each multiply the posterior as
    /// independent proof.
    pub correlation: CorrelationModel,
    /// Recently observed correlation ids, bounded so memory cannot grow with
    /// the length of the session. `&'static str` keeps the hot Bayesian update
    /// allocation-free.
    observation_history: Vec<&'static str>,
    /// Weight applied to the most recent observation (1.0 = independent).
    pub last_evidence_weight: f64,
    /// The distribution this engine started from, kept unchanged so the UI can
    /// show how far each belief moved. `posterior.prior` is the *current*
    /// distribution and is rewritten by every update.
    initial_prior: Prior,
}

/// Most recent probes whose dependency structure is considered. Older probes
/// have already been decayed by the transition model; keeping the window
/// bounded keeps `observe` O(1) in session length.
const MAX_CORRELATION_HISTORY: usize = 32;

/// A gap longer than this starts a new diagnostic window: evidence from an
/// earlier incident must not discount probes taken hours later.
///
/// Unit: SECONDS, the same clock as [`ProbeResult::timestamp`] and the
/// `predict` step. The canonical feeder (`observe_diagnostic_probes_matching`)
/// converts measurement milliseconds to seconds at the boundary; comparing
/// a seconds gap against a millisecond-valued constant would make the window
/// 3.5 days instead of 5 minutes and keep stale evidence alive for hours.
const CORRELATION_WINDOW_SECONDS: u64 = 5 * 60;

impl DiagnosticEngine {
    /// Create a new engine with a uniform prior over all hypotheses.
    pub fn new() -> Self {
        let labels: Vec<String> = Hypothesis::all().iter().map(|h| h.label().to_string()).collect();
        let prior = Prior::uniform(labels.clone());
        let posterior = Posterior::from_prior(prior.clone());
        Self {
            posterior,
            initial_prior: prior,
            likelihood: LikelihoodTable::default(),
            transition: TransitionModel::default(),
            previous_timestamp: None,
            correlation: CorrelationModel::new(),
            observation_history: Vec::new(),
            last_evidence_weight: 1.0,
        }
    }

    /// Replace the correlated-evidence model (used by tests and calibration).
    pub fn with_correlation(mut self, correlation: CorrelationModel) -> Self {
        self.correlation = correlation;
        self
    }

    /// Create with a custom prior.
    pub fn with_prior(prior: Prior) -> Self {
        let posterior = Posterior::from_prior(prior.clone());
        Self {
            posterior,
            initial_prior: prior,
            likelihood: LikelihoodTable::default(),
            transition: TransitionModel::default(),
            previous_timestamp: None,
            correlation: CorrelationModel::new(),
            observation_history: Vec::new(),
            last_evidence_weight: 1.0,
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
        // Capture the previous timestamp BEFORE advancing it. The gap check
        // below must measure the elapsed time since the last observation, not
        // since the value we are about to write (which would always be zero).
        let previous = self.previous_timestamp;
        if let Some(prev_ts) = previous {
            if result.timestamp >= prev_ts {
                let delta = (result.timestamp - prev_ts) as f64;
                self.predict(delta as f64);
            }
        }

        // Correlated probes are real evidence, but not independent evidence.
        // Discount this observation when a different earlier probe shares its
        // causal path; the first member of a cluster keeps full weight. A long
        // gap starts a new window, and repeating the same test over time is new
        // evidence rather than correlation.
        if previous.is_some_and(|prev| result.timestamp.saturating_sub(prev) > CORRELATION_WINDOW_SECONDS)
        {
            self.observation_history.clear();
        }
        self.previous_timestamp = Some(result.timestamp);
        let test_id = result.test.correlation_id();
        let weight = self.evidence_weight(&result.test);
        self.last_evidence_weight = weight;
        self.observation_history.push(test_id);
        if self.observation_history.len() > MAX_CORRELATION_HISTORY {
            self.observation_history.remove(0);
        }

        // Build evidence: log-likelihood of this outcome under each hypothesis.
        let mut evidence = Vec::new();
        for h in Hypothesis::all() {
            let ll = self.likelihood.log_likelihood(&result.test, &h, &result.outcome);
            evidence.push(Evidence {
                hypothesis: h.label().to_string(),
                // The correlation discount is already inside this value
                // (`evidence_movement` applies it once for the whole rule), so
                // the confidence is final: 1.0 stops `bayesian_update` scaling
                // the same weight in a second time.
                log_likelihood: evidence_movement(ll, weight),
                timestamp: result.timestamp,
                source: format!("{:?}", result.test),
                confidence: Some(1.0),
            });
        }
        let updated = bayesian_update(&self.posterior.prior, &evidence);
        self.posterior = updated;
    }

    /// Update with `result` and report the calibration sample this probe
    /// completes.
    ///
    /// The pair is `(confidence held before the probe, 1.0 if the observed
    /// outcome was at least as well explained by the leading hypothesis as by
    /// the rest of the engine's belief, else 0.0)`. A confident leader that the
    /// next probe contradicts was overconfident, which is the quantity the
    /// isotonic map is fitted on. Both numbers are measured on probes the engine
    /// actually observed, so calibration rests on real outcomes rather than on
    /// simulator trials.
    ///
    /// Whether the leader merely *stays* the leader is not used: the transition
    /// model keeps a dominant hypothesis on top through mildly contrary
    /// evidence, so that label is almost always 1 and calibrates nothing.
    /// The first probe has no belief to be confident about and yields `None`.
    pub fn observe_recording_confirmation(&mut self, result: &ProbeResult) -> Option<(f64, f64)> {
        // Before the first probe the "leader" is the first hypothesis at uniform
        // prior: top-of-uniform makes no claim, so it is not a sample.
        let prior_leader = match (self.previous_timestamp, self.posterior.map()) {
            (Some(_), Some(idx)) => Some(idx),
            _ => None,
        };
        let sample = prior_leader.map(|leader_index| {
            let confidence = self.posterior.prob(leader_index);
            let hypotheses = Hypothesis::all();
            let explained_by_leader = self.likelihood.log_likelihood(
                &result.test,
                &hypotheses[leader_index],
                &result.outcome,
            );
            // Log-likelihoods are averaged under the posterior, so this is "the
            // leader explains the outcome at least as well as the rest of the
            // belief". Undiscounted: the correlation weight governs how much the
            // probe moves the posterior, not how well it was predicted.
            let explained_by_belief: f64 = hypotheses
                .iter()
                .enumerate()
                .map(|(i, h)| {
                    self.posterior.prob(i)
                        * self.likelihood.log_likelihood(&result.test, h, &result.outcome)
                })
                .sum();
            let explained = if explained_by_leader >= explained_by_belief {
                1.0
            } else {
                0.0
            };
            (confidence, explained)
        });
        // The update always happens: recording a sample must never change what
        // the engine learns.
        self.observe(result);
        sample
    }

    /// Evidence weight the next observation of `test` would receive.
    ///
    /// Full weight while the engine is still uncertain: a corrective probe must
    /// never be weakened. The discount grows only as the leading hypothesis
    /// approaches certainty, which is exactly where correlated probes would
    /// otherwise manufacture false confidence. Shared by `observe` and the
    /// information-gain estimator so the two cannot drift apart.
    fn evidence_weight(&self, test: &DiagnosticTest) -> f64 {
        let raw_weight = self
            .correlation
            .weight_for(&self.observation_history, test.correlation_id());
        let map_prob = self
            .posterior
            .map()
            .map(|idx| self.posterior.prob(idx))
            .unwrap_or(0.0);
        let gate = ((map_prob - 0.5) / 0.5).clamp(0.0, 1.0);
        1.0 - (1.0 - raw_weight) * gate
    }

    /// Entropy of the posterior this engine would hold after observing
    /// `outcome` of `test`, computed on the log-probability vector alone.
    ///
    /// Same update math as `observe` for a probe whose timestamp equals the
    /// engine's current one (the predict step is the identity): the movement
    /// comes from [`evidence_movement`], the one owner of the correlation
    /// discount and the NaN rule, and normalization/entropy come from
    /// `softmax`/`entropy_of`. The only thing this avoids is cloning the whole
    /// engine once per candidate outcome, which made a single ranking cost
    /// milliseconds.
    fn entropy_if_observed(
        &self,
        test: &DiagnosticTest,
        outcome: &ProbeOutcome,
        weight: f64,
    ) -> f64 {
        let mut log_probs = self.posterior.prior.log_probs.clone();
        for (i, h) in Hypothesis::all().iter().enumerate() {
            if i >= log_probs.len() {
                break;
            }
            let ll = self.likelihood.log_likelihood(test, h, outcome);
            log_probs[i] += evidence_movement(ll, weight);
        }
        softmax(&log_probs).map_or(0.0, |probs| entropy_of(&probs))
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

    /// Prior probability of every hypothesis, in the declared hypothesis order.
    ///
    /// Paired with [`Self::ranked`] by label this shows how far the evidence
    /// moved each belief from where it started. `observe` rewrites the live
    /// distribution but never this starting one.
    pub fn priors(&self) -> Vec<(&str, f64)> {
        let probs = softmax(&self.initial_prior.log_probs).unwrap_or_default();
        self.initial_prior
            .labels
            .iter()
            .zip(probs)
            .map(|(label, p)| (label.as_str(), p))
            .collect()
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
    // The weight `observe` would apply to this probe. Constant across outcomes:
    // it depends on the engine state and the test, not on what comes back.
    let weight = engine.evidence_weight(test).clamp(0.0, 1.0);

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

        // Posterior after observing this outcome, computed on the log-probability
        // vector instead of cloning the whole engine per outcome.
        let post_entropy = engine.entropy_if_observed(test, &outcome, weight);
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

/// Dirichlet-multinomial calibrator for the likelihood table.
///
/// Tracks, per (test, hypothesis), how often each outcome was observed when
/// that hypothesis was the true state. Applying the calibrator rewrites each
/// row of the likelihood table (P(outcome | hypothesis, test) over outcomes)
/// from the observed relative frequencies, so the diagnostic model adapts to
/// real measurements instead of relying only on structural priors.
///
/// Rows with no observations keep their prior.
#[derive(Debug, Clone, Default)]
pub struct LikelihoodCalibrator {
    /// Per (test_idx, hyp_idx) Dirichlet counts over the 6 outcomes, seeded
    /// with a prior of 1.0 per outcome.
    counts: std::collections::HashMap<(usize, usize), [f64; 6]>,
}

impl LikelihoodCalibrator {
    pub fn new() -> Self {
        Self {
            counts: std::collections::HashMap::new(),
        }
    }

    /// Record one observation: running `test` while the true state was
    /// `true_hypothesis` produced `outcome`. Only updates the row for the
    /// true hypothesis (we only learn P(outcome | H=true_hyp, test) from
    /// observations made in that state).
    pub fn observe(
        &mut self,
        test: &DiagnosticTest,
        _hypothesis: &Hypothesis,
        outcome: &ProbeOutcome,
        true_hypothesis: &Hypothesis,
    ) {
        let t_idx = LikelihoodTable::test_index(test);
        let h_idx = Hypothesis::all()
            .iter()
            .position(|h| h == true_hypothesis)
            .expect("known hypothesis");
        let o_idx = match outcome {
            ProbeOutcome::Success => 0,
            ProbeOutcome::Failure => 1,
            ProbeOutcome::Missing => 2,
            ProbeOutcome::AuthRejected => 3,
            ProbeOutcome::RateLimited => 4,
            ProbeOutcome::ServerError => 5,
        };
        let key = (t_idx, h_idx);
        let counts = self.counts.entry(key).or_insert([1.0; 6]);
        counts[o_idx] += 1.0;
    }

    /// Apply the accumulated counts to `table`, rewriting each observed row's
    /// log-probabilities to the normalized relative frequencies
    /// `P(outcome | hypothesis, test) = count_o / sum_o count_o`. Rows with no
    /// observations are left at their prior.
    pub fn apply(&self, table: &mut LikelihoodTable) {
        for ((t_idx, h_idx), counts) in &self.counts {
            let total: f64 = counts.iter().map(|c| *c).sum();
            if total <= 0.0 {
                continue;
            }
            let test = &LikelihoodTable::tests()[*t_idx];
            let hypothesis = &Hypothesis::all()[*h_idx];
            for (o_idx, &count) in counts.iter().enumerate() {
                let p = count / total;
                let outcome = match o_idx {
                    0 => ProbeOutcome::Success,
                    1 => ProbeOutcome::Failure,
                    2 => ProbeOutcome::Missing,
                    3 => ProbeOutcome::AuthRejected,
                    4 => ProbeOutcome::RateLimited,
                    _ => ProbeOutcome::ServerError,
                };
                table.set_log_likelihood(test, hypothesis, &outcome, p.ln());
            }
        }
    }
}

/// Sequential Probability Ratio Test (SPRT) stopping boundary.
///
/// Between two simple hypotheses H0 and H1 with log-likelihood ratio
/// accumulated as `llr = log(P(E|H1)/P(E|H0))`, stop and accept H1 when
/// `llr >= log((1-beta)/alpha)` and accept H0 when `llr <= log(beta/(1-alpha))`,
/// where `alpha` is the false-positive and `beta` the false-negative rate.
/// Continue sampling while the LLR lies strictly between the two bounds.
///
/// Returns `Some(true)` if H1 should be accepted, `Some(false)` if H0 should
/// be accepted, or `None` if more evidence is needed.
pub fn sprt_stop(llr: f64, alpha: f64, beta: f64) -> Option<bool> {
    let alpha = alpha.clamp(1e-9, 1.0 - 1e-9);
    let beta = beta.clamp(1e-9, 1.0 - 1e-9);
    let upper = ((1.0 - beta) / alpha).ln();
    let lower = (beta / (1.0 - alpha)).ln();
    if llr >= upper {
        Some(true)
    } else if llr <= lower {
        Some(false)
    } else {
        None
    }
}

/// Heuristic stopping rule for diagnostic testing: stop when the posterior
/// entropy has fallen below `threshold` nats, OR when the MAP hypothesis has
/// posterior probability at least `confidence`. Returns `Some(true)` when the
/// diagnosis is confident enough to stop, `None` to continue testing.
pub fn should_stop_testing(entropy: f64, map_prob: f64, entropy_threshold: f64) -> bool {
    let map_prob = map_prob.clamp(0.0, 1.0);
    entropy <= entropy_threshold || map_prob >= (1.0 - entropy_threshold)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_starts_uncertain() {
        let e = DiagnosticEngine::new();
        let n = Hypothesis::all().len() as f64;
        // Uniform over the declared hypothesis space: entropy = ln(n).
        assert!((e.uncertainty() - n.ln()).abs() < 1e-9);
        // MAP picks the first hypothesis but with uniform probability.
        let (label, prob) = e.diagnosis().expect("some diagnosis");
        assert_eq!(label, "gateway");
        assert!((prob - 1.0 / n).abs() < 1e-9);
    }

    #[test]
    fn observe_records_a_calibration_pair_per_probe() {
        let mut engine = DiagnosticEngine::new();
        let mut before_each = Vec::new();
        let mut samples = Vec::new();
        // Three blocks of same-test failures: the leader's rule for the observed
        // outcomes changes between blocks, which is what makes both labels
        // appear. (The leader itself stays put — the transition model keeps a
        // dominant hypothesis on top — which is exactly why "still the leader"
        // is not the label.)
        let mut sequence: Vec<(DiagnosticTest, u64)> = Vec::new();
        for (test, count) in [
            (DiagnosticTest::GatewayPing, 8u64),
            (DiagnosticTest::DnsResolve, 8),
            (DiagnosticTest::TlsHandshake, 8),
        ] {
            for _ in 0..count {
                sequence.push((test.clone(), sequence.len() as u64));
            }
        }

        for (test, i) in sequence {
            before_each.push(engine.diagnosis().map(|(_, prob)| prob));
            let probe = ProbeResult {
                test: test.clone(),
                outcome: ProbeOutcome::Failure,
                timestamp: i + 1,
                source: "calibration-test".into(),
                cost: 1.0,
            };
            samples.push(engine.observe_recording_confirmation(&probe));
        }

        // Nothing was pending for the very first probe.
        assert!(samples[0].is_none(), "first probe must not yield a sample");
        for (i, sample) in samples.iter().enumerate().skip(1) {
            let (predicted, confirmed) = sample.expect("every later probe completes a pair");
            // The prediction is the confidence held BEFORE this probe.
            assert_eq!(
                predicted.to_bits(),
                before_each[i].expect("MAP before probe").to_bits(),
                "sample {i} must record the pre-probe confidence"
            );
            assert!(confirmed == 0.0 || confirmed == 1.0);
        }
        // A label that is always the same carries no calibration information.
        let pairs: Vec<(f64, f64)> = samples.iter().flatten().copied().collect();
        assert!(
            pairs.iter().any(|(_, y)| *y == 1.0),
            "label was never 1: the leader never explained a probe better than the belief"
        );
        assert!(
            pairs.iter().any(|(_, y)| *y == 0.0),
            "label was never 0: no probe contradicted the leader's explanation"
        );
    }

    fn posterior_of(engine: &DiagnosticEngine, label: &str) -> f64 {
        engine
            .ranked()
            .into_iter()
            .find(|(l, _)| *l == label)
            .map(|(_, p)| p)
            .unwrap_or(0.0)
    }

    #[test]
    fn a_healthy_probe_round_does_not_raise_failure_hypotheses() {
        // Exactly what a health check on a working API produces: dns, tcp, tls
        // and http all succeeded. Success is evidence that those layers are
        // fine, so it must not make a fault more likely — least of all the one
        // that is hardest to observe directly.
        let mut engine = DiagnosticEngine::new();
        let before_dns = posterior_of(&engine, "dns");
        let before_inconsistent = posterior_of(&engine, "dns_inconsistency");
        for (i, test) in [
            DiagnosticTest::DnsResolve,
            DiagnosticTest::TcpConnect,
            DiagnosticTest::TlsHandshake,
            DiagnosticTest::HttpGet,
        ]
        .iter()
        .enumerate()
        {
            engine.observe(&ProbeResult {
                test: test.clone(),
                outcome: ProbeOutcome::Success,
                timestamp: i as u64 + 1,
                source: "health".into(),
                cost: 0.0,
            });
        }
        let after_dns = posterior_of(&engine, "dns");
        let after_inconsistent = posterior_of(&engine, "dns_inconsistency");
        assert!(
            after_dns <= before_dns + 1e-12,
            "an all-success round raised dns: {before_dns:.4} -> {after_dns:.4} (leader {:?})",
            engine.diagnosis()
        );
        assert!(
            after_inconsistent <= before_inconsistent + 1e-12,
            "an all-success round raised dns_inconsistency: {before_inconsistent:.4} -> {after_inconsistent:.4}"
        );
    }

    #[test]
    fn a_fully_healthy_round_makes_no_fault_more_likely() {
        // Every diagnostic test succeeds. The engine has no evidence of any
        // fault, so no fault may gain ground — the residual state has to be the
        // one that improves.
        let mut engine = DiagnosticEngine::new();
        let before: Vec<(&'static str, f64)> = engine
            .ranked()
            .into_iter()
            .map(|(label, prob)| {
                let label: &'static str = Hypothesis::all()
                    .into_iter()
                    .find(|h| h.label() == label)
                    .map(|h| h.label())
                    .unwrap_or("unknown");
                (label, prob)
            })
            .collect();
        for (i, test) in LikelihoodTable::tests().iter().enumerate() {
            engine.observe(&ProbeResult {
                test: test.clone(),
                outcome: ProbeOutcome::Success,
                timestamp: i as u64 + 1,
                source: "healthy".into(),
                cost: 0.0,
            });
        }
        let prior_unknown = before
            .iter()
            .find(|(label, _)| *label == "unknown")
            .map(|(_, p)| *p)
            .expect("unknown is part of the hypothesis space");
        let after_unknown = posterior_of(&engine, "unknown");
        assert!(
            after_unknown > prior_unknown,
            "a healthy round must raise the no-fault state: {prior_unknown:.4} -> {after_unknown:.4}"
        );
        assert!(
            after_unknown > 0.5,
            "a fully healthy round must leave the no-fault state dominant, got {after_unknown:.4}"
        );
        // The reported symptom: successes used to promote the DNS faults.
        for label in ["dns", "dns_inconsistency"] {
            let prior = before
                .iter()
                .find(|(l, _)| *l == label)
                .map(|(_, p)| *p)
                .expect("dns hypotheses are in the space");
            let after = posterior_of(&engine, label);
            assert!(
                after <= prior + 1e-12,
                "a healthy round raised `{label}`: {prior:.4} -> {after:.4}"
            );
        }
        assert_eq!(
            engine.diagnosis().map(|(label, _)| label),
            Some("unknown"),
            "a fully healthy round must land on the no-fault state"
        );
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
    fn interface_check_failure_is_not_uniformly_shared() {
        // Regression: a leftover `LocalInterface => 0.97` match arm (from a
        // refactor that removed that hypothesis) was an irrefutable Rust
        // binding, so EVERY hypothesis received the 0.97 failure signature and
        // the Gateway/other arms were unreachable — the probe was uninformative.
        let sig_gateway =
            LikelihoodTable::signature(&DiagnosticTest::InterfaceCheck, &Hypothesis::Gateway);
        let sig_dns = LikelihoodTable::signature(&DiagnosticTest::InterfaceCheck, &Hypothesis::Dns);
        assert!((sig_gateway - 0.25).abs() < 1e-12, "gateway signature = {sig_gateway}");
        assert!((sig_dns - 0.05).abs() < 1e-12, "dns signature = {sig_dns}");
        assert!(sig_gateway > sig_dns, "interface check must be discriminating");
    }

    #[test]
    fn long_gap_starts_a_fresh_correlation_window() {
        // Regression: `previous_timestamp` was overwritten before the gap
        // check, so the elapsed gap was always zero and old evidence was never
        // discarded — probes from hours earlier kept discounting new ones.
        let mut e = DiagnosticEngine::new();
        e.observe(&ProbeResult {
            test: DiagnosticTest::DnsResolve,
            outcome: ProbeOutcome::Failure,
            timestamp: 1_000,
            source: "dns".into(),
            cost: 1.0,
        });
        assert_eq!(e.observation_history.len(), 1);
        e.observe(&ProbeResult {
            test: DiagnosticTest::TcpConnect,
            outcome: ProbeOutcome::Failure,
            // Ten seconds later: inside the same five-minute window.
            timestamp: 1_010,
            source: "tcp".into(),
            cost: 1.0,
        });
        assert_eq!(e.observation_history.len(), 2);

        // Timestamps here are SECONDS (the canonical feeder converts ms at
        // the boundary), so a five-minute gap is 300 — not 300_000.
        let later = 1_010 + CORRELATION_WINDOW_SECONDS + 1;
        e.observe(&ProbeResult {
            test: DiagnosticTest::TlsHandshake,
            outcome: ProbeOutcome::Failure,
            timestamp: later,
            source: "tls".into(),
            cost: 1.0,
        });
        assert_eq!(
            e.observation_history,
            vec!["tls-handshake"],
            "a long gap must discard probes from the earlier incident"
        );
    }

    #[test]
    fn six_minute_gap_in_engine_seconds_resets_even_without_the_ms_feeder() {
        // NANI-DD-01: the engine clock is SECONDS. A six-minute incident gap
        // is 360, not 360_000. The old code compared that gap to the
        // millisecond-valued 300_000 constant, so stale evidence from the
        // previous incident kept discounting fresh probes for 3.5 days.
        // This test calls `observe` directly with seconds so it pins the
        // engine's own contract independently of the feeder conversion.
        let mut e = DiagnosticEngine::new();
        for (test, ts) in [
            (DiagnosticTest::DnsResolve, 1_000_u64),
            (DiagnosticTest::TcpConnect, 1_010),
        ] {
            let source = test.correlation_id().to_string();
            e.observe(&ProbeResult {
                test,
                outcome: ProbeOutcome::Failure,
                timestamp: ts,
                source,
                cost: 1.0,
            });
        }
        assert_eq!(e.observation_history.len(), 2);

        let six_minutes_later = 1_010 + 6 * 60;
        e.observe(&ProbeResult {
            test: DiagnosticTest::TlsHandshake,
            outcome: ProbeOutcome::Failure,
            timestamp: six_minutes_later,
            source: "tls".into(),
            cost: 1.0,
        });
        assert_eq!(
            e.observation_history,
            vec!["tls-handshake"],
            "a six-minute (360-second) gap must start a fresh correlation window"
        );
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

    /// The clone-per-outcome estimator the fast path replaced, kept verbatim
    /// as the reference the new one is proved against.
    fn expected_information_gain_by_cloning(engine: &DiagnosticEngine, test: &DiagnosticTest) -> f64 {
        let current_entropy = engine.uncertainty();
        let priors: Vec<f64> = softmax(&engine.posterior.prior.log_probs).expect("priors");
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
            let mut clone = engine.clone();
            let probe = ProbeResult {
                test: test.clone(),
                outcome,
                timestamp: engine.previous_timestamp.unwrap_or(0),
                source: format!("{:?}", test),
                cost: 0.0,
            };
            clone.observe(&probe);
            expected_post_entropy += pred_p * clone.uncertainty();
        }
        let ig = current_entropy - expected_post_entropy;
        if ig < 0.0 {
            0.0
        } else {
            ig
        }
    }

    #[test]
    fn information_gain_fast_path_matches_the_cloning_reference() {
        use crate::network_intelligence::simulation::{NetworkCondition, NetworkSimulator};

        let conditions = [
            NetworkCondition::Healthy,
            NetworkCondition::DnsFailure,
            NetworkCondition::GatewayFailure,
            NetworkCondition::RoutingFailure,
            NetworkCondition::Ipv4Only,
            NetworkCondition::Ipv6Only,
            NetworkCondition::TcpTimeout,
            NetworkCondition::TlsFailure,
            NetworkCondition::MtuIssue,
            NetworkCondition::UpstreamProxyDown,
            NetworkCondition::RemoteEndpointDown,
            NetworkCondition::AuthRejected,
            NetworkCondition::RateLimited,
            NetworkCondition::ServerError,
            NetworkCondition::IntermittentLoss,
        ];
        let tests = [
            DiagnosticTest::InterfaceCheck,
            DiagnosticTest::GatewayPing,
            DiagnosticTest::DnsResolve,
            DiagnosticTest::TcpConnect,
            DiagnosticTest::TlsHandshake,
            DiagnosticTest::HttpGet,
            DiagnosticTest::MtuProbe,
            DiagnosticTest::Traceroute,
        ];

        // The two paths differ only in how many times they renormalize: the
        // cloning path runs `predict(0)` (a mathematically identity step) and
        // `bayesian_update`'s normalization before reading entropy, so the last
        // bits can differ. 1e-9 is far below any decision-relevant change.
        const TOLERANCE: f64 = 1e-9;
        let mut compared = 0usize;
        let mut max_diff = 0.0_f64;
        for condition in conditions {
            for seed in 0..2u64 {
                let mut sim = NetworkSimulator::new(seed, condition);
                let mut engine = DiagnosticEngine::new();
                for step in 0..=tests.len() {
                    // Compare every test at every prefix of the probe sequence:
                    // fresh engine, mid-diagnosis, and engine with a full history
                    // (where the correlation discount is active and non-trivial).
                    for test in tests.iter() {
                        let fast = expected_information_gain(&engine, test)
                            .expect("score")
                            .information_gain;
                        let reference = expected_information_gain_by_cloning(&engine, test);
                        let diff = (fast - reference).abs();
                        max_diff = max_diff.max(diff);
                        assert!(
                            diff < TOLERANCE,
                            "{condition:?} seed {seed} step {step} {test:?}: fast {fast} vs reference {reference}"
                        );
                        compared += 1;
                    }
                    if step == tests.len() {
                        break;
                    }
                    let mut result = sim.probe(&tests[step]);
                    result.timestamp = step as u64 + 1;
                    engine.observe(&result);
                }
            }
        }
        println!("IG fast path vs cloning reference: {compared} comparisons, max |diff| = {max_diff:e}");
        // 15 conditions x 2 seeds x 9 prefix states x 8 tests.
        assert!(compared >= 2160, "only {compared} comparisons ran");
    }

    #[test]
    fn priors_stay_at_the_starting_distribution_after_evidence() {
        let mut engine = DiagnosticEngine::new();
        let before: Vec<(String, f64)> = engine
            .priors()
            .into_iter()
            .map(|(l, p)| (l.to_string(), p))
            .collect();
        assert!((before.iter().map(|(_, p)| p).sum::<f64>() - 1.0).abs() < 1e-9);

        engine.observe(&ProbeResult {
            test: DiagnosticTest::DnsResolve,
            outcome: ProbeOutcome::Success,
            timestamp: 1_000,
            source: "dns".into(),
            cost: 0.0,
        });

        let after = engine.priors();
        assert_eq!(after.len(), before.len());
        for ((_, was), (_, now)) in before.iter().zip(after.iter()) {
            assert!((was - now).abs() < 1e-12, "prior moved after evidence");
        }
        // The posterior did move, so prior and posterior are genuinely distinct.
        let ranked = engine.ranked();
        assert!(
            ranked
                .iter()
                .any(|(label, p)| before.iter().any(|(l, q)| l == label && (p - q).abs() > 1e-6)),
            "posterior identical to the prior after a conclusive probe"
        );
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
        // After DNS fails, uncertainty should decrease from the full hypothesis space.
        assert!(e.uncertainty() < (Hypothesis::all().len() as f64).ln());

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
        assert!(e.uncertainty() < (Hypothesis::all().len() as f64).ln());
    }

    #[test]
    fn calibrator_shifts_likelihood_toward_observed_outcomes() {
        let mut table = LikelihoodTable::default();
        let mut cal = LikelihoodCalibrator::new();

        // Observe DNS-resolve failures under the DNS hypothesis many times,
        // and a few successes.
        let test = DiagnosticTest::DnsResolve;
        let hyp = Hypothesis::Dns;
        for _ in 0..90 {
            cal.observe(&test, &hyp, &ProbeOutcome::Failure, &hyp);
        }
        for _ in 0..10 {
            cal.observe(&test, &hyp, &ProbeOutcome::Success, &hyp);
        }

        let before = table.log_likelihood(&test, &hyp, &ProbeOutcome::Failure);
        cal.apply(&mut table);
        let after = table.log_likelihood(&test, &hyp, &ProbeOutcome::Failure);

        // 90 failures, 10 successes (plus prior of 1 per outcome) =>
        // P(Failure | DNS) = 91 / 106 ≈ 0.858.
        assert!(after < before, "calibration moved failure log-prob: {before} -> {after}");
        let expected: f64 = (91.0_f64 / 106.0).ln();
        assert!((after - expected).abs() < 1e-6, "after {after} ~ {expected}");
    }

    #[test]
    fn sprt_stop_accepts_h1_when_llr_high() {
        assert!(sprt_stop(5.0, 0.05, 0.1) == Some(true));
        assert!(sprt_stop(10.0, 0.01, 0.01) == Some(true));
    }

    #[test]
    fn sprt_stop_accepts_h0_when_llr_low() {
        assert!(sprt_stop(-5.0, 0.05, 0.1) == Some(false));
        assert!(sprt_stop(-10.0, 0.01, 0.01) == Some(false));
    }

    #[test]
    fn sprt_stop_continues_in_between() {
        assert!(sprt_stop(0.0, 0.05, 0.1) == None);
        assert!(sprt_stop(1.0, 0.05, 0.1) == None);
    }

    #[test]
    fn should_stop_testing_thresholds() {
        // Low entropy -> stop.
        assert!(should_stop_testing(0.05, 0.9, 0.1));
        // High map_prob -> stop.
        assert!(should_stop_testing(2.0, 0.99, 0.1));
        // Neither -> continue.
        assert!(!should_stop_testing(1.0, 0.6, 0.1));
    }
    #[test]
    fn correlated_transport_failures_do_not_triple_confidence() {
        let mut independent = DiagnosticEngine::new()
            .with_correlation(CorrelationModel::with_groups(Vec::new()));
        let mut correlated = DiagnosticEngine::new();

        // Establish a confident DNS diagnosis, then add an HTTP failure that
        // shares the resolver path. The HTTP observation is real evidence, but
        // it must not act as an independent second confirmation of DNS.
        for ts in 1..=6 {
            for engine in [&mut independent, &mut correlated] {
                engine.observe(&ProbeResult {
                    test: DiagnosticTest::DnsResolve,
                    outcome: ProbeOutcome::Failure,
                    timestamp: ts,
                    source: "test".into(),
                    cost: 0.0,
                });
            }
        }
        for engine in [&mut independent, &mut correlated] {
            engine.observe(&ProbeResult {
                test: DiagnosticTest::HttpGet,
                outcome: ProbeOutcome::Failure,
                timestamp: 7,
                source: "test".into(),
                cost: 0.0,
            });
        }

        assert!(independent.diagnosis().is_some());
        assert!(correlated.diagnosis().is_some());
        assert_eq!(independent.last_evidence_weight, 1.0);
        assert!(
            correlated.last_evidence_weight < 1.0,
            "shared-resolver evidence must be discounted, got {}",
            correlated.last_evidence_weight
        );
        // The first six DNS probes repeat the same test and keep full weight;
        // only the HTTP probe sharing the resolver is discounted.
        assert!(correlated.last_evidence_weight >= 0.5);
    }

}

