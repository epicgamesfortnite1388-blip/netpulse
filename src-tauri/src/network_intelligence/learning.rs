//! NANI Phase 4 — Local learning engine.
//!
//! This is the integration point for the Phase 4 foundations. It is deliberately
//! small and deterministic: it consumes measurements produced by the live API
//! monitor, validates and normalizes them through the telemetry pipeline, keeps
//! per-context robust baselines, updates the hierarchical reliability model, and
//! records drift events.
//!
//! It owns no network I/O, no LLM, and no privileged operation. Every input is
//! an already-measured value; missing data is never converted into a failure.
//!
//! Privacy: the engine stores only numeric summaries, a local context id, and
//! short metric names. It never stores SSIDs, MAC addresses, private IPs, URLs,
//! credentials, or packet payloads.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};

use crate::network_intelligence::context::context_identity::{
    ContextSignals, NetworkContextId,
};
use crate::network_intelligence::context::engine::{
    NetworkProfileEngine, PersonalizationStatus, TransitionRecord,
};
use crate::network_intelligence::context::storage::{
    load_engine, profile_path, save_engine,
};
use crate::network_intelligence::episodes::{EpisodeMemory, NetworkEpisode};
use crate::network_intelligence::evidence::correlation::CorrelationModel;
use crate::network_intelligence::evidence::measurements::{Measurement, MeasureState};
use crate::network_intelligence::evidence::telemetry_pipeline::{
    run_pipeline, ResultsStore, TelemetryQueue,
};
use crate::network_intelligence::robust_stats::RobustStats;

/// Pipeline stages applied to every measurement before it can affect a model.
const INGEST_STAGES: &[&str] = &["COLLECT", "VALIDATE", "NORMALIZE"];

/// Anomaly score above which a value is recorded as a drift event.
const DRIFT_ANOMALY_THRESHOLD: f64 = 4.0;

/// Minimum samples before an anomaly can be called drift.
const DRIFT_MIN_SAMPLES: usize = 8;

/// Bounded drift history.
const MAX_DRIFT_EVENTS: usize = 64;

/// Metric names that represent a binary availability outcome.
const AVAILABILITY_METRICS: &[&str] = &["api_health", "availability"];

/// A recorded distribution shift.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DriftEvent {
    pub metric: String,
    pub at_ms: u64,
    pub anomaly_score: f64,
    /// +1 when the value is above the median, -1 when below.
    pub direction: i8,
}

/// Result of ingesting one measurement.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IngestOutcome {
    pub accepted: bool,
    pub state: String,
    pub drift_detected: bool,
    pub reason: Option<String>,
}

impl IngestOutcome {
    fn rejected(reason: impl Into<String>) -> Self {
        Self {
            accepted: false,
            state: "rejected".into(),
            drift_detected: false,
            reason: Some(reason.into()),
        }
    }
}

/// Snapshot for the UI / Tauri status command. Contains no raw measurements.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LearningStatus {
    pub measurements_accepted: u64,
    pub measurements_rejected: u64,
    pub contexts: usize,
    pub episodes: usize,
    pub drift_events: usize,
    /// Current global success prior mean (never a claim about any one API).
    pub global_reliability: f64,
    pub active_context: u64,
    pub last_rejection: Option<String>,
}

/// Local, private, bounded learning state.
pub struct LearningEngine {
    queue: TelemetryQueue,
    store: ResultsStore,
    personalization: NetworkProfileEngine,
    profile_path: Option<PathBuf>,
    state_path: Option<PathBuf>,
    storage_error: Option<String>,
    stats: HashMap<(u64, String), RobustStats>,
    episodes: EpisodeMemory,
    correlations: CorrelationModel,
    drift: VecDeque<DriftEvent>,
    accepted: u64,
    rejected: u64,
    last_rejection: Option<String>,
}

impl Default for LearningEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl LearningEngine {
    pub fn new() -> Self {
        Self {
            queue: TelemetryQueue::new("nani-phase4", 256),
            store: ResultsStore::new(),
            personalization: NetworkProfileEngine::new(),
            profile_path: None,
            state_path: None,
            storage_error: None,
            stats: HashMap::new(),
            episodes: EpisodeMemory::new(2_000),
            correlations: CorrelationModel::new(),
            drift: VecDeque::new(),
            accepted: 0,
            rejected: 0,
            last_rejection: None,
        }
    }

