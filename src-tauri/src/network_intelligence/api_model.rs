// API health model and failure classification.
//
// Distinguishes network reachability from transport availability, TLS
// validity, HTTP availability, authentication, rate limiting, and application
// correctness. An HTTP 401 is not a network outage; an HTTP 429 is not a
// reason to rotate proxies repeatedly; an HTTP 500 is not automatically a
// local routing problem.
//
// No secrets (authorization headers, request bodies) ever enter model
// features.

use crate::network_intelligence::math::{clamp_probability, sigmoid};
use crate::network_intelligence::probability::BetaBernoulli;
use std::collections::HashMap;

/// Categorization of an API failure, used to route the correct recovery
/// action rather than blindly retrying.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum FailureCategory {
    /// DNS could not resolve the host.
    DnsFailure,
    /// TCP handshake failed / connection refused / timeout.
    TransportFailure,
    /// TLS handshake failed or certificate invalid.
    TlsFailure,
    /// HTTP response received but indicates an error (4xx/5xx except auth/rate-limit).
    HttpError,
    /// HTTP 401 / 403 — credentials invalid or missing.
    AuthenticationFailure,
    /// HTTP 429 — rate limited by the provider.
    RateLimited,
    /// Server-side application error (5xx).
    ServerFailure,
    /// The API is reachable and responding correctly.
    Healthy,
    /// Could not determine (missing data).
    Unknown,
}

/// Classify an observed API response into a failure category.
///
/// `status` is the HTTP status code, if any. `tls_ok` is whether TLS
// verification succeeded. `tcp_ok` is whether TCP was established.
/// `dns_ok` is whether DNS resolved.
///
/// Classification is ordered from most specific to most general so that an
/// HTTP 401 is classified as AuthenticationFailure, not HttpError.
pub fn classify_failure(
    status: Option<u16>,
    tls_ok: Option<bool>,
    tcp_ok: Option<bool>,
    dns_ok: Option<bool>,
) -> FailureCategory {
    if let Some(s) = status {
        match s {
            401 | 403 => return FailureCategory::AuthenticationFailure,
            429 => return FailureCategory::RateLimited,
            500..=599 => return FailureCategory::ServerFailure,
            400..=499 => return FailureCategory::HttpError,
            200..=399 => return FailureCategory::Healthy,
            _ => return FailureCategory::Unknown,
        }
    }
    // No HTTP status: look at lower layers.
    match tls_ok {
        Some(false) => return FailureCategory::TlsFailure,
        Some(true) => {}
        None => {}
    }
    match tcp_ok {
        Some(false) => return FailureCategory::TransportFailure,
        Some(true) => {}
        None => {}
    }
    match dns_ok {
        Some(false) => return FailureCategory::DnsFailure,
        Some(true) => {}
        None => {}
    }
    FailureCategory::Unknown
}

/// A single observed outcome of an API call, recorded for learning.
#[derive(Debug, Clone)]
pub struct ApiOutcome {
    pub api_id: String,
    pub route: RouteKind,
    pub category: FailureCategory,
    pub latency_ms: Option<f64>,
    pub timestamp: u64,
    /// Whether the call ultimately succeeded (2xx).
    pub success: bool,
}

/// Whether a call went direct or through an approved upstream.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RouteKind {
    Direct,
    Upstream(String), // identifier of the upstream/proxy
}

/// Feature vector for the Bayesian logistic model. No secrets included.
#[derive(Debug, Clone)]
pub struct RouteFeatures {
    pub api_id: String,
    pub is_direct: bool,
    pub upstream_category: Option<String>, // e.g. "residential", "datacenter", None
    pub recent_success_rate: f64,          // EWMA over last N calls
    pub dns_ok: bool,
    pub tls_ok: bool,
    pub latency_ms: f64,
    pub time_since_last_success_sec: f64,
    pub consecutive_failures: u64,
}

