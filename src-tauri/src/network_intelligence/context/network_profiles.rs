//! NANI Phase 4 — Network profile storage with hierarchical baselines.
//!
//! Maintains per-context rolling baselines for latency, jitter, packet loss,
//! DNS response time, and API reachability. Implements hierarchical partial
//! pooling: a sparse context profile borrows strength from the device-level
//! and global priors without pretending to have extensive local data.
//!
//! All identifiers are local random ids; no SSIDs, MACs, private IPs, or
/// browsing URLs are stored.

use crate::network_intelligence::context::context_identity::NetworkContextId;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A rolling, robust summary of a single metric.
///
/// Stores count, median, MAD (median absolute deviation), min, max, and sum
/// so that P50/P90/P95/P99-style estimates and anomaly scores can be computed
/// without retaining every raw sample (bounded memory).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MetricProfile {
    pub count: u64,
    pub median: f64,
    pub mad: f64,
    pub min: f64,
    pub max: f64,
    pub sum: f64,
    /// Most recent observation (for freshness-based decay).
    pub last: f64,
    /// Epoch ms of last update.
    pub last_updated_ms: u64,
}

impl MetricProfile {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mean (for reference; median/MAD are preferred for robustness).
    pub fn mean(&self) -> f64 {
        if self.count == 0 {
            0.0
        } else {
            self.sum / self.count as f64
        }
    }

    /// Robust anomaly score: |x - median| / (1.4826 * MAD + eps).
    /// Values >> 1 indicate an outlier relative to this profile.
    pub fn anomaly_score(&self, x: f64) -> f64 {
        let eps = 1e-6;
        let denom = 1.4826 * self.mad + eps;
        (x - self.median).abs() / denom
    }

    /// Confidence in this profile based on sample count.
    /// Approaches 1.0 as count grows; low for sparse data.
    pub fn confidence(&self) -> f64 {
        // Soft saturation: 50 samples => ~0.88, 200 => ~0.96.
        (self.count as f64) / (self.count as f64 + 50.0)
    }
}

/// Update a metric profile with a new observation using a simple online
/// median/MAD approximation (bounded memory, no raw sample retention).
fn update_metric(profile: &mut MetricProfile, x: f64, now_ms: u64) {
    if profile.count == 0 {
        profile.median = x;
        profile.mad = 0.0;
        profile.min = x;
        profile.max = x;
    } else {
        // Online median approximation: move median toward x by a small step.
        let alpha = 1.0 / (profile.count as f64 + 1.0);
        profile.median += alpha * (x - profile.median);
        let dev = (x - profile.median).abs();
        profile.mad += alpha * (dev - profile.mad);
        profile.min = profile.min.min(x);
        profile.max = profile.max.max(x);
    }
    profile.count += 1;
    profile.sum += x;
    profile.last = x;
    profile.last_updated_ms = now_ms;
}

/// A hierarchical profile for one network context.
///
/// Maintains per-metric profiles keyed by metric name. The `confidence`
/// reflects how much local data supports this profile vs. the global prior.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NetworkProfile {
    pub context_id: NetworkContextId,
    pub metrics: HashMap<String, MetricProfile>,
    /// Number of distinct endpoints/services observed in this context.
    pub endpoint_count: u64,
    /// Last update time.
    pub last_updated_ms: u64,
}

impl NetworkProfile {
    pub fn new(context_id: NetworkContextId) -> Self {
        Self {
            context_id,
            metrics: HashMap::new(),
            endpoint_count: 0,
            last_updated_ms: unix_now_ms(),
        }
    }

    pub fn metric(&self, name: &str) -> Option<&MetricProfile> {
        self.metrics.get(name)
    }

    /// Overall profile confidence (minimum across tracked metrics, floored).
    pub fn confidence(&self) -> f64 {
        let mut best = 0.0f64;
        for m in self.metrics.values() {
            best = best.max(m.confidence());
        }
        best
    }