    /// Open local profiles and learning state from `data_dir`. Missing files
    /// start clean; corrupt or incompatible files are reported and also start
    /// clean rather than loading untrusted parameters.
    pub fn with_data_dir(data_dir: &Path) -> Self {
        let path = profile_path(data_dir);
        let state_path = data_dir.join("nani").join("learning_state.json");
        let mut engine = Self::new();
        match load_engine(&path) {
            Ok(Some(personalization)) => engine.personalization = personalization,
            Ok(None) => {}
            Err(err) => engine.storage_error = Some(err.to_string()),
        }
        match load_learning_state(&state_path) {
            Ok(Some(snapshot)) => {
                engine.accepted = snapshot.accepted;
                engine.rejected = snapshot.rejected;
                engine.last_rejection = snapshot.last_rejection;
                engine.stats = snapshot
                    .stats
                    .into_iter()
                    .map(|(ctx, metric, stats)| ((ctx, metric), stats))
                    .collect();
                engine.episodes = EpisodeMemory::from_snapshot(snapshot.episodes, 2_000);
                engine.drift = snapshot.drift.into();
                engine.store = ResultsStore::new();
                for measurement in snapshot.measurements {
                    engine.store.insert(measurement);
                }
            }
            Ok(None) => {}
            Err(err) => {
                if engine.storage_error.is_none() {
                    engine.storage_error = Some(err.to_string());
                }
            }
        }
        engine.profile_path = Some(path);
        engine.state_path = Some(state_path);
        engine
    }

    /// Select the active network context. Contexts are local random ids, never
    /// derived from SSIDs or hardware identifiers.
    pub fn set_context(&mut self, context: NetworkContextId) {
        self.personalization.set_active_context(context);
    }

    pub fn active_context(&self) -> NetworkContextId {
        self.personalization
            .active_context()
            .unwrap_or(NetworkContextId(0))
    }

    /// Observe privacy-safe network signals, creating or restoring a local
    /// profile. Returns the transition kind (`none`, `new`, `switch`).
    pub fn observe_network(&mut self, signals: &ContextSignals) -> String {
        let transition = self.personalization.observe_signals(signals);
        let changed = !matches!(
            transition,
            crate::network_intelligence::context::transitions::Transition::None
        );
        if changed {
            self.persist();
        }
        match transition {
            crate::network_intelligence::context::transitions::Transition::None => "none",
            crate::network_intelligence::context::transitions::Transition::NewContext(_) => "new",
            crate::network_intelligence::context::transitions::Transition::ContextSwitch(_) => "switch",
        }
        .to_string()
    }

    pub fn personalization_status(&self) -> PersonalizationStatus {
        self.personalization.status()
    }

    pub fn context_transitions(&self) -> Vec<TransitionRecord> {
        self.personalization.transitions()
    }

    pub fn profile_confidence(&self) -> f64 {
        self.personalization.status().active_profile_confidence
    }

    pub fn delete_context(&mut self, context: u64) -> bool {
        let removed = self
            .personalization
            .delete_context(NetworkContextId(context));
        if removed {
            self.persist();
        }
        removed
    }

    pub fn storage_error(&self) -> Option<String> {
        self.storage_error.clone()
    }

    fn persist(&mut self) {
        if let Some(path) = &self.profile_path {
            if let Err(err) = save_engine(path, &self.personalization) {
                self.storage_error = Some(err.to_string());
            }
        }
        if let Some(path) = &self.state_path {
            if let Err(err) = save_learning_state(
                path,
                self.accepted,
                self.rejected,
                self.last_rejection.clone(),
                &self.stats,
                &self.episodes,
                &self.drift,
                &self.store,
            ) {
                self.storage_error = Some(err.to_string());
            }
        }
    }