impl RouteFeatures {
    /// Neutral features when nothing is known yet.
    pub fn neutral(api_id: &str) -> Self {
        Self {
            api_id: api_id.to_string(),
            is_direct: true,
            upstream_category: None,
            recent_success_rate: 0.5,
            dns_ok: false,
            tls_ok: false,
            latency_ms: 0.0,
            time_since_last_success_sec: f64::INFINITY,
            consecutive_failures: 0,
        }
    }
}

/// A Bayesian logistic regression model predicting API success probability.
///
/// Uses a hierarchical structure:
///   theta_i = theta_global + delta_i
///
/// so information is shared between APIs while retaining API-specific
/// behavior. Each coefficient gets its own BetaBernoulli-style conjugate
/// update via a Gaussian approximation (Laplace) — in practice we track a
/// per-coefficient mean and variance and update with stochastic gradient
/// on the log-likelihood, which is the standard Bayesian logistic update.
///
/// For simplicity and numerical stability on a local desktop, each
/// coefficient is modeled independently with a Gaussian prior N(0, prior_var).
#[derive(Debug, Clone)]
pub struct ApiPredictor {
    /// Global coefficients shared across all APIs.
    pub global_theta: Vec<f64>,
    /// Global coefficient variances.
    pub global_var: Vec<f64>,
    /// Per-API deviations (delta_i).
    pub api_delta: HashMap<String, Vec<f64>>,
    /// Per-API deviation variances.
    pub api_delta_var: HashMap<String, Vec<f64>>,
    /// Prior variance for each coefficient (controls shrinkage).
    pub prior_variance: f64,
    /// Number of features.
    pub n_features: usize,
    /// Per-API BetaBernoulli tracking overall success rate (for calibration).
    pub api_success_tracker: HashMap<String, BetaBernoulli>,
}

impl ApiPredictor {
    /// Create a new predictor with `n_features` coefficients.
    pub fn new(n_features: usize) -> Self {
        Self {
            global_theta: vec![0.0; n_features],
            global_var: vec![1.0; n_features],
            api_delta: HashMap::new(),
            api_delta_var: HashMap::new(),
            prior_variance: 1.0,
            n_features,
            api_success_tracker: HashMap::new(),
        }
    }

    /// Full coefficient vector for an API: global + delta.
    fn coefficients_for(&self, api_id: &str) -> Vec<f64> {
        let delta = self
            .api_delta
            .get(api_id)
            .cloned()
            .unwrap_or_else(|| vec![0.0; self.n_features]);
        self.global_theta
            .iter()
            .zip(delta.iter())
            .map(|(g, d)| g + d)
            .collect()
    }

    /// Predict success probability `P(Y=1 | x, a, i) = sigmoid(theta^T phi)`.
    ///
    /// Returns `None` if the feature vector has the wrong length.
    pub fn predict(&self, api_id: &str, features: &RouteFeatures) -> Option<f64> {
        let x = feature_vector(features);
        if x.len() != self.n_features {
            return None;
        }
        let theta = self.coefficients_for(api_id);
        let logit: f64 = theta.iter().zip(x.iter()).map(|(t, xi)| t * xi).sum();
        Some(clamp_probability(sigmoid(logit)))
    }

