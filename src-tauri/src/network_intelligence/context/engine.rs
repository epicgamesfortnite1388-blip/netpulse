//! NANI Phase 4B — Network personalization engine.
//!
//! Ties together the context tracker, per-context robust baselines, and the
//! hierarchical reliability model. It is deliberately the only component that
//! decides which local profile an observation belongs to.
//!
//! Invariants:
//!   - An observation is recorded only under the currently active context.
//!   - A missing context or a non-finite metric is rejected, never stored as 0.
//!   - Local observations update only the local model; the parent is updated
//!     only through explicit device-level evidence.
//!   - Transitions retain old profiles instead of deleting knowledge.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::network_intelligence::context::context_identity::{
    ContextSignals, NetworkContext, NetworkContextId,
};
use crate::network_intelligence::context::network_profiles::{
    ProfileStore, ProfileStoreSnapshot,
};
use crate::network_intelligence::context::transitions::{
    ContextTransitionTracker, Transition,
};
use crate::network_intelligence::hierarchical::{
    BetaPosterior, HierarchicalBetaBernoulli, HierarchicalSnapshot,
};

/// Schema version for the personalization snapshot.
pub const PROFILE_SCHEMA_VERSION: u32 = 1;

const MAX_TRANSITIONS: usize = 64;

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One observed network transition, kept for the Learning Center UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransitionRecord {
    pub from: Option<u64>,
    pub to: u64,
    /// `new` or `switch`.
    pub kind: String,
    pub at_ms: u64,
}

/// Bounded, privacy-safe status for IPC/UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PersonalizationStatus {
    pub schema_version: u32,
    pub active_context: Option<u64>,
    pub contexts: usize,
    pub transitions: usize,
    pub global_reliability: f64,
    /// Confidence of the active profile's strongest local metric (0..1).
    pub active_profile_confidence: f64,
    pub tracked_metrics: usize,
    pub reliability_pairs: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileEngineSnapshot {
    pub schema_version: u32,
    pub current: Option<u64>,
    pub contexts: Vec<NetworkContext>,
    pub last_signal_ms: u64,
    pub transitions: Vec<TransitionRecord>,
    pub profiles: ProfileStoreSnapshot,
    pub reliability: HierarchicalSnapshot,
}

/// Network personalization engine.
#[derive(Debug, Clone)]
pub struct NetworkProfileEngine {
    tracker: ContextTransitionTracker,
    profiles: ProfileStore,
    reliability: HierarchicalBetaBernoulli,
    transitions: VecDeque<TransitionRecord>,
}

impl Default for NetworkProfileEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl NetworkProfileEngine {
    pub fn new() -> Self {
        Self {
            tracker: ContextTransitionTracker::new(),
            profiles: ProfileStore::new(),
            reliability: HierarchicalBetaBernoulli::uniform(),
            transitions: VecDeque::new(),
        }
    }

    /// Observe non-identifying network signals. Returns the detected transition
    /// and updates the active context. A transition is not a failure.
    pub fn observe_signals(&mut self, signals: &ContextSignals) -> Transition {
        let from = self.tracker.current();
        let transition = self.tracker.evaluate(signals);
        if let Some(to) = self.tracker.current() {
            match transition {
                Transition::NewContext(_) => {
                    self.record_transition(from, to, "new");
                }
                Transition::ContextSwitch(_) => {
                    self.record_transition(from, to, "switch");
                }
                Transition::None => {}
            }
        }
        transition
    }

    fn record_transition(&mut self, from: Option<NetworkContextId>, to: NetworkContextId, kind: &str) {
        if self.transitions.len() >= MAX_TRANSITIONS {
            self.transitions.pop_front();
        }
        self.transitions.push_back(TransitionRecord {
            from: from.map(|id| id.0),
            to: to.0,
            kind: kind.to_string(),
            at_ms: unix_now_ms(),
        });
    }

    pub fn active_context(&self) -> Option<NetworkContextId> {
        self.tracker.current()
    }

    /// Set the active context without inventing a new network fingerprint.
    pub fn set_active_context(&mut self, id: NetworkContextId) {
        self.tracker.set_current(Some(id));
    }

    /// Record a validated metric under the active context. Returns false when
    /// no context is active or the value is missing/not a finite non-negative
    /// number. It is never coerced to zero.
    pub fn record_metric(&mut self, metric: &str, value: f64, now_ms: u64) -> bool {
        if !value.is_finite() || value < 0.0 || metric.trim().is_empty() {
            return false;
        }
        let Some(context) = self.active_context() else {
            return false;
        };
        self.profiles.record(context, metric, value, now_ms);
        true
    }