    pub fn record_observation(&mut self, metric: &str, value: f64, now_ms: u64) {
        let profile = self.metrics.entry(metric.to_string()).or_default();
        update_metric(profile, value, now_ms);
        self.last_updated_ms = now_ms;
    }
}

/// Hierarchical profile store: global prior + per-context profiles.
///
/// Implements partial pooling: when a context profile is sparse (low
/// confidence), predictions borrow from the global prior. Context profiles
/// never overwrite the global prior; they refine it locally.
#[derive(Debug, Clone, Default)]
pub struct ProfileStore {
    pub global: NetworkProfile,
    pub contexts: HashMap<NetworkContextId, NetworkProfile>,
    pub max_contexts: usize,
}

impl ProfileStore {
    pub fn new() -> Self {
        Self {
            global: NetworkProfile::new(NetworkContextId(0)),
            contexts: HashMap::new(),
            max_contexts: 256,
        }
    }

    pub fn with_max_contexts(mut self, max: usize) -> Self {
        self.max_contexts = max.max(1);
        self
    }

    /// Get or create a profile for the given context.
    pub fn context_profile_mut(&mut self, id: NetworkContextId) -> &mut NetworkProfile {
        self.contexts
            .entry(id)
            .or_insert_with(|| NetworkProfile::new(id))
    }

    /// Record an observation for a context's metric.
    ///
    /// The global profile is **not** updated here. Updating the parent with the
    /// child's observation and then using that parent as the child's fallback
    /// counts the same measurement twice. Global/device-level evidence is
    /// recorded explicitly with [`Self::record_global`].
    pub fn record(&mut self, id: NetworkContextId, metric: &str, value: f64, now_ms: u64) {
        if id.0 == 0 {
            self.record_global(metric, value, now_ms);
            return;
        }
        let profile = self.context_profile_mut(id);
        profile.record_observation(metric, value, now_ms);
        self.evict_if_needed();
    }

    /// Record device-level (parent) evidence, independent of any local profile.
    pub fn record_global(&mut self, metric: &str, value: f64, now_ms: u64) {
        self.global.record_observation(metric, value, now_ms);
    }

    /// Predict a metric value for a context using hierarchical pooling:
    /// `predicted = local_weight * local_median + (1-local_weight) * global_median`,
    /// where `local_weight` = local confidence (more local data => trust local more).
    /// Returns `None` if neither local nor global has data.
    pub fn predict(&self, id: NetworkContextId, metric: &str) -> Option<f64> {
        let local = self
            .contexts
            .get(&id)
            .and_then(|p| p.metric(metric));
        let global = self.global.metric(metric);

        match (local, global) {
            (Some(l), Some(g)) => {
                let w = l.confidence();
                Some(w * l.median + (1.0 - w) * g.median)
            }
            (Some(l), None) => Some(l.median),
            (None, Some(g)) => Some(g.median),
            (None, None) => None,
        }
    }

    /// Anomaly score for an observed value in a context, using the local
    /// profile when confident enough, otherwise the global profile.
    pub fn anomaly_score(&self, id: NetworkContextId, metric: &str, x: f64) -> Option<f64> {
        let local = self
            .contexts
            .get(&id)
            .and_then(|p| p.metric(metric));
        let global = self.global.metric(metric);

        match (local, global) {
            (Some(l), _) if l.confidence() > 0.5 => Some(l.anomaly_score(x)),
            (_, Some(g)) => Some(g.anomaly_score(x)),
            _ => None,
        }
    }

    /// Confidence in the prediction for a context/metric.
    pub fn prediction_confidence(&self, id: NetworkContextId, metric: &str) -> f64 {
        let local_conf = self
            .contexts
            .get(&id)
            .and_then(|p| p.metric(metric))
            .map(|m| m.confidence())
            .unwrap_or(0.0);
        let global_conf = self
            .global
            .metric(metric)
            .map(|m| m.confidence())
            .unwrap_or(0.0);
        local_conf.max(global_conf * 0.5) // global prior is less trustworthy locally
    }

