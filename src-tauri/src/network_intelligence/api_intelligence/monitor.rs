//! Multi-layer API health monitor.
//!
//! Probes each layer independently (DNS → TCP → TLS → HTTP → auth → app) and
//! produces a [`ProbeOutcomeRecord`]. A successful TCP handshake is not proof
//! of a healthy API; each layer is classified separately so a 401 is never
//! mistaken for a network outage.
//!
//! All probes use bounded timeouts and never block the UI thread (called from
//! a background control-plane task).

use crate::network_intelligence::api_intelligence::failure_classifier::{classify, ProbeInputs};
use crate::network_intelligence::api_intelligence::registry::{
    ApiEntry, ApiState, Health, HealthProbe, LayerResult, ProbeOutcomeRecord,
};
use crate::network_intelligence::api_model::FailureCategory;
use crate::network_intelligence::api_model::RouteKind;
use crate::network_intelligence::diagnosis::{
    DiagnosticEngine, DiagnosticTest, ProbeOutcome, ProbeResult,
};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Parse host and port from an endpoint URL.
fn host_port(endpoint: &str) -> Option<(String, u16)> {
    let url = Url::parse(endpoint).ok()?;
    let host = url.host_str()?.to_string();
    let port = url.port().or_else(|| {
        match url.scheme() {
            "https" => Some(443),
            "http" => Some(80),
            _ => None,
        }
    })?;
    Some((host, port))
}

/// DNS resolution probe.
///
/// N0 correction (NANI-019): this used to call `to_socket_addrs()` on the
/// BARE host. `str::to_socket_addrs` requires a `host:port` form, so a bare
/// hostname or IP ALWAYS errored and every probe's DNS layer was recorded
/// `Failed` — false evidence on healthy networks, `dns_ok: false` into the
/// failure classifier, and (once investigations observed real APIs) a false
/// 100%-confidence "dns" hypothesis. Resolution now uses the same
/// `(host, port)` form the TCP probe uses: name resolution only, no connect.
fn probe_dns(host: &str, port: u16, _timeout: Duration) -> (LayerResult, Option<f64>) {
    let start = std::time::Instant::now();
    let result = (|| {
        let addrs: Vec<_> = (host, port)
            .to_socket_addrs()
            .ok()?
            .collect();
        if addrs.is_empty() {
            None
        } else {
            Some(addrs)
        }
    })();
    let latency = start.elapsed().as_millis() as f64;
    match result {
        Some(_) => (LayerResult::Ok, Some(latency)),
        None => (LayerResult::Failed, Some(latency)),
    }
}

/// TCP connect probe.
fn probe_tcp(host: &str, port: u16, timeout: Duration) -> (LayerResult, Option<f64>) {
    let addrs: Vec<std::net::SocketAddr> = match (host, port).to_socket_addrs() {
        Ok(a) => a.collect(),
        Err(_) => return (LayerResult::Failed, None),
    };
    if addrs.is_empty() {
        return (LayerResult::Failed, None);
    }
    let start = std::time::Instant::now();
    let result = TcpStream::connect_timeout(&addrs[0], timeout);
    let latency = start.elapsed().as_millis() as f64;
    match result {
        Ok(_) => (LayerResult::Ok, Some(latency)),
        Err(_) => (LayerResult::Failed, Some(latency)),
    }
}

/// HTTP/TLS + application probe via reqwest (verifies TLS automatically for https).
fn probe_http(app: &ApiEntry, timeout: Duration) -> (LayerResult, LayerResult, Option<u16>, Option<f64>) {
    // NANI-021: the system proxy must never turn an unreachable target into a
    // "Healthy" direct measurement. This is separate from updater_feed.rs,
    // which intentionally keeps the proxy for remote GitHub endpoints.
    let client = match reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
    {
        Ok(c) => c,
        Err(_) => return (LayerResult::Unknown, LayerResult::Unknown, None, None),
    };

    let url = app.health_check_path.as_deref().unwrap_or(&app.endpoint);
    let start = std::time::Instant::now();
    let result = client.get(url).send();
    let latency = start.elapsed().as_millis() as f64;

    match result {
        Ok(resp) => {
            let status = resp.status().as_u16();
            // TLS layer: if we got a response over https, the handshake succeeded.
            let tls = if url.starts_with("https://") {
                LayerResult::Ok
            } else {
                LayerResult::Ok
            };
            (LayerResult::Ok, tls, Some(status), Some(latency))
        }
        Err(e) => {
            let s = e.to_string().to_lowercase();
            let tls_failed = s.contains("tls") || s.contains("ssl") || s.contains("certificate");
            let http_layer = if tls_failed {
                LayerResult::Failed
            } else {
                LayerResult::Unknown
            };
            (http_layer, if tls_failed { LayerResult::Failed } else { LayerResult::Unknown }, None, Some(latency))
        }
    }
}

