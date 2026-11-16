// Deterministic network simulator for controlled benchmarking of NANI.
//
// Generates reproducible network conditions so the engine's diagnosis,
// learning, and recovery behavior can be validated against fixed-rule
// baselines. All randomness is seeded; the same seed produces the same
// scenario.

use crate::network_intelligence::api_model::{FailureCategory, RouteKind};
use crate::network_intelligence::diagnosis::{DiagnosticEngine, DiagnosticTest, ProbeOutcome, ProbeResult};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

/// A simulated network condition that a probe can encounter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkCondition {
    Healthy,
    DnsFailure,
    GatewayFailure,
    RoutingFailure,
    Ipv4Only,
    Ipv6Only,
    TcpTimeout,
    TlsFailure,
    MtuIssue,
    UpstreamProxyDown,
    RemoteEndpointDown,
    AuthRejected,
    RateLimited,
    ServerError,
    IntermittentLoss, // packet loss that comes and goes
}

/// The simulated state of the network at a point in time.
#[derive(Debug, Clone)]
pub struct SimulatedNetwork {
    pub condition: NetworkCondition,
    pub base_latency_ms: f64,
    pub packet_loss: f64,
    pub jitter_ms: f64,
}

/// A deterministic simulator: given a seed and a condition, it produces
/// reproducible probe outcomes and API outcomes.
#[derive(Debug, Clone)]
pub struct NetworkSimulator {
    rng: StdRng,
    pub network: SimulatedNetwork,
    pub seed: u64,
}

impl NetworkSimulator {
    /// Create a simulator with the given seed and network condition.
    pub fn new(seed: u64, condition: NetworkCondition) -> Self {
        let mut rng = StdRng::seed_from_u64(seed);
        let network = condition_to_network(condition, &mut rng);
        Self { rng, network, seed }
    }

    /// Re-seed and switch condition (simulate a network change over time).
    pub fn reseed(&mut self, seed: u64, condition: NetworkCondition) {
        self.seed = seed;
        self.rng = StdRng::seed_from_u64(seed);
        self.network = condition_to_network(condition, &mut self.rng);
    }

    /// Simulate a probe result for a diagnostic test against this network.
    ///
    /// The outcome depends on the condition and the test type, with
    /// probabilistic noise so repeated probes aren't identical.
    pub fn probe(&mut self, test: &DiagnosticTest) -> ProbeResult {
        let (outcome, latency_ms) = self.probe_outcome(test);
        ProbeResult {
            test: test.clone(),
            outcome,
            timestamp: 0, // simulator doesn't track wall-clock
            source: format!("{:?}", test),
            cost: match test {
                DiagnosticTest::DnsResolve => 1.0,
                DiagnosticTest::GatewayPing => 1.0,
                DiagnosticTest::InterfaceCheck => 0.5,
                DiagnosticTest::TcpConnect => 2.0,
                DiagnosticTest::TlsHandshake => 2.0,
                DiagnosticTest::HttpGet => 3.0,
                DiagnosticTest::MtuProbe => 4.0,
                DiagnosticTest::Traceroute => 5.0,
            },
        }
    }