    /// Ingest one measurement through the bounded telemetry pipeline.
    ///
    /// Missing or invalid measurements are rejected (and counted); a failed but
    /// valid measurement is accepted and updates reliability as a failure.
    pub fn ingest(&mut self, measurement: Measurement, api_id: &str) -> IngestOutcome {
        if self.queue.push(measurement).is_err() {
            return self.reject("telemetry queue is cancelled");
        }
        let Some(input) = self.queue.pop() else {
            return self.reject("telemetry queue produced no item");
        };

        let stages = run_pipeline(INGEST_STAGES, &input);
        let Some(last) = stages.last() else {
            return self.reject("telemetry pipeline produced no stage result");
        };
        if let Some(err) = &last.error {
            return self.reject(err.clone());
        }

        let normalized = last.measurement.clone();
        if !normalized.valid {
            return self.reject("measurement is not usable evidence");
        }

        let at = normalized.timestamp;
        self.accepted += 1;
        self.last_rejection = None;
        self.store.insert(normalized.clone());

        let mut drift_detected = false;
        if normalized.state == MeasureState::Successful {
            if let Some(value) = normalized.observed_value {
                self.personalization
                    .record_metric(&normalized.kind, value, at);

                let key = (self.active_context().0, normalized.kind.clone());
                let mut pending_drift = None;
                {
                    let stats = self.stats.entry(key).or_insert_with(|| RobustStats::new(64));
                    if stats.len() >= DRIFT_MIN_SAMPLES {
                        if let Some(score) = stats.anomaly_score(value) {
                            if score >= DRIFT_ANOMALY_THRESHOLD {
                                let median = stats.median().unwrap_or(value);
                                pending_drift = Some(DriftEvent {
                                    metric: normalized.kind.clone(),
                                    at_ms: at,
                                    anomaly_score: score,
                                    direction: if value >= median { 1 } else { -1 },
                                });
                            }
                        }
                    }
                    stats.observe(value);
                }
                if let Some(event) = pending_drift {
                    self.record_drift(event);
                    drift_detected = true;
                }
            }
        }

        let success = match normalized.state {
            MeasureState::Successful => Some(true),
            MeasureState::Failed | MeasureState::TimedOut => Some(false),
            _ => None,
        };
        if AVAILABILITY_METRICS.contains(&normalized.kind.as_str()) {
            // Verified aggregate evidence belongs to the device-level parent
            // model only; do not also record it under the active child, which
            // would double-count the same observation.
            if normalized.provenance
                == crate::network_intelligence::evidence::measurements::Provenance::IndependentlyVerified
            {
                self.personalization.observe_verified_aggregate(api_id, success);
            } else {
                self.personalization.observe_outcome(api_id, success);
            }
        }
        // Persist both network profiles and the learning state. Measurements and
        // drift are durable even when no context is active; a missing context
        // never invents one, but it must not discard recorded evidence.
        self.persist();

        IngestOutcome {
            accepted: true,
            state: format!("{:?}", normalized.state),
            drift_detected,
            reason: None,
        }
    }

    /// Record one API health probe from the live monitor loop.
    ///
    /// This is the production path: `MonitorLoop` calls it after every probe.
    /// The binary outcome feeds the hierarchical reliability model; measured
    /// latency feeds the per-context robust baseline. No action is taken.
    pub fn record_api_probe(
        &mut self,
        api_id: &str,
        healthy: bool,
        latency_ms: Option<f64>,
        timestamp_ms: u64,
    ) -> IngestOutcome {
        let mut health = Measurement::new(
            format!("api_health:{api_id}:{timestamp_ms}"),
            timestamp_ms,
            "api_health",
            "api",
            self.active_context().0.to_string(),
            "monitor_loop",
        );
        health.provenance = crate::network_intelligence::evidence::measurements::Provenance::Direct;
        health.set_state(if healthy {
            MeasureState::Successful
        } else {
            MeasureState::Failed
        });
        health.set_value(if healthy { 1.0 } else { 0.0 });
        health.unit = Some("boolean".into());

        let outcome = self.ingest(health, api_id);

        if let Some(latency) = latency_ms {
            if latency.is_finite() && latency >= 0.0 {
                let mut m = Measurement::new(
                    format!("latency_ms:{api_id}:{timestamp_ms}"),
                    timestamp_ms,
                    "latency_ms",
                    "api",
                    self.active_context().0.to_string(),
                    "monitor_loop",
                );
                m.set_value(latency);
                m.unit = Some("ms".into());
                m.set_state(MeasureState::Successful);
                let _ = self.ingest(m, api_id);
            }
        }

        outcome
    }

