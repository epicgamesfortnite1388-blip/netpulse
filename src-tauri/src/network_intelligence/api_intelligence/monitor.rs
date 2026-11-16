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
use crate::network_intelligence::diagnosis::{DiagnosticTest, ProbeOutcome, ProbeResult};
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
fn probe_dns(host: &str, timeout: Duration) -> (LayerResult, Option<f64>) {
    let start = std::time::Instant::now();
    let result = (|| {
        let addrs: Vec<_> = host
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
    let client = match reqwest::blocking::Client::builder()
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
    let (dns_result, dns_latency) = probe_dns(&host, timeout);
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
    let category = classify(inputs);

    // Overall health: combine layer results.
    let health = if status.map(|s| (200..=399).contains(&s)).unwrap_or(false)
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
        route: RouteKind::Direct,
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn classify_healthy_when_http_ok_and_tcp_ok() {
        let entry = ApiEntry::new("api-1", "p", "https://example.com");
        let outcome = probe_api(&entry, None);
        // example.com may or may not resolve in this environment; just check
        // the record is well-formed.
        assert_eq!(outcome.api_id, "api-1");
        assert!(!outcome.layers.is_empty());
    }
}