    /// Layer-aware probe semantics.
    ///
    /// A failure at one layer must not make every lower layer look broken:
    /// a TLS failure leaves DNS, gateway, interface and TCP healthy, and it is
    /// exactly that asymmetry that makes diagnosis possible. Earlier versions
    /// answered `Failure` to nearly every probe under these conditions, which
    /// made every hypothesis equally consistent with the evidence.
    fn probe_outcome(&mut self, test: &DiagnosticTest) -> (ProbeOutcome, f64) {
        use DiagnosticTest::*;
        let rng = &mut self.rng;
        let ok = |rng: &mut StdRng, lo: f64, hi: f64| {
            (ProbeOutcome::Success, rng.gen_range(lo..hi))
        };
        match self.network.condition {
            NetworkCondition::Healthy => ok(rng, 20.0, 80.0),
            NetworkCondition::DnsFailure => match test {
                DnsResolve => (ProbeOutcome::Failure, 0.0),
                TcpConnect => {
                    if rng.gen_bool(0.8) {
                        ok(rng, 30.0, 90.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                TlsHandshake => {
                    if rng.gen_bool(0.7) {
                        ok(rng, 40.0, 110.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                HttpGet => {
                    if rng.gen_bool(0.6) {
                        ok(rng, 50.0, 140.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                // Interface, gateway, route to the resolver and MTU are fine.
                _ => ok(rng, 15.0, 60.0),
            },
            NetworkCondition::GatewayFailure => match test {
                InterfaceCheck => ok(rng, 5.0, 20.0),
                GatewayPing | Traceroute => (ProbeOutcome::Failure, 0.0),
                DnsResolve => {
                    if rng.gen_bool(0.3) {
                        ok(rng, 10.0, 40.0)
                    } else if rng.gen_bool(0.5) {
                        (ProbeOutcome::Failure, 0.0)
                    } else {
                        (ProbeOutcome::Missing, 0.0)
                    }
                }
                TcpConnect => {
                    if rng.gen_bool(0.2) {
                        ok(rng, 100.0, 300.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                _ => (ProbeOutcome::Failure, 0.0),
            },
            NetworkCondition::RoutingFailure => match test {
                InterfaceCheck | GatewayPing => ok(rng, 10.0, 40.0),
                DnsResolve => {
                    if rng.gen_bool(0.8) {
                        ok(rng, 15.0, 50.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                Traceroute => (ProbeOutcome::Failure, 0.0),
                TcpConnect => {
                    if rng.gen_bool(0.15) {
                        ok(rng, 150.0, 400.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                _ => (ProbeOutcome::Failure, 0.0),
            },
            NetworkCondition::Ipv4Only | NetworkCondition::Ipv6Only => match test {
                TcpConnect => {
                    let p = if self.network.condition == NetworkCondition::Ipv4Only { 0.9 } else { 0.7 };
                    if rng.gen_bool(p) {
                        ok(rng, 40.0, 120.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                _ => ok(rng, 20.0, 80.0),
            },
            NetworkCondition::TcpTimeout => match test {
                InterfaceCheck | GatewayPing | DnsResolve | Traceroute => ok(rng, 15.0, 60.0),
                // Path-MTU probing (ICMP/DF) still works when TCP is blocked.
                MtuProbe => ok(rng, 15.0, 60.0),
                TcpConnect => {
                    if rng.gen_bool(0.3) {
                        ok(rng, 100.0, 300.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                _ => {
                    if rng.gen_bool(0.15) {
                        ok(rng, 100.0, 300.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
            },
            NetworkCondition::TlsFailure => match test {
                InterfaceCheck | GatewayPing | DnsResolve | TcpConnect | MtuProbe | Traceroute => {
                    ok(rng, 20.0, 80.0)
                }
                TlsHandshake => (ProbeOutcome::Failure, 0.0),
                HttpGet => {
                    if rng.gen_bool(0.1) {
                        ok(rng, 60.0, 150.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
            },
            NetworkCondition::MtuIssue => match test {
                MtuProbe => {
                    if rng.gen_bool(0.2) {
                        ok(rng, 30.0, 90.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                TcpConnect => {
                    if rng.gen_bool(0.7) {
                        ok(rng, 30.0, 90.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                TlsHandshake => {
                    if rng.gen_bool(0.4) {
                        ok(rng, 50.0, 120.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                HttpGet => {
                    if rng.gen_bool(0.5) {
                        ok(rng, 60.0, 160.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                _ => ok(rng, 20.0, 70.0),
            },
            NetworkCondition::UpstreamProxyDown => match test {
                HttpGet => {
                    if rng.gen_bool(0.1) {
                        ok(rng, 50.0, 130.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                _ => ok(rng, 20.0, 80.0),
            },
            NetworkCondition::RemoteEndpointDown => match test {
                InterfaceCheck | GatewayPing | DnsResolve => ok(rng, 15.0, 60.0),
                Traceroute => {
                    if rng.gen_bool(0.7) {
                        ok(rng, 30.0, 90.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                TcpConnect => {
                    if rng.gen_bool(0.2) {
                        ok(rng, 100.0, 250.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
                _ => {
                    if rng.gen_bool(0.1) {
                        ok(rng, 80.0, 200.0)
                    } else {
                        (ProbeOutcome::Failure, 0.0)
                    }
                }
            },
            NetworkCondition::AuthRejected => match test {
                HttpGet => (ProbeOutcome::AuthRejected, rng.gen_range(20.0..60.0)),
                _ => ok(rng, 20.0, 80.0),
            },
            NetworkCondition::RateLimited => match test {
                HttpGet => (ProbeOutcome::RateLimited, rng.gen_range(20.0..60.0)),
                _ => ok(rng, 20.0, 80.0),
            },
            NetworkCondition::ServerError => match test {
                HttpGet => (ProbeOutcome::ServerError, rng.gen_range(20.0..60.0)),
                _ => ok(rng, 20.0, 80.0),
            },
            NetworkCondition::IntermittentLoss => {
                if rng.gen_bool(0.4) {
                    (ProbeOutcome::Failure, 0.0)
                } else {
                    ok(rng, 50.0, 200.0)
                }
            }
        }
    }

    /// Simulate an API call outcome for a given route.
    ///
    /// Returns (category, success, latency_ms). Direct routes are more
    /// affected by local network conditions; upstream routes are affected by
    /// proxy conditions.
    pub fn api_call(&mut self, api_id: &str, route: RouteKind) -> (FailureCategory, bool, f64) {
        let latency_base = match route {
            RouteKind::Direct => self.network.base_latency_ms,
            RouteKind::Upstream(_) => self.network.base_latency_ms + 80.0, // proxy adds overhead
        };
        let latency = latency_base + self.rng.gen_range(0.0..self.network.jitter_ms);

        let (category, success) = match self.network.condition {
            NetworkCondition::Healthy => (FailureCategory::Healthy, true),
            NetworkCondition::DnsFailure => (FailureCategory::DnsFailure, false),
            NetworkCondition::GatewayFailure => (FailureCategory::TransportFailure, false),
            NetworkCondition::RoutingFailure => (FailureCategory::TransportFailure, false),
            NetworkCondition::TcpTimeout => (FailureCategory::TransportFailure, false),
            NetworkCondition::TlsFailure => (FailureCategory::TlsFailure, false),
            NetworkCondition::RemoteEndpointDown => (FailureCategory::ServerFailure, false),
            NetworkCondition::AuthRejected => (FailureCategory::AuthenticationFailure, false),
            NetworkCondition::RateLimited => (FailureCategory::RateLimited, false),
            NetworkCondition::ServerError => (FailureCategory::ServerFailure, false),
            NetworkCondition::UpstreamProxyDown => {
                match route {
                    RouteKind::Direct => (FailureCategory::Healthy, true),
                    RouteKind::Upstream(_) => (FailureCategory::TransportFailure, false),
                }
            }
            NetworkCondition::IntermittentLoss => {
                if self.rng.gen_bool(0.3) {
                    (FailureCategory::TransportFailure, false)
                } else {
                    (FailureCategory::Healthy, true)
                }
            }
            _ => (FailureCategory::Unknown, false),
        };
        (category, success, latency)
    }

    /// Run a diagnostic sequence: probe a list of tests and return results.
    pub fn diagnose_sequence(&mut self, tests: &[DiagnosticTest]) -> Vec<ProbeResult> {
        tests.iter().map(|t| self.probe(t)).collect()
    }
}

/// Map a condition to baseline network parameters.
fn condition_to_network(c: NetworkCondition, rng: &mut StdRng) -> SimulatedNetwork {
    let (base_latency, packet_loss, jitter) = match c {
        NetworkCondition::Healthy => (40.0, 0.0, 5.0),
        NetworkCondition::DnsFailure => (0.0, 0.0, 0.0),
        NetworkCondition::GatewayFailure => (0.0, 0.0, 0.0),
        NetworkCondition::RoutingFailure => (0.0, 0.0, 0.0),
        NetworkCondition::Ipv4Only => (60.0, 0.01, 10.0),
        NetworkCondition::Ipv6Only => (80.0, 0.02, 15.0),
        NetworkCondition::TcpTimeout => (0.0, 0.0, 0.0),
        NetworkCondition::TlsFailure => (50.0, 0.0, 5.0),
        NetworkCondition::MtuIssue => (70.0, 0.05, 20.0),
        NetworkCondition::UpstreamProxyDown => (40.0, 0.0, 5.0),
        NetworkCondition::RemoteEndpointDown => (0.0, 0.0, 0.0),
        NetworkCondition::AuthRejected => (30.0, 0.0, 5.0),
        NetworkCondition::RateLimited => (30.0, 0.0, 5.0),
        NetworkCondition::ServerError => (200.0, 0.0, 50.0),
        NetworkCondition::IntermittentLoss => (100.0, 0.2, 50.0),
    };
    SimulatedNetwork {
        condition: c,
        base_latency_ms: base_latency,
        packet_loss,
        jitter_ms: jitter,
    }
}

/// Pre-built scenarios for benchmarking.
#[derive(Debug, Clone)]
pub struct Scenario {
    pub name: &'static str,
    /// Sequence of (condition, duration_steps) simulating a network evolving.
    pub timeline: Vec<(NetworkCondition, usize)>,
}

/// Scenario: the obvious fastest route (direct) is unreliable; a slower
/// upstream is more reliable. Tests whether the optimizer picks reliability
/// over raw speed.
pub fn scenario_fast_unreliable_vs_slow_reliable() -> Scenario {
    Scenario {
        name: "fast_unreliable_vs_slow_reliable",
        timeline: vec![
            // Start healthy: direct route works fine
            (NetworkCondition::Healthy, 5),
            // Direct becomes flaky (intermittent loss), upstream stays stable
            (NetworkCondition::IntermittentLoss, 10),
            // Direct recovers
            (NetworkCondition::Healthy, 5),
        ],
    }
}

/// Scenario: switching proxies is the wrong solution — the provider itself is
/// down. Tests whether the engine avoids endless route switching.
pub fn scenario_provider_outage() -> Scenario {
    Scenario {
        name: "provider_outage",
        timeline: vec![
            (NetworkCondition::Healthy, 5),
            (NetworkCondition::ServerError, 10), // provider down, not a routing issue
            (NetworkCondition::Healthy, 5),
        ],
    }
}

/// Scenario: DNS fails, then TCP-to-IP works. Tests whether the engine
/// correctly diagnoses DNS rather than assuming a general outage.
pub fn scenario_dns_failure() -> Scenario {
    Scenario {
        name: "dns_failure",
        timeline: vec![
            (NetworkCondition::Healthy, 3),
            (NetworkCondition::DnsFailure, 8),
            (NetworkCondition::Healthy, 5),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simulator_is_deterministic() {
        let mut s1 = NetworkSimulator::new(42, NetworkCondition::Healthy);
        let mut s2 = NetworkSimulator::new(42, NetworkCondition::Healthy);
        for _ in 0..20 {
            let r1 = s1.probe(&DiagnosticTest::DnsResolve);
            let r2 = s2.probe(&DiagnosticTest::DnsResolve);
            assert_eq!(r1.outcome, r2.outcome);
        }
    }

    #[test]
    fn different_seeds_produce_different_results() {
        let mut s1 = NetworkSimulator::new(1, NetworkCondition::IntermittentLoss);
        let mut s2 = NetworkSimulator::new(2, NetworkCondition::IntermittentLoss);
        let mut same = 0;
        for _ in 0..50 {
            if s1.probe(&DiagnosticTest::TcpConnect).outcome == s2.probe(&DiagnosticTest::TcpConnect).outcome {
                same += 1;
            }
        }
        assert!(same < 50, "different seeds should diverge");
    }

    #[test]
    fn dns_failure_scenario_diagnoses_dns() {
        let mut sim = NetworkSimulator::new(7, NetworkCondition::DnsFailure);
        let mut engine = DiagnosticEngine::new();
        // Use distinct sources so each probe's evidence is counted
        for i in 0..20 {
            let mut result = sim.probe(&DiagnosticTest::DnsResolve);
            result.source = format!("dns-probe-{}", i);
            engine.observe(&result);
        }
        // After repeated DNS failures, DNS should be the suspected hypothesis.
        let (label, prob) = engine.diagnosis().expect("diagnosis");
        assert_eq!(label, "dns");
        assert!(prob > 0.5);
    }

    #[test]
    fn api_call_classifies_correctly_under_conditions() {
        let mut sim = NetworkSimulator::new(3, NetworkCondition::AuthRejected);
        let (cat, success, _lat) = sim.api_call("api-1", RouteKind::Direct);
        assert_eq!(cat, FailureCategory::AuthenticationFailure);
        assert!(!success);

        let mut sim = NetworkSimulator::new(3, NetworkCondition::RateLimited);
        let (cat, success, _) = sim.api_call("api-1", RouteKind::Direct);
        assert_eq!(cat, FailureCategory::RateLimited);
        assert!(!success);
    }

    #[test]
    fn upstream_avoids_proxy_down_condition() {
        let mut sim = NetworkSimulator::new(5, NetworkCondition::UpstreamProxyDown);
        let (cat_direct, success_direct, _) = sim.api_call("api-1", RouteKind::Direct);
        let (cat_upstream, success_upstream, _) = sim.api_call("api-1", RouteKind::Upstream("proxy-1".into()));
        assert!(success_direct);
        assert!(!success_upstream);
        assert_eq!(cat_upstream, FailureCategory::TransportFailure);
    }

    #[test]
    fn reseed_changes_condition() {
        let mut sim = NetworkSimulator::new(1, NetworkCondition::Healthy);
        let h_before = sim.network.condition;
        sim.reseed(2, NetworkCondition::GatewayFailure);
        assert_ne!(h_before, sim.network.condition);
    }
}

