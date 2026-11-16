//! API intelligence — registry, monitor, and recovery engine.
//!
//! The control plane for autonomous API connectivity. It owns:
//!   - a centralized registry of every external/internal API the app depends on
//!   - independent multi-layer health monitoring (DNS → TCP → TLS → HTTP → auth → app)
//!   - failure classification (a 401 is not a network outage; a 429 is not a
//!     reason to rotate proxies)
//!   - an approved-upstream registry + candidate evaluation
//!   - circuit breakers and safe, bounded recovery (detect → classify → test
//!     direct → evaluate approved upstreams → verify → activate → monitor → rollback)
//!
//! No secrets (authorization headers, cookies, tokens, raw request bodies) are
//! stored in registry fields, health records, or emitted events.

use crate::network_intelligence::api_model::{FailureCategory, RouteKind};
use crate::network_intelligence::events::{Event, EventBus};
use crate::network_intelligence::recovery::CircuitBreaker;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// How an API authenticates requests. Never persisted to disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AuthType {
    None,
    Bearer,       // `Authorization: Bearer <token>`
    ApiKey,       // custom header / query key
    TlsMutual,    // mTLS
    SessionCookie,
}

/// Result of a health-check at one layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LayerResult {
    Ok,
    Failed,
    /// The layer could not be tested (missing data, not attempted).
    Unknown,
}

/// Overall health of an API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Health {
    Healthy,
    Degraded,   // reachable but elevated errors / latency
    Unhealthy,  // not reachable or failing auth/app
    Unknown,    // never probed
}

impl Default for Health {
    fn default() -> Self {
        Health::Unknown
    }
}

/// One layer of a multi-layer health check.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthProbe {
    pub layer: String, // "dns" | "tcp" | "tls" | "http" | "auth" | "app"
    pub result: LayerResult,
    pub latency_ms: Option<f64>,
    pub detail: Option<String>, // sanitized (no secrets)
}

/// Outcome of probing an API at one moment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeOutcomeRecord {
    pub timestamp_ms: u64,
    pub api_id: String,
    pub health: Health,
    pub category: FailureCategory,
    pub route: RouteKind,
    pub layers: Vec<HealthProbe>,
    pub latency_ms: Option<f64>,
}

/// A permitted upstream route for an API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpstreamRoute {
    pub id: String,
    /// Human-readable category (e.g. "residential", "datacenter", "corporate").
    /// Never a secret.
    pub category: String,
    /// Whether this upstream is currently authorized for automatic use.
    pub authorized: bool,
    /// Whether TLS verification is enforced (always true in practice).
    pub tls_verified: bool,
}

/// How often an API may be probed / retried.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryPolicy {
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
    pub max_attempts: u32,
    pub jitter: bool, // multiply by U(0.8, 1.2)
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            initial_backoff_ms: 1_000,
            max_backoff_ms: 30_000,
            max_attempts: 4,
            jitter: true,
        }
    }
}

/// The registry entry for one API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiEntry {
    pub api_id: String,
    pub provider: String,
    pub endpoint: String,
    pub auth_type: AuthType,
    /// Expected success response (e.g. "200", "2xx"). Sanitized description only.
    pub expected_response: String,
    /// Health-check path/method override, if any.
    pub health_check_path: Option<String>,
    pub timeout_ms: u64,
    pub retry: RetryPolicy,
    /// Approved upstream routes (empty = direct only).
    pub upstreams: Vec<UpstreamRoute>,
    /// API ids this API depends on (dependency graph edges).
    pub dependencies: Vec<String>,
    /// API ids that depend on this API (reverse edges).
    pub dependents: Vec<String>,
}

impl ApiEntry {
    pub fn new(api_id: &str, provider: &str, endpoint: &str) -> Self {
        Self {
            api_id: api_id.to_string(),
            provider: provider.to_string(),
            endpoint: endpoint.to_string(),
            auth_type: AuthType::None,
            expected_response: "2xx".into(),
            health_check_path: None,
            timeout_ms: 10_000,
            retry: RetryPolicy::default(),
            upstreams: Vec::new(),
            dependencies: Vec::new(),
            dependents: Vec::new(),
        }
    }
}

/// Current tracked state for one API (separate from the static entry).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiState {
    pub api_id: String,
    pub health: Health,
    pub last_category: FailureCategory,
    pub last_success_ms: Option<u64>,
    pub last_failure_ms: Option<u64>,
    pub last_probe_ms: Option<u64>,
    pub consecutive_failures: u64,
    pub circuit_breaker: CircuitBreaker,
}

impl ApiState {
    pub fn new(api_id: &str) -> Self {
        Self {
            api_id: api_id.to_string(),
            health: Health::Unknown,
            last_category: FailureCategory::Unknown,
            last_success_ms: None,
            last_failure_ms: None,
            last_probe_ms: None,
            consecutive_failures: 0,
            circuit_breaker: CircuitBreaker::new(),
        }
    }
}

/// The API registry + current state. Thread-safe, event-emitting.
#[derive(Debug, Clone)]
pub struct ApiRegistry {
    inner: Arc<Mutex<ApiRegistryInner>>,
    events: EventBus,
}