    /// Record device-level baseline evidence, independent of local contexts.
    pub fn record_global_metric(&mut self, metric: &str, value: f64, now_ms: u64) -> bool {
        if !value.is_finite() || value < 0.0 || metric.trim().is_empty() {
            return false;
        }
        self.profiles.record_global(metric, value, now_ms);
        true
    }

    /// Record a binary success/failure for an API under the active context.
    /// `None` is a missing observation and does nothing.
    pub fn observe_outcome(&mut self, api_id: &str, success: Option<bool>) -> bool {
        if success.is_none() {
            return false;
        }
        let Some(context) = self.active_context() else {
            return false;
        };
        self.reliability.observe(context, api_id, success);
        true
    }

    /// Wire verified aggregate evidence into the hierarchical *parent* model only.
    ///
    /// Aggregate evidence (e.g. an independently verified outcome over many
    /// probes) is device-level evidence: it updates the global parent exactly
    /// once and never touches the per-(context, api) child, so child
    /// observations are not counted a second time.
    pub fn observe_verified_aggregate(&mut self, api_id: &str, success: Option<bool>) -> bool {
        let _ = api_id;
        if success.is_none() {
            return false;
        }
        self.reliability.observe_global(success);
        true
    }

    pub fn reliability(&self, api_id: &str) -> f64 {
        match self.active_context() {
            Some(context) => self.reliability.predict(context, api_id),
            None => self.reliability.global_mean(),
        }
    }

    pub fn posterior(&self, api_id: &str, level: f64) -> Option<BetaPosterior> {
        self.active_context()
            .map(|context| self.reliability.posterior(context, api_id, level))
    }

    pub fn predict_metric(&self, metric: &str) -> Option<f64> {
        self.active_context()
            .and_then(|context| self.profiles.predict(context, metric))
    }

    /// Local median for the active profile (no parent blend). Used by tests and
    /// the Evidence Inspector; `None` means no local observations.
    pub fn metric_median(&self, metric: &str) -> Option<f64> {
        self.active_context()
            .and_then(|context| self.profiles.contexts.get(&context))
            .and_then(|profile| profile.metric(metric))
            .map(|m| m.median)
    }

    pub fn status(&self) -> PersonalizationStatus {
        let active = self.active_context();
        let active_profile_confidence = active
            .and_then(|id| self.profiles.contexts.get(&id))
            .map(|p| p.confidence())
            .unwrap_or(0.0);
        let tracked_metrics = active
            .and_then(|id| self.profiles.contexts.get(&id))
            .map(|p| p.metrics.len())
            .unwrap_or(0);
        PersonalizationStatus {
            schema_version: PROFILE_SCHEMA_VERSION,
            active_context: active.map(|id| id.0),
            contexts: self.profiles.contexts.len(),
            transitions: self.transitions.len(),
            global_reliability: self.reliability.global_mean(),
            active_profile_confidence,
            tracked_metrics,
            reliability_pairs: self.reliability.n_locals(),
        }
    }

    pub fn transitions(&self) -> Vec<TransitionRecord> {
        self.transitions.iter().cloned().collect()
    }

    /// Delete one local profile. Its context is forgotten so returning to that
    /// network creates a fresh, sparse profile.
    pub fn delete_context(&mut self, id: NetworkContextId) -> bool {
        let removed = self.profiles.remove_context(id);
        self.tracker.identity_mut().remove(id);
        if self.tracker.current() == Some(id) {
            self.tracker.reset();
        }
        removed
    }

    /// Delete all local personalization. The global prior is retained.
    pub fn reset_personalization(&mut self) -> usize {
        let removed = self.profiles.contexts.len();
        self.profiles.clear_contexts();
        self.tracker.reset();
        self.transitions.clear();
        self.reliability = HierarchicalBetaBernoulli::uniform();
        removed
    }

    /// Versioned snapshot for atomic local storage.
    pub fn snapshot(&self) -> ProfileEngineSnapshot {
        let (current, contexts, last_signal_ms) = self.tracker.export_parts();
        ProfileEngineSnapshot {
            schema_version: PROFILE_SCHEMA_VERSION,
            current: current.map(|id| id.0),
            contexts,
            last_signal_ms,
            transitions: self.transitions.iter().cloned().collect(),
            profiles: self.profiles.snapshot(),
            reliability: self.reliability.snapshot(),
        }
    }