    /// Record a correction supplied by the user. Corrections are separate from
    /// measured evidence and are never treated as a technical outcome.
    pub fn record_user_correction(&mut self, episode_id: &str, correction: &str) -> bool {
        // Corrections are attached to the episode record; they do not convert
        // an unverified outcome into a verified one.
        self.episodes.set_correction(episode_id, correction)
    }

    pub fn metric_median(&self, metric: &str) -> Option<f64> {
        self.personalization.metric_median(metric)
    }

    pub fn reliability(&self, api_id: &str) -> f64 {
        self.personalization.reliability(api_id)
    }

    /// Correlation-adjusted evidence weights for a chronological observation
    /// sequence, so callers do not double-count correlated probes.
    pub fn evidence_weights(&self, observations: &[(String, f64)]) -> Option<Vec<f64>> {
        self.correlations.adjusted_weights(observations)
    }

    pub fn status(&self) -> LearningStatus {
        LearningStatus {
            measurements_accepted: self.accepted,
            measurements_rejected: self.rejected,
            contexts: self.personalization.status().contexts,
            episodes: self.episodes.len(),
            drift_events: self.drift.len(),
            global_reliability: self.personalization.status().global_reliability,
            active_context: self.active_context().0,
            last_rejection: self.last_rejection.clone(),
        }
    }

    pub fn drift_events(&self) -> Vec<DriftEvent> {
        self.drift.iter().cloned().collect()
    }

    /// User-initiated: delete all per-context profiles and episodes. The global
    /// prior is retained so the system can keep working with conservative
    /// defaults, but no personal data remains.
    pub fn reset_personalization(&mut self) -> usize {
        let removed_episodes = self.episodes.clear();
        self.personalization.reset_personalization();
        self.stats.clear();
        self.drift.clear();
        self.persist();
        removed_episodes
    }

    fn record_drift(&mut self, event: DriftEvent) {
        if self.drift.len() >= MAX_DRIFT_EVENTS {
            self.drift.pop_front();
        }
        self.drift.push_back(event);
    }

    fn reject(&mut self, reason: impl Into<String>) -> IngestOutcome {
        self.rejected += 1;
        let reason = reason.into();
        self.last_rejection = Some(reason.clone());
        IngestOutcome::rejected(reason)
    }
}

/// Schema version for the persisted learning state.
const LEARNING_STATE_SCHEMA_VERSION: u32 = 1;

/// Maximum bytes accepted for a persisted learning state file.
const MAX_LEARNING_STATE_BYTES: u64 = 8 * 1024 * 1024;

/// A bounded, versioned snapshot of the learning engine's durable state.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LearningStateSnapshot {
    schema_version: u32,
    accepted: u64,
    rejected: u64,
    last_rejection: Option<String>,
    stats: Vec<(u64, String, RobustStats)>,
    episodes: Vec<NetworkEpisode>,
    drift: Vec<DriftEvent>,
    measurements: Vec<Measurement>,
}

#[derive(Debug, Clone)]
pub enum LearningStorageError {
    Io(String),
    Corrupt(String),
    UnsupportedVersion(u32),
}

impl std::fmt::Display for LearningStorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "learning storage I/O error: {e}"),
            Self::Corrupt(e) => write!(f, "learning storage is corrupt: {e}"),
            Self::UnsupportedVersion(v) => {
                write!(f, "unsupported learning storage schema version {v}")
            }
        }
    }
}

impl std::error::Error for LearningStorageError {}