#[derive(Debug)]
struct ApiRegistryInner {
    entries: HashMap<String, ApiEntry>,
    states: HashMap<String, ApiState>,
    /// Ordered list of api_ids for stable iteration.
    order: Vec<String>,
}
impl ApiRegistry {
    pub fn new(events: EventBus) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ApiRegistryInner {
                entries: HashMap::new(),
                states: HashMap::new(),
                order: Vec::new(),
            })),
            events,
        }
    }

    /// Register an API. Returns false if the id already exists (no overwrite).
    pub fn register(&self, entry: ApiEntry) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if inner.entries.contains_key(&entry.api_id) {
            return false;
        }
        inner.order.push(entry.api_id.clone());
        inner.states.insert(entry.api_id.clone(), ApiState::new(&entry.api_id));
        inner.entries.insert(entry.api_id.clone(), entry);
        true
    }

    /// Replace the event bus this registry emits to (called once the Tauri
    /// AppHandle is available during setup).
    pub fn set_event_bus(&mut self, bus: EventBus) {
        self.events = bus;
    }

    /// Get an entry (clone).
    pub fn entry(&self, api_id: &str) -> Option<ApiEntry> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entries
            .get(api_id)
            .cloned()
    }

    /// Get current state (clone).
    pub fn state(&self, api_id: &str) -> Option<ApiState> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .states
            .get(api_id)
            .cloned()
    }

    /// All registered API ids (stable order).
    pub fn ids(&self) -> Vec<String> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .order
            .clone()
    }

    /// All entries.
    pub fn entries(&self) -> Vec<ApiEntry> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entries
            .values()
            .cloned()
            .collect()
    }

    /// All states.
    pub fn states(&self) -> Vec<ApiState> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .states
            .values()
            .cloned()
            .collect()
    }

    /// Record a probe outcome, updating state and emitting events.
    pub fn record_probe(&self, outcome: &ProbeOutcomeRecord) {
        let (previous, current_health, tripped) = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let state = match inner.states.get_mut(&outcome.api_id) {
                Some(s) => s,
                None => return, // unknown API: record nothing
            };

            let previous = state.health;
            state.health = outcome.health;
            state.last_category = outcome.category;
            state.last_probe_ms = Some(outcome.timestamp_ms);
            match outcome.health {
                Health::Healthy => {
                    state.last_success_ms = Some(outcome.timestamp_ms);
                    state.consecutive_failures = 0;
                    state
                        .circuit_breaker
                        .record_success(unix_now_ms() / 1000);
                }
                _ => {
                    state.last_failure_ms = Some(outcome.timestamp_ms);
                    state.consecutive_failures += 1;
                    state
                        .circuit_breaker
                        .record_failure(unix_now_ms() / 1000);
                }
            }
            (previous, state.health, state.circuit_breaker.is_tripped())
        }; // inner lock dropped here

        // Emit events outside the lock, using owned data from `outcome`.
        if previous != current_health {
            self.events.emit(Event::ApiHealthChanged {
                api_id: outcome.api_id.clone(),
                previous: format!("{:?}", previous),
                current: format!("{:?}", current_health),
                category: format!("{:?}", outcome.category),
                confidence: "likely".into(),
            });
        }
        if outcome.health == Health::Unhealthy {
            self.events.emit(Event::FailureDetected {
                api_id: outcome.api_id.clone(),
                category: format!("{:?}", outcome.category),
                confidence: "likely".into(),
                summary: outcome
                    .layers
                    .iter()
                    .find(|l| l.result == LayerResult::Failed)
                    .map(|l| l.detail.clone().unwrap_or_default())
                    .unwrap_or_else(|| format!("{:?}", outcome.category)),
            });
        }
        if tripped {
            self.events.emit(Event::CircuitBreakerTripped {
                api_id: outcome.api_id.clone(),
            });
        }
    }

    /// Mark an upstream route as selected for an API.
    pub fn select_route(&self, api_id: &str, route_id: &str, reason: &str) {
        self.events.emit(Event::RouteSelected {
            api_id: api_id.to_string(),
            route_id: route_id.to_string(),
            reason: reason.to_string(),
        });
    }
}

impl Default for ApiRegistry {
    fn default() -> Self {
        Self::new(EventBus::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_lookup() {
        let bus = EventBus::default();
        let reg = ApiRegistry::new(bus);
        let entry = ApiEntry::new("xkiro", "xKiro", "https://api.xkiro.com/v1");
        assert!(reg.register(entry));
        // Duplicate id rejected.
        assert!(!reg.register(ApiEntry::new("xkiro", "x", "https://x")));
        assert!(reg.entry("xkiro").is_some());
        assert_eq!(reg.ids().len(), 1);
    }

    #[test]
    fn probe_emits_health_change() {
        let bus = EventBus::default();
        let reg = ApiRegistry::new(bus);
        reg.register(ApiEntry::new("api-1", "p", "https://a"));
        reg.record_probe(&ProbeOutcomeRecord {
            timestamp_ms: 1,
            api_id: "api-1".into(),
            health: Health::Healthy,
            category: FailureCategory::Healthy,
            route: RouteKind::Direct,
            layers: vec![],
            latency_ms: Some(40.0),
        });
        let st = reg.state("api-1").expect("state");
        assert_eq!(st.health, Health::Healthy);
        assert_eq!(st.consecutive_failures, 0);
    }

    #[test]
    fn failures_trip_breaker() {
        let bus = EventBus::default();
        let reg = ApiRegistry::new(bus);
        reg.register(ApiEntry::new("api-1", "p", "https://a"));
        // Lower threshold for test.
        // CircuitBreaker::new uses failure_threshold=5; record 5 failures.
        for i in 1..=5 {
            reg.record_probe(&ProbeOutcomeRecord {
                timestamp_ms: i,
                api_id: "api-1".into(),
                health: Health::Unhealthy,
                category: FailureCategory::TransportFailure,
                route: RouteKind::Direct,
                layers: vec![],
                latency_ms: None,
            });
        }
        let st = reg.state("api-1").expect("state");
        assert_eq!(st.consecutive_failures, 5);
        assert!(st.circuit_breaker.is_tripped());
    }
}