    /// Observe an outcome and update the model. Uses a single step of
    /// stochastic gradient ascent on the Bayesian logistic log-posterior
    /// (prior N(0, prior_variance) + likelihood).
    ///
    /// `learning_rate` controls step size; smaller = more conservative.
    pub fn observe(
        &mut self,
        api_id: &str,
        features: &RouteFeatures,
        success: bool,
        learning_rate: f64,
    ) {
        let x = feature_vector(features);
        if x.len() != self.n_features {
            return;
        }
        let lr = clamp_probability(learning_rate);
        let y: f64 = if success { 1.0 } else { 0.0 };

        let theta = self.coefficients_for(api_id);
        let logit: f64 = theta.iter().zip(x.iter()).map(|(t, xi)| t * xi).sum();
        let p = sigmoid(logit);

        // Gradient of log-likelihood w.r.t. theta: (y - p) * x
        // Gradient of log-prior w.r.t. theta: -theta / prior_variance
        let grad: Vec<f64> = theta
            .iter()
            .zip(x.iter())
            .enumerate()
            .map(|(k, (t, xi))| {
                let likelihood_grad = (y - p) * xi;
                let prior_grad = -t / self.prior_variance;
                likelihood_grad + prior_grad
            })
            .collect();

        // Split the update between global and API-specific delta.
        // A simple heuristic: global learns slowly, delta learns faster.
        let global_lr = lr * 0.3;
        let delta_lr = lr * 0.7;

        for k in 0..self.n_features {
            self.global_theta[k] += global_lr * grad[k];
            self.global_var[k] = (self.global_var[k] * 0.99 + 0.01).max(1e-6);
        }

        let delta = self.api_delta.entry(api_id.to_string()).or_insert_with(|| vec![0.0; self.n_features]);
        let delta_var = self
            .api_delta_var
            .entry(api_id.to_string())
            .or_insert_with(|| vec![1.0; self.n_features]);
        for k in 0..self.n_features {
            delta[k] += delta_lr * grad[k];
            delta_var[k] = (delta_var[k] * 0.99 + 0.01).max(1e-6);
        }

        // Update the per-API success tracker (conjugate Beta-Bernoulli).
        let tracker = self
            .api_success_tracker
            .entry(api_id.to_string())
            .or_insert_with(|| BetaBernoulli::jeffreys());
        tracker.observe(Some(success));
    }

    /// Overall calibrated success rate for an API (from the Beta-Bernoulli
    /// tracker), independent of route features.
    pub fn api_base_rate(&self, api_id: &str) -> f64 {
        self.api_success_tracker
            .get(api_id)
            .map(|m| m.mean())
            .unwrap_or(0.5)
    }

    /// Predictive uncertainty (std dev) for an API prediction — proxy for
    /// "how much do we really know about this API?".
    pub fn api_uncertainty(&self, api_id: &str) -> f64 {
        self.api_success_tracker
            .get(api_id)
            .map(|m| m.std_dev())
            .unwrap_or(0.5)
    }
}