/// Load a learning-state snapshot. A missing file is not an error.
fn load_learning_state(
    path: &Path,
) -> Result<Option<LearningStateSnapshot>, LearningStorageError> {
    if !path.exists() {
        return Ok(None);
    }
    let meta = std::fs::metadata(path)
        .map_err(|e| LearningStorageError::Io(e.to_string()))?;
    if meta.len() > MAX_LEARNING_STATE_BYTES {
        return Err(LearningStorageError::Corrupt(format!(
            "file exceeds {MAX_LEARNING_STATE_BYTES} bytes"
        )));
    }
    let data = std::fs::read_to_string(path)
        .map_err(|e| LearningStorageError::Io(e.to_string()))?;
    let mut value: serde_json::Value = serde_json::from_str(&data)
        .map_err(|e| LearningStorageError::Corrupt(e.to_string()))?;
    let version = value
        .get("schema_version")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    if version > LEARNING_STATE_SCHEMA_VERSION {
        return Err(LearningStorageError::UnsupportedVersion(version));
    }
    // Migration support: normalize older/missing versions to the current one.
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "schema_version".into(),
            serde_json::json!(LEARNING_STATE_SCHEMA_VERSION),
        );
    }
    let snapshot: LearningStateSnapshot = serde_json::from_value(value)
        .map_err(|e| LearningStorageError::Corrupt(e.to_string()))?;
    Ok(Some(snapshot))
}