    /// Restore a snapshot. A schema mismatch or corrupt model returns `None`
    /// so callers can start clean rather than trusting invalid parameters.
    pub fn from_snapshot(snapshot: ProfileEngineSnapshot) -> Option<Self> {
        if snapshot.schema_version != PROFILE_SCHEMA_VERSION {
            return None;
        }
        let reliability = HierarchicalBetaBernoulli::from_snapshot(&snapshot.reliability)?;
        let current = snapshot.current.map(NetworkContextId);
        let tracker = ContextTransitionTracker::from_parts(
            current,
            snapshot.contexts,
            snapshot.last_signal_ms,
        );
        let mut transitions = VecDeque::new();
        for record in snapshot.transitions.into_iter().take(MAX_TRANSITIONS) {
            transitions.push_back(record);
        }
        Some(Self {
            tracker,
            profiles: ProfileStore::from_snapshot(snapshot.profiles),
            reliability,
            transitions,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wifi() -> ContextSignals {
        ContextSignals {
            is_wifi: true,
            gateway_class: Some("home".into()),
            resolver_class: Some("local".into()),
            ..Default::default()
        }
    }

    fn ethernet() -> ContextSignals {
        ContextSignals {
            is_ethernet: true,
            gateway_class: Some("office".into()),
            resolver_class: Some("public".into()),
            ..Default::default()
        }
    }

    #[test]
    fn new_context_is_created_and_metric_recorded() {
        let mut engine = NetworkProfileEngine::new();
        engine.observe_signals(&wifi());
        assert!(engine.active_context().is_some());
        assert!(engine.record_metric("latency_ms", 42.0, 1_000));
        assert_eq!(engine.status().tracked_metrics, 1);
        assert_eq!(engine.status().contexts, 1);
    }

    #[test]
    fn missing_context_rejects_metrics_instead_of_using_zero_context() {
        let mut engine = NetworkProfileEngine::new();
        assert!(!engine.record_metric("latency_ms", 10.0, 1_000));
        assert_eq!(engine.status().contexts, 0);
    }

    #[test]
    fn invalid_values_are_rejected() {
        let mut engine = NetworkProfileEngine::new();
        engine.observe_signals(&wifi());
        assert!(!engine.record_metric("latency_ms", f64::NAN, 1));
        assert!(!engine.record_metric("latency_ms", -1.0, 1));
        assert!(!engine.record_metric("", 1.0, 1));
    }

    #[test]
    fn contexts_are_isolated() {
        let mut engine = NetworkProfileEngine::new();
        engine.observe_signals(&wifi());
        let wifi_id = engine.active_context().unwrap();
        for i in 0..50 {
            engine.record_metric("latency_ms", 30.0, 1_000 + i);
            engine.observe_outcome("api", Some(true));
        }
        engine.observe_signals(&ethernet());
        let eth_id = engine.active_context().unwrap();
        assert_ne!(wifi_id, eth_id);
        for i in 0..5 {
            engine.record_metric("latency_ms", 300.0, 2_000 + i);
            engine.observe_outcome("api", Some(false));
        }
        assert!(engine.status().contexts == 2);
        // Ethernet is sparse and must not inherit Wi-Fi's 50 successes.
        assert!(engine.reliability("api") < 0.7);
        assert!(engine.predict_metric("latency_ms").unwrap() > 250.0);
    }

    #[test]
    fn transition_keeps_previous_profile() {
        let mut engine = NetworkProfileEngine::new();
        engine.observe_signals(&wifi());
        engine.record_metric("latency_ms", 30.0, 1_000);
        let first = engine.active_context().unwrap();
        engine.observe_signals(&ethernet());
        engine.record_metric("latency_ms", 80.0, 1_100);
        // Return to Wi-Fi: old profile is still there.
        let transition = engine.observe_signals(&wifi());
        assert_eq!(engine.active_context(), Some(first));
        assert!(matches!(transition, Transition::ContextSwitch(_)));
        assert_eq!(engine.status().contexts, 2);
    }

    #[test]
    fn no_observation_is_not_a_failure() {
        let mut engine = NetworkProfileEngine::new();
        engine.observe_signals(&wifi());
        let before = engine.reliability("api");
        assert!(!engine.observe_outcome("api", None));
        assert_eq!(engine.reliability("api"), before);
    }

    #[test]
    fn reset_removes_local_state_but_keeps_engine_usable() {
        let mut engine = NetworkProfileEngine::new();
        engine.observe_signals(&wifi());
        engine.record_metric("latency_ms", 30.0, 1_000);
        engine.observe_outcome("api", Some(true));
        assert_eq!(engine.reset_personalization(), 1);
        assert_eq!(engine.status().contexts, 0);
        engine.observe_signals(&wifi());
        assert!(engine.record_metric("latency_ms", 31.0, 2_000));
    }

    #[test]
    fn delete_context_removes_only_that_profile() {
        let mut engine = NetworkProfileEngine::new();
        engine.observe_signals(&wifi());
        engine.record_metric("latency_ms", 30.0, 1_000);
        let wifi_id = engine.active_context().unwrap();
        engine.observe_signals(&ethernet());
        engine.record_metric("latency_ms", 80.0, 1_100);
        let eth_id = engine.active_context().unwrap();
        assert!(engine.delete_context(wifi_id));
        assert_eq!(engine.active_context(), Some(eth_id));
        assert_eq!(engine.status().contexts, 1);
        assert!(!engine.delete_context(wifi_id));
    }

    #[test]
    fn network_transitions_select_isolated_profiles() {
        let mut engine = NetworkProfileEngine::new();

        let mut ethernet = ContextSignals {
            is_ethernet: true,
            gateway_class: Some("office".into()),
            resolver_class: Some("public".into()),
            mtu: Some(1500),
            ..Default::default()
        };
        let mut wifi = ContextSignals {
            is_wifi: true,
            gateway_class: Some("home".into()),
            resolver_class: Some("local".into()),
            mtu: Some(1500),
            ..Default::default()
        };
        let mut vpn = ContextSignals {
            is_vpn_tunnel: true,
            gateway_class: Some("vpn".into()),
            resolver_class: Some("vpn".into()),
            mtu: Some(1400),
            ..Default::default()
        };
        let mut mobile = ContextSignals {
            is_mobile_hotspot: true,
            gateway_class: Some("mobile".into()),
            resolver_class: Some("mobile".into()),
            mtu: Some(1400),
            ..Default::default()
        };

        engine.observe_signals(&ethernet);
        assert!(engine.record_metric("latency_ms", 100.0, 1));
        let ethernet_context = engine.active_context().expect("ethernet context");

        engine.observe_signals(&wifi);
        assert!(engine.record_metric("latency_ms", 20.0, 2));
        let wifi_context = engine.active_context().expect("wifi context");
        assert_ne!(wifi_context, ethernet_context);

        engine.observe_signals(&vpn);
        assert!(engine.record_metric("latency_ms", 50.0, 3));
        let vpn_context = engine.active_context().expect("vpn context");
        assert_ne!(vpn_context, wifi_context);
        assert_ne!(vpn_context, ethernet_context);

        engine.observe_signals(&mobile);
        assert!(engine.record_metric("latency_ms", 300.0, 4));
        let mobile_context = engine.active_context().expect("mobile context");
        assert_ne!(mobile_context, vpn_context);
        assert_ne!(mobile_context, wifi_context);
        assert_ne!(mobile_context, ethernet_context);

        assert_eq!(engine.status().contexts, 4);

        // Returning to an earlier network restores its own profile rather than
        // inheriting another interface type's measurements.
        engine.observe_signals(&wifi);
        assert_eq!(engine.metric_median("latency_ms"), Some(20.0));
        engine.observe_signals(&ethernet);
        assert_eq!(engine.metric_median("latency_ms"), Some(100.0));
        engine.observe_signals(&vpn);
        assert_eq!(engine.metric_median("latency_ms"), Some(50.0));
        engine.observe_signals(&mobile);
        assert_eq!(engine.metric_median("latency_ms"), Some(300.0));

        // Keep the variables visibly used so the test documents the signals.
        let _ = (&mut ethernet, &mut wifi, &mut vpn, &mut mobile);
    }

    #[test]
    fn snapshot_round_trip_preserves_contexts_and_posteriors() {
        let mut engine = NetworkProfileEngine::new();
        engine.observe_signals(&wifi());
        for i in 0..20 {
            engine.record_metric("latency_ms", 30.0, 1_000 + i);
            engine.observe_outcome("api", Some(i < 15));
        }
        let reliability = engine.reliability("api");
        let snapshot = engine.snapshot();
        let restored = NetworkProfileEngine::from_snapshot(snapshot).expect("valid snapshot");
        assert_eq!(restored.active_context(), engine.active_context());
        assert_eq!(restored.status().contexts, 1);
        assert!((restored.reliability("api") - reliability).abs() < 1e-12);
    }

    #[test]
    fn corrupt_snapshot_is_rejected() {
        let mut engine = NetworkProfileEngine::new();
        engine.observe_signals(&wifi());
        let mut snapshot = engine.snapshot();
        snapshot.schema_version = 999;
        assert!(NetworkProfileEngine::from_snapshot(snapshot).is_none());

        let mut bad = engine.snapshot();
        bad.reliability.kappa = f64::NAN;
        assert!(NetworkProfileEngine::from_snapshot(bad).is_none());
    }
}