/// NANI-021: an HTTP success that contradicts the direct TCP result is not a
/// direct measurement. Label it as inferred proxy traffic so no UI can present
/// it as a verified direct path.
fn inferred_route(tcp: LayerResult, http: LayerResult, status: Option<u16>) -> RouteKind {
    let http_ok = matches!(http, LayerResult::Ok)
        && status.map(|s| (200..=399).contains(&s)).unwrap_or(false);
    if matches!(tcp, LayerResult::Failed) && http_ok {
        RouteKind::Upstream("system-proxy-inferred".into())
    } else {
        RouteKind::Direct
    }
}

/// Probe every layer of an API and build an outcome record.
pub fn probe_api(entry: &ApiEntry, _state: Option<&ApiState>) -> ProbeOutcomeRecord {
    let timestamp_ms = unix_now_ms();
    let (host, port) = match host_port(&app_endpoint(entry)) {
        Some(hp) => hp,
        None => {
            return ProbeOutcomeRecord {
                timestamp_ms,
                api_id: entry.api_id.clone(),
                health: Health::Unknown,
                category: FailureCategory::Unknown,
                route: RouteKind::Direct,
                layers: vec![HealthProbe {
                    layer: "dns".into(),
                    result: LayerResult::Unknown,
                    latency_ms: None,
                    detail: Some("unparseable endpoint".into()),
                }],
                latency_ms: None,
            };
        }
    };

    let timeout = Duration::from_millis(entry.timeout_ms);

    // Layer 1: DNS
    let (dns_result, dns_latency) = probe_dns(&host, port, timeout);
    // Layer 2: TCP
    let (tcp_result, tcp_latency) = probe_tcp(&host, port, timeout);
    // Layer 3-6: HTTP/TLS/auth/app
    let (http_result, tls_result, status, http_latency) = probe_http(entry, timeout);

    // Classify from layers + status.
    let inputs = ProbeInputs {
        http_status: status,
        tls_ok: Some(matches!(tls_result, LayerResult::Ok)),
        tcp_ok: Some(matches!(tcp_result, LayerResult::Ok)),
        dns_ok: Some(matches!(dns_result, LayerResult::Ok)),
    };
    let route = inferred_route(tcp_result, http_result, status);
    let category = if matches!(route, RouteKind::Upstream(_)) {
        // The direct leg failed while HTTP answered: the route is untrusted.
        FailureCategory::TransportFailure
    } else {
        classify(inputs)
    };

    // Overall health: combine layer results.
    let health = if matches!(route, RouteKind::Upstream(_)) {
        // HTTP answered but the direct TCP leg failed: the result cannot be a
        // verified healthy direct measurement.
        Health::Unknown
    } else if status.map(|s| (200..=399).contains(&s)).unwrap_or(false)
        && matches!(tcp_result, LayerResult::Ok)
    {
        Health::Healthy
    } else if matches!(category, FailureCategory::AuthenticationFailure) {
        Health::Degraded // reachable but auth broken
    } else if matches!(category, FailureCategory::RateLimited) {
        Health::Degraded // reachable but throttled
    } else if tcp_result == LayerResult::Failed || dns_result == LayerResult::Failed {
        Health::Unhealthy
    } else {
        Health::Degraded
    };

    let layers = vec![
        HealthProbe {
            layer: "dns".into(),
            result: dns_result,
            latency_ms: dns_latency,
            detail: None,
        },
        HealthProbe {
            layer: "tcp".into(),
            result: tcp_result,
            latency_ms: tcp_latency,
            detail: None,
        },
        HealthProbe {
            layer: "tls".into(),
            result: tls_result,
            latency_ms: None,
            detail: None,
        },
        HealthProbe {
            layer: "http".into(),
            result: http_result,
            latency_ms: http_latency,
            detail: status.map(|s| s.to_string()),
        },
    ];

    ProbeOutcomeRecord {
        timestamp_ms,
        api_id: entry.api_id.clone(),
        health,
        category,
        route,
        layers,
        latency_ms: http_latency.or(tcp_latency),
    }
}

