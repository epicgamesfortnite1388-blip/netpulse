//! Server-side failure classification.
//!
//! Turns raw probe observations (status code, TLS/TCP/DNS results) into a
//! [`FailureCategory`]. Mirrors the frontend's
//! `lib/failureIntelligence.ts` cautious-qualifier principle on the server:
//! classification is structural, never a certainty claim, and a missing layer
//! is reported as unknown rather than inferred.

use crate::network_intelligence::api_model::{classify_failure, FailureCategory};

/// The raw inputs a probe can observe about an API call.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProbeInputs {
    pub http_status: Option<u16>,
    pub tls_ok: Option<bool>,
    pub tcp_ok: Option<bool>,
    pub dns_ok: Option<bool>,
}

/// Classify the failure (or health) of a single probe.
///
/// Returns `FailureCategory::Healthy` only when a 2xx/3xx status was observed
/// and the lower layers are consistent. Returns `FailureCategory::Unknown`
/// when there is not enough evidence to classify — never guesses.
pub fn classify(inputs: ProbeInputs) -> FailureCategory {
    classify_failure(inputs.http_status, inputs.tls_ok, inputs.tcp_ok, inputs.dns_ok)
}

/// Human summary for a category (no secrets, no raw error text).
pub fn category_summary(category: FailureCategory) -> String {
    match category {
        FailureCategory::Healthy => "API responded successfully.".into(),
        FailureCategory::DnsFailure => "DNS resolution failed; the hostname could not be resolved.".into(),
        FailureCategory::TransportFailure => "TCP connection could not be established (refused or timed out).".into(),
        FailureCategory::TlsFailure => "TLS handshake failed or certificate verification did not pass.".into(),
        FailureCategory::HttpError => "HTTP response indicated an error (client-side 4xx).".into(),
        FailureCategory::AuthenticationFailure => "Authentication was rejected (HTTP 401/403).".into(),
        FailureCategory::RateLimited => "The provider rate-limited the request (HTTP 429).".into(),
        FailureCategory::ServerFailure => "The provider returned a server error (HTTP 5xx).".into(),
        FailureCategory::Unknown => "Not enough evidence to classify the failure.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_http_statuses() {
        assert_eq!(
            classify(ProbeInputs { http_status: Some(401), ..Default::default() }),
            FailureCategory::AuthenticationFailure
        );
        assert_eq!(
            classify(ProbeInputs { http_status: Some(429), ..Default::default() }),
            FailureCategory::RateLimited
        );
        assert_eq!(
            classify(ProbeInputs { http_status: Some(500), ..Default::default() }),
            FailureCategory::ServerFailure
        );
        assert_eq!(
            classify(ProbeInputs { http_status: Some(200), ..Default::default() }),
            FailureCategory::Healthy
        );
    }

    #[test]
    fn no_status_means_unknown_not_a_guess() {
        assert_eq!(
            classify(ProbeInputs::default()),
            FailureCategory::Unknown
        );
    }

    #[test]
    fn summaries_are_non_empty() {
        for c in [
            FailureCategory::Healthy,
            FailureCategory::DnsFailure,
            FailureCategory::TransportFailure,
            FailureCategory::TlsFailure,
            FailureCategory::HttpError,
            FailureCategory::AuthenticationFailure,
            FailureCategory::RateLimited,
            FailureCategory::ServerFailure,
            FailureCategory::Unknown,
        ] {
            let s = category_summary(c);
            assert!(!s.is_empty(), "category {:?} has no summary", c);
        }
    }
}