/// Build the numeric feature vector from [`RouteFeatures`].
///
/// Order:
///   0: is_direct (1/0)
///   1: upstream_category encoded (0=none, 1=residential, 2=datacenter, 3=other)
///   2: recent_success_rate
///   3: dns_ok (1/0)
///   4: tls_ok (1/0)
///   5: latency_ms (log-scaled, clamped)
///   6: time_since_last_success_sec (log-scaled, clamped)
///   7: consecutive_failures (log-scaled, clamped)
pub fn feature_vector(f: &RouteFeatures) -> Vec<f64> {
    let upstream_code = match f.upstream_category.as_deref() {
        None => 0.0,
        Some("residential") => 1.0,
        Some("datacenter") => 2.0,
        _ => 3.0,
    };
    let latency = if f.latency_ms > 0.0 {
        (f.latency_ms / 1000.0).ln().max(-5.0).min(5.0)
    } else {
        0.0
    };
    let time_since = if f.time_since_last_success_sec.is_finite() && f.time_since_last_success_sec > 0.0 {
        (f.time_since_last_success_sec / 60.0).ln().max(-5.0).min(5.0)
    } else {
        0.0
    };
    let failures = if f.consecutive_failures > 0 {
        (f.consecutive_failures as f64).ln().max(0.0).min(5.0)
    } else {
        0.0
    };
    vec![
        if f.is_direct { 1.0 } else { 0.0 },
        upstream_code,
        clamp_probability(f.recent_success_rate),
        if f.dns_ok { 1.0 } else { 0.0 },
        if f.tls_ok { 1.0 } else { 0.0 },
        latency,
        time_since,
        failures,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_http_401_is_auth_failure_not_network() {
        assert_eq!(
            classify_failure(Some(401), Some(true), Some(true), Some(true)),
            FailureCategory::AuthenticationFailure
        );
    }

    #[test]
    fn classify_http_429_is_rate_limit() {
        assert_eq!(
            classify_failure(Some(429), Some(true), Some(true), Some(true)),
            FailureCategory::RateLimited
        );
    }

    #[test]
    fn classify_http_500_is_server_failure() {
        assert_eq!(
            classify_failure(Some(500), Some(true), Some(true), Some(true)),
            FailureCategory::ServerFailure
        );
    }

    #[test]
    fn classify_tls_failure_without_status() {
        assert_eq!(
            classify_failure(None, Some(false), Some(true), Some(true)),
            FailureCategory::TlsFailure
        );
    }

    #[test]
    fn classify_transport_failure_without_status() {
        assert_eq!(
            classify_failure(None, None, Some(false), Some(true)),
            FailureCategory::TransportFailure
        );
    }

    #[test]
    fn classify_dns_failure_without_status() {
        assert_eq!(
            classify_failure(None, None, None, Some(false)),
            FailureCategory::DnsFailure
        );
    }

    #[test]
    fn classify_healthy_2xx() {
        assert_eq!(
            classify_failure(Some(200), Some(true), Some(true), Some(true)),
            FailureCategory::Healthy
        );
    }

    #[test]
    fn classifier_has_no_status_returns_unknown_not_a_guess() {
        assert_eq!(
            classify_failure(None, None, None, None),
            FailureCategory::Unknown
        );
    }

    #[test]
    fn predictor_predicts_between_zero_and_one() {
        let mut p = ApiPredictor::new(8);
        let f = RouteFeatures::neutral("api-a");
        let prob = p.predict("api-a", &f).expect("valid features");
        assert!(prob >= 0.0 && prob <= 1.0);
    }

    #[test]
    fn predictor_wrong_feature_length_returns_none() {
        let p = ApiPredictor::new(8);
        let f = RouteFeatures::neutral("api-a");
        // feature_vector produces 8 features; predict with a 3-feature model
        let p3 = ApiPredictor::new(3);
        assert!(p3.predict("api-a", &f).is_none());
    }

    #[test]
    fn predictor_learns_from_outcomes() {
        let mut p = ApiPredictor::new(8);
        // Features that strongly indicate success: direct, DNS ok, TLS ok, low latency, no failures
        let good = RouteFeatures {
            api_id: "api-x".into(),
            is_direct: true,
            upstream_category: None,
            recent_success_rate: 0.9,
            dns_ok: true,
            tls_ok: true,
            latency_ms: 50.0,
            time_since_last_success_sec: 10.0,
            consecutive_failures: 0,
        };
        // Features that strongly indicate failure
        let bad = RouteFeatures {
            api_id: "api-x".into(),
            is_direct: false,
            upstream_category: Some("datacenter".into()),
            recent_success_rate: 0.1,
            dns_ok: false,
            tls_ok: false,
            latency_ms: 5000.0,
            time_since_last_success_sec: 3600.0,
            consecutive_failures: 10,
        };

        // Train on good = success, bad = failure
        for _ in 0..200 {
            p.observe("api-x", &good, true, 0.1);
            p.observe("api-x", &bad, false, 0.1);
        }

        let p_good = p.predict("api-x", &good).expect("predict");
        let p_bad = p.predict("api-x", &bad).expect("predict");
        assert!(p_good > p_bad, "model should rank good route above bad route: {p_good} vs {p_bad}");
    }

    #[test]
    fn api_base_rate_starts_at_jeffreys_half() {
        let p = ApiPredictor::new(8);
        assert!((p.api_base_rate("new-api") - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn base_rate_moves_with_observations() {
        let mut p = ApiPredictor::new(8);
        let f = RouteFeatures::neutral("api-y");
        for _ in 0..90 {
            p.observe("api-y", &f, true, 0.1);
        }
        for _ in 0..10 {
            p.observe("api-y", &f, false, 0.1);
        }
        // Beta(0.5+90, 0.5+10), mean = 90.5/101 ≈ 0.896
        assert!(p.api_base_rate("api-y") > 0.8);
    }
}