/// Atomically save the learning-state snapshot.
fn save_learning_state(
    path: &Path,
    accepted: u64,
    rejected: u64,
    last_rejection: Option<String>,
    stats: &HashMap<(u64, String), RobustStats>,
    episodes: &EpisodeMemory,
    drift: &VecDeque<DriftEvent>,
    store: &ResultsStore,
) -> Result<(), LearningStorageError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| LearningStorageError::Io(e.to_string()))?;
    }
    let stats: Vec<(u64, String, RobustStats)> = stats
        .iter()
        .map(|((ctx, metric), value)| (*ctx, metric.clone(), value.clone()))
        .collect();
    let snapshot = LearningStateSnapshot {
        schema_version: LEARNING_STATE_SCHEMA_VERSION,
        accepted,
        rejected,
        last_rejection,
        stats,
        episodes: episodes.snapshot(),
        drift: drift.iter().cloned().collect(),
        measurements: store.iter_newest().cloned().collect(),
    };
    let json = serde_json::to_vec_pretty(&snapshot)
        .map_err(|e| LearningStorageError::Corrupt(e.to_string()))?;
    if json.len() as u64 > MAX_LEARNING_STATE_BYTES {
        return Err(LearningStorageError::Corrupt("snapshot exceeds size cap".into()));
    }
    let tmp = path.with_extension("json.tmp");
    let mut file = std::fs::File::create(&tmp)
        .map_err(|e| LearningStorageError::Io(e.to_string()))?;
    use std::io::Write;
    file.write_all(&json)
        .map_err(|e| LearningStorageError::Io(e.to_string()))?;
    file.sync_all()
        .map_err(|e| LearningStorageError::Io(e.to_string()))?;
    drop(file);
    std::fs::rename(&tmp, path).map_err(|e| LearningStorageError::Io(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn successful(kind: &str, value: f64, at: u64) -> Measurement {
        let mut m = Measurement::new(
            format!("{kind}:{at}"),
            at,
            kind,
            "network",
            "0",
            "test",
        );
        m.set_value(value);
        m.unit = Some(if kind.contains("latency") { "ms" } else { "ratio" }.into());
        m.set_state(MeasureState::Successful);
        m
    }

    #[test]
    fn latency_keeps_its_magnitude_in_the_profile() {
        let mut engine = LearningEngine::new();
        engine.observe_network(&ContextSignals {
            is_wifi: true,
            ..Default::default()
        });
        let out = engine.ingest(successful("latency_ms", 850.0, 1_000), "api-a");
        assert!(out.accepted, "{:?}", out.reason);
        let median = engine.metric_median("latency_ms").expect("profile recorded");
        assert_eq!(median, 850.0);
    }

    #[test]
    fn missing_measurements_are_rejected_and_never_counted_as_failure() {
        let mut engine = LearningEngine::new();
        let before = engine.reliability("api-a");
        let mut m = Measurement::missing("m-missing", 1_000, "latency_ms");
        m.valid = false;
        let out = engine.ingest(m, "api-a");
        assert!(!out.accepted);
        assert_eq!(engine.status().measurements_rejected, 1);
        assert!((engine.reliability("api-a") - before).abs() < 1e-12);
    }

    #[test]
    fn api_probe_updates_hierarchical_reliability() {
        let mut engine = LearningEngine::new();
        engine.observe_network(&ContextSignals {
            is_wifi: true,
            ..Default::default()
        });
        for i in 0..200 {
            engine.record_api_probe("api-a", true, Some(40.0), 1_000 + i);
        }
        assert!(engine.reliability("api-a") > 0.8);
        assert!(engine.reliability("api-b") < 0.8);
    }

    #[test]
    fn drift_is_detected_only_after_enough_samples() {
        let mut engine = LearningEngine::new();
        for i in 0..4 {
            engine.ingest(successful("latency_ms", 40.0, 1_000 + i), "api-a");
        }
        assert!(engine.drift_events().is_empty());
        for i in 0..10 {
            engine.ingest(successful("latency_ms", 40.0, 2_000 + i), "api-a");
        }
        let out = engine.ingest(successful("latency_ms", 5_000.0, 3_000), "api-a");
        assert!(out.drift_detected);
        assert_eq!(engine.drift_events().len(), 1);
    }

    #[test]
    fn reset_removes_personal_state_but_keeps_learning_available() {
        let mut engine = LearningEngine::new();
        engine.observe_network(&ContextSignals {
            is_wifi: true,
            ..Default::default()
        });
        engine.ingest(successful("latency_ms", 40.0, 1_000), "api-a");
        assert!(engine.status().contexts > 0);
        engine.reset_personalization();
        assert_eq!(engine.status().contexts, 0);
        assert_eq!(engine.status().episodes, 0);
        assert!(engine.status().drift_events == 0);
        // The engine still accepts new evidence after a reset; a fresh context
        // must be observed because personalization never invents one.
        engine.observe_network(&ContextSignals {
            is_wifi: true,
            ..Default::default()
        });
        assert!(engine.ingest(successful("latency_ms", 42.0, 2_000), "api-a").accepted);
    }

    #[test]
    fn learning_state_round_trips_measurements_episodes_and_drift() {
        use crate::network_intelligence::episodes::{EvidenceQuality, NetworkEpisode};
        use std::fs;
        let dir = std::env::temp_dir().join(format!(
            "nani-learning-state-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);

        let ctx;
        {
            let mut engine = LearningEngine::with_data_dir(&dir);
            engine.observe_network(&ContextSignals {
                is_wifi: true,
                ..Default::default()
            });
            ctx = engine.active_context();
            let out = engine.ingest(successful("latency_ms", 42.0, 1_000), "api-a");
            assert!(out.accepted);

            let mut ep = NetworkEpisode::new(ctx, 1_000, "dns failure".to_string());
            ep.verified = true;
            ep.quality = EvidenceQuality::Verified;
            engine.episodes.record(ep);

            engine.drift.push_back(DriftEvent {
                metric: "latency_ms".into(),
                at_ms: 1_000,
                anomaly_score: 5.0,
                direction: 1,
            });
            engine.persist();
        }

        let mut reopened = LearningEngine::with_data_dir(&dir);
        assert_eq!(reopened.status().measurements_accepted, 1);
        assert_eq!(reopened.status().episodes, 1);
        assert_eq!(reopened.drift_events().len(), 1);
        assert_eq!(reopened.status().contexts, 1);

        assert_eq!(reopened.reset_personalization(), 1);
        assert_eq!(reopened.status().episodes, 0);
        assert_eq!(reopened.status().drift_events, 0);
        reopened.persist();

        let after_reset = LearningEngine::with_data_dir(&dir);
        assert_eq!(after_reset.status().episodes, 0);
        assert_eq!(after_reset.status().drift_events, 0);
        assert_eq!(after_reset.status().contexts, 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn correlated_probes_do_not_count_as_independent_evidence() {
        let engine = LearningEngine::new();
        let weights = engine
            .evidence_weights(&[
                ("tcp-connect".into(), 1.0),
                ("tls-handshake".into(), 1.0),
                ("http-reachability".into(), 1.0),
            ])
            .expect("weights");
        assert_eq!(weights[0], 1.0);
        assert!(weights[1] < weights[0]);
        assert!(weights[2] < weights[1]);
    }
}