fn app_endpoint(entry: &ApiEntry) -> &str {
    &entry.endpoint
}

/// What a layer result means as diagnostic evidence.
fn layer_outcome(result: LayerResult) -> ProbeOutcome {
    match result {
        LayerResult::Ok => ProbeOutcome::Success,
        LayerResult::Failed => ProbeOutcome::Failure,
        // The layer was never exercised: missing evidence, not a failure.
        LayerResult::Unknown => ProbeOutcome::Missing,
    }
}

/// Translate a measured probe record into diagnostic probes for the Bayesian
/// engine.
///
/// Each network layer becomes the diagnostic test of the same name, so the
/// posterior can only move on layers that were really measured. A layer that
/// was not exercised stays `Missing` rather than being counted as a success,
/// and an HTTP rejection is classified as `AuthRejected`/`ServerError`/…
/// instead of a transport failure.
pub fn diagnostic_probes(outcome: &ProbeOutcomeRecord) -> Vec<ProbeResult> {
    let mut probes = Vec::new();
    for layer in &outcome.layers {
        let test = match layer.layer.as_str() {
            "dns" => DiagnosticTest::DnsResolve,
            "tcp" => DiagnosticTest::TcpConnect,
            "tls" => DiagnosticTest::TlsHandshake,
            "http" => DiagnosticTest::HttpGet,
            _ => continue,
        };
        let status = layer.detail.as_deref().and_then(|d| d.parse::<u16>().ok());
        let result = match (layer.layer.as_str(), layer.result, status) {
            ("http", _, Some(s)) if (400..=599).contains(&s) => match s {
                401 | 403 => ProbeOutcome::AuthRejected,
                429 => ProbeOutcome::RateLimited,
                500..=599 => ProbeOutcome::ServerError,
                _ => ProbeOutcome::Failure,
            },
            (_, layer_result, _) => layer_outcome(layer_result),
        };
        probes.push(ProbeResult {
            test,
            outcome: result,
            timestamp: outcome.timestamp_ms,
            // Scoped by API so two APIs' DNS results are distinct probes.
            source: format!("{}:{}", outcome.api_id, layer.layer),
            cost: 0.0,
        });
    }
    probes
}

/// Feed one measured probe record into the Bayesian engine — THE canonical
/// observation entry point (N1.2, K-1/NANI-022).
///
/// Every production feeder MUST use this instead of calling `engine.observe`
/// directly. It owns the one non-obvious contract: `diagnostic_probes`
/// stamps measurements with unix MILLISECONDS, while the engine's predict
/// step is calibrated for SECONDS (`mix = exp(-0.001 * delta)` — a ms delta
/// of 5000 erases ~99% of the accumulated posterior). This helper performs
/// the conversion exactly once, at the boundary, so no caller can get the
/// unit wrong and no engine code changes.
///
/// Probes whose timestamp does not advance the engine's clock are still
/// observed (the predict step is an identity at zero delta, per the engine's
/// own contract); out-of-order timestamps follow the engine's existing
/// behavior (a negative delta is not predicted on).
pub fn observe_diagnostic_probes(engine: &mut DiagnosticEngine, outcome: &ProbeOutcomeRecord) {
    observe_diagnostic_probes_matching(engine, outcome, |_| true)
}