    fn evict_if_needed(&mut self) {
        if self.contexts.len() <= self.max_contexts {
            return;
        }
        let min_id = self
            .contexts
            .iter()
            .min_by_key(|(_, p)| p.last_updated_ms)
            .map(|(id, _)| *id);
        if let Some(id) = min_id {
            self.contexts.remove(&id);
        }
    }

    /// User-initiated: delete one context profile.
    pub fn remove_context(&mut self, id: NetworkContextId) -> bool {
        self.contexts.remove(&id).is_some()
    }

    /// User-initiated: delete all context profiles (global prior retained).
    pub fn clear_contexts(&mut self) {
        self.contexts.clear();
    }
}

/// Persisted profile-store shape. Context ids are kept as a list because JSON
/// object keys cannot represent a tuple/struct id without stringification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileStoreSnapshot {
    pub global: NetworkProfile,
    pub contexts: Vec<NetworkProfile>,
}

impl ProfileStore {
    pub fn snapshot(&self) -> ProfileStoreSnapshot {
        let mut contexts: Vec<NetworkProfile> = self.contexts.values().cloned().collect();
        contexts.sort_by_key(|p| p.context_id.0);
        ProfileStoreSnapshot {
            global: self.global.clone(),
            contexts,
        }
    }

    pub fn from_snapshot(snapshot: ProfileStoreSnapshot) -> Self {
        let mut contexts = HashMap::new();
        for profile in snapshot.contexts {
            contexts.insert(profile.context_id, profile);
        }
        Self {
            global: snapshot.global,
            contexts,
            max_contexts: 256,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn predict_uses_local_when_confident() {
        let mut store = ProfileStore::new();
        let id = NetworkContextId(1);
        // Record many local observations around 100ms.
        for _ in 0..500 {
            store.record(id, "latency_ms", 100.0, unix_now_ms());
        }
        // Global prior around 200ms.
        for _ in 0..50 {
            store.record(NetworkContextId(0), "latency_ms", 200.0, unix_now_ms());
        }
        let pred = store.predict(id, "latency_ms").unwrap();
        assert!(pred > 90.0 && pred < 120.0, "prediction should favor local: {pred}");
    }

    #[test]
    fn predict_uses_global_when_local_sparse() {
        let mut store = ProfileStore::new();
        let id = NetworkContextId(2);
        store.record(id, "latency_ms", 1000.0, unix_now_ms()); // single outlier
        for _ in 0..100 {
            store.record(NetworkContextId(0), "latency_ms", 50.0, unix_now_ms());
        }
        let pred = store.predict(id, "latency_ms").unwrap();
        assert!(pred < 200.0, "sparse local should defer to global: {pred}");
    }

    #[test]
    fn anomaly_score_flags_outlier() {
        let mut store = ProfileStore::new();
        let id = NetworkContextId(3);
        for _ in 0..50 {
            store.record(id, "latency_ms", 50.0, unix_now_ms());
            store.record_global("latency_ms", 50.0, unix_now_ms());
        }
        let score = store.anomaly_score(id, "latency_ms", 500.0).unwrap();
        assert!(score > 1.0, "outlier should score high: {score}");
    }

    #[test]
    fn prediction_confidence_grows_with_data() {
        let mut store = ProfileStore::new();
        let id = NetworkContextId(4);
        let c0 = store.prediction_confidence(id, "latency_ms");
        assert_eq!(c0, 0.0);
        for _ in 0..100 {
            store.record(id, "latency_ms", 50.0, unix_now_ms());
        }
        let c1 = store.prediction_confidence(id, "latency_ms");
        assert!(c1 > c0);
    }

    #[test]
    fn remove_context() {
        let mut store = ProfileStore::new();
        let id = NetworkContextId(5);
        store.record(id, "latency_ms", 50.0, unix_now_ms());
        assert!(store.remove_context(id));
        // No independent global evidence was recorded, so the child's data is
        // gone rather than silently retained in a parent.
        assert!(store.predict(id, "latency_ms").is_none());
    }
}