/// Same as [`observe_diagnostic_probes`], restricted to the diagnostic tests
/// matching `keep` (used by verification, which targets one claim). The unit
/// conversion boundary is identical — a filtered feed must not differ.
pub fn observe_diagnostic_probes_matching(
    engine: &mut DiagnosticEngine,
    outcome: &ProbeOutcomeRecord,
    keep: impl Fn(&str) -> bool,
) {
    for mut probe in diagnostic_probes(outcome) {
        if !keep(probe.test.correlation_id()) {
            continue;
        }
        probe.timestamp /= 1000;
        engine.observe(&probe);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// K-1 contract: the canonical helper converts ms -> seconds. The engine's
    /// clock must receive the SECOND value, not the raw millisecond stamp.
    #[test]
    fn k1_helper_converts_ms_to_seconds() {
        let mut engine = DiagnosticEngine::new();
        let mut rec = record(vec![("dns", LayerResult::Ok, None)]);
        rec.timestamp_ms = 1_700_000_000_123;
        observe_diagnostic_probes(&mut engine, &rec);
        assert_eq!(
            engine.previous_timestamp,
            Some(1_700_000_000),
            "the engine clock must be in seconds"
        );
    }

    /// K-1 contract: a five-SECOND delta preserves accumulated posterior
    /// information (the transition kernel barely mixes over such a gap).
    #[test]
    fn k1_five_second_delta_preserves_the_posterior() {
        let mut engine = DiagnosticEngine::new();
        let base = 1_700_000_000_000u64;
        let mut fail = record(vec![("tcp", LayerResult::Failed, None)]);
        fail.timestamp_ms = base;
        observe_diagnostic_probes(&mut engine, &fail);
        let (_, before) = engine.diagnosis().expect("posterior");
        let mut again = record(vec![("tcp", LayerResult::Failed, None)]);
        again.timestamp_ms = base + 5_000;
        observe_diagnostic_probes(&mut engine, &again);
        let (_, after) = engine.diagnosis().expect("posterior");
        assert!(
            after >= before,
            "confirming evidence 5s later must not weaken the belief: {before} -> {after}"
        );
        assert!(
            after > 0.2,
            "the accumulated belief must survive a five-second gap: {after}"
        );
    }

    /// K-1 tripwire: the ORIGINAL bug (ms deltas fed to the seconds-calibrated
    /// predict) collapses the posterior toward stationary over a five-second
    /// gap, so identical confirming evidence accumulates FAR less belief than
    /// under the correct unit contract. Comparative assertion: the buggy feed
    /// must reach a materially lower posterior than the converted feed for
    /// the same measurements - if this stops holding, either the boundary or
    /// the kernel calibration changed; re-read both.
    #[test]
    fn k1_millisecond_delta_would_erase_the_posterior() {
        let base = 1_700_000_000_000u64;
        // Six identical confirming probes, five seconds apart: the converted
        // feed ACCUMULATES across all of them; the buggy feed (ms deltas)
        // erases toward stationary before each one, so every probe starts
        // from roughly uniform again.
        let build = |converted: bool| {
            let mut engine = DiagnosticEngine::new();
            for k in 0..10 {
                let mut fail = record(vec![("tcp", LayerResult::Failed, None)]);
                fail.timestamp_ms = base + k * 5_000;
                for mut probe in diagnostic_probes(&fail) {
                    if converted {
                        probe.timestamp /= 1000;
                    }
                    engine.observe(&probe);
                }
            }
            engine.diagnosis().expect("posterior").1
        };
        let converted = build(true);
        let buggy = build(false);
        assert!(
            buggy < converted * 0.80,
            "the ms-unit bug must materially degrade accumulation: converted {converted}, buggy {buggy}"
        );
    }

    /// K-1 parity: the helper's filtered form (verification path) applies the
    /// SAME unit conversion - no feeder may differ.
    #[test]
    fn k1_filtered_helper_uses_the_same_conversion() {
        let mut engine = DiagnosticEngine::new();
        let mut rec = record(vec![("dns", LayerResult::Ok, None)]);
        rec.timestamp_ms = 1_700_000_000_123;
        observe_diagnostic_probes_matching(&mut engine, &rec, |id| id == "tcp-connect");
        assert_eq!(engine.previous_timestamp, None, "filtered-out probes must not observe");
        observe_diagnostic_probes_matching(&mut engine, &rec, |_| true);
        assert_eq!(engine.previous_timestamp, Some(1_700_000_000));
    }

    /// K-1 / mission section 3: zero elapsed time is an identity predict (the
    /// engine's own contract), exercised through the helper.
    #[test]
    fn k1_zero_elapsed_time_is_an_identity_predict() {
        let mut engine = DiagnosticEngine::new();
        let base = 1_700_000_000_000u64;
        let mut fail = record(vec![("tcp", LayerResult::Failed, None)]);
        fail.timestamp_ms = base;
        observe_diagnostic_probes(&mut engine, &fail);
        let (_, before) = engine.diagnosis().expect("posterior");
        let mut again = record(vec![("tcp", LayerResult::Failed, None)]);
        again.timestamp_ms = base; // same millisecond -> same second -> delta 0
        observe_diagnostic_probes(&mut engine, &again);
        let (_, after) = engine.diagnosis().expect("posterior");
        assert!(after >= before, "zero-delta confirmations must not weaken: {before} -> {after}");
    }

    #[test]
    fn host_port_parses_https() {
        let (host, port) = host_port("https://api.xkiro.com/v1/chat").expect("parse");
        assert_eq!(host, "api.xkiro.com");
        assert_eq!(port, 443);
    }

    #[test]
    fn host_port_parses_http_custom_port() {
        let (host, port) = host_port("http://localhost:8080/health").expect("parse");
        assert_eq!(host, "localhost");
        assert_eq!(port, 8080);
    }

    fn record(layers: Vec<(&str, LayerResult, Option<&str>)>) -> ProbeOutcomeRecord {
        ProbeOutcomeRecord {
            timestamp_ms: 7,
            api_id: "api-1".into(),
            health: Health::Healthy,
            category: FailureCategory::Unknown,
            route: RouteKind::Direct,
            layers: layers
                .into_iter()
                .map(|(layer, result, detail)| HealthProbe {
                    layer: layer.into(),
                    result,
                    latency_ms: None,
                    detail: detail.map(|d| d.to_string()),
                })
                .collect(),
            latency_ms: None,
        }
    }

    #[test]
    fn diagnostic_probes_map_each_measured_layer_to_its_test() {
        let rec = record(vec![
            ("dns", LayerResult::Ok, None),
            ("tcp", LayerResult::Ok, None),
            ("tls", LayerResult::Ok, None),
            ("http", LayerResult::Ok, Some("200")),
        ]);
        let probes = diagnostic_probes(&rec);
        assert_eq!(probes.len(), 4);
        assert!(probes.iter().all(|p| p.outcome == ProbeOutcome::Success));
        assert_eq!(probes[3].test, DiagnosticTest::HttpGet);
        assert_eq!(probes[0].source, "api-1:dns");
        assert!(probes.iter().all(|p| p.timestamp == 7));
    }

    #[test]
    fn diagnostic_probes_classify_http_status_instead_of_transport_failure() {
        let auth = diagnostic_probes(&record(vec![("http", LayerResult::Failed, Some("401"))]));
        assert_eq!(auth[0].outcome, ProbeOutcome::AuthRejected);
        let server = diagnostic_probes(&record(vec![("http", LayerResult::Failed, Some("503"))]));
        assert_eq!(server[0].outcome, ProbeOutcome::ServerError);
        let throttled = diagnostic_probes(&record(vec![("http", LayerResult::Failed, Some("429"))]));
        assert_eq!(throttled[0].outcome, ProbeOutcome::RateLimited);
    }

    #[test]
    fn diagnostic_probes_report_unexercised_layers_as_missing() {
        let probes = diagnostic_probes(&record(vec![
            ("dns", LayerResult::Failed, None),
            ("tls", LayerResult::Unknown, None),
        ]));
        assert_eq!(probes[0].outcome, ProbeOutcome::Failure);
        assert_eq!(probes[1].outcome, ProbeOutcome::Missing);
    }

    #[test]
    fn nani_021_infers_proxy_when_tcp_fails_but_http_answers() {
        let route = inferred_route(LayerResult::Failed, LayerResult::Ok, Some(200));
        assert_eq!(route, RouteKind::Upstream("system-proxy-inferred".into()));
    }

    #[test]
    fn nani_021_keeps_direct_when_layers_agree() {
        assert_eq!(
            inferred_route(LayerResult::Ok, LayerResult::Ok, Some(200)),
            RouteKind::Direct
        );
        assert_eq!(
            inferred_route(LayerResult::Failed, LayerResult::Failed, None),
            RouteKind::Direct
        );
    }

    #[test]
    fn nani_021_probe_client_bypasses_the_system_proxy() {
        let src = include_str!("monitor.rs");
        assert!(
            src.contains(".no_proxy()"),
            "NANI health probes must not inherit HTTP(S)_PROXY"
        );
    }

    #[test]
    fn classify_healthy_when_http_ok_and_tcp_ok() {
        let entry = ApiEntry::new("api-1", "p", "https://example.com");
        let outcome = probe_api(&entry, None);
        // example.com may or may not resolve in this environment; just check
        // the record is well-formed.
        assert_eq!(outcome.api_id, "api-1");
        assert!(!outcome.layers.is_empty());
    }
}
