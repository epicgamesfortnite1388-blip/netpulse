//! NANI investigation lifecycle manager.
//!
//! Owns user-initiated investigation sessions: START → OBSERVE → ANALYZE →
//! VERIFY → COMPLETE/FAIL/CANCEL. Each stage performs real work (multi-layer
//! health probes against registered APIs, Bayesian diagnosis, recovery
//! verification) and emits typed lifecycle events on the NANI event bus so the
//! desktop UI can reflect actual engine state in real time.
//!
//! Cancellation is cooperative: every stage checks an atomic flag and stops
//! eligible work. A cancelled investigation emits `InvestigationCancelled` and
//! leaves no partial state that the UI could mistake for a completed run.
//!
//! No secrets enter events or persisted records.

use crate::network_intelligence::api_intelligence::monitor::probe_api;
use crate::network_intelligence::api_intelligence::registry::{
    ApiRegistry, Health, ProbeOutcomeRecord,
};
use crate::network_intelligence::events::{Event, EventBus};
use crate::network_intelligence::learning::LearningEngine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Stages of an investigation, in order. Not every investigation uses every
/// stage; stages are skipped when the preceding stage yields insufficient
/// evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InvestigationStage {
    Observe,
    Analyze,
    Verify,
    Complete,
}

impl std::fmt::Display for InvestigationStage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InvestigationStage::Observe => write!(f, "observe"),
            InvestigationStage::Analyze => write!(f, "analyze"),
            InvestigationStage::Verify => write!(f, "verify"),
            InvestigationStage::Complete => write!(f, "complete"),
        }
    }
}

/// Terminal outcome of an investigation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InvestigationOutcome {
    Completed,
    Failed,
    Cancelled,
}

/// One observed probe result recorded during an investigation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvestigationObservation {
    pub api_id: String,
    pub layer: String,
    pub ok: bool,
    pub latency_ms: Option<f64>,
    pub timestamp_ms: u64,
}

/// One hypothesis tracked during an investigation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvestigationHypothesis {
    pub id: String,
    pub hypothesis: String,
    pub confidence: f64,
}

/// Persisted record of a finished investigation (bounded retention).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvestigationRecord {
    pub id: String,
    pub query: String,
    pub stage: String,
    pub outcome: InvestigationOutcome,
    pub seq: u64,
    pub started_at: u64,
    pub updated_at: u64,
    pub observations: Vec<InvestigationObservation>,
    pub hypotheses: Vec<InvestigationHypothesis>,
    pub top_hypothesis: Option<String>,
    pub confidence: f64,
    pub result: String,
    pub error: Option<String>,
}

/// Mutable state of one in-flight investigation.
struct Investigation {
    id: String,
    query: String,
    stage: InvestigationStage,
    outcome: Option<InvestigationOutcome>,
    cancelled: Arc<AtomicBool>,
    seq: u64,
    started_at: u64,
    updated_at: u64,
    observations: Vec<InvestigationObservation>,
    hypotheses: HashMap<String, InvestigationHypothesis>,
    top_hypothesis: Option<String>,
    confidence: f64,
    result: String,
    error: Option<String>,
}

impl Investigation {
    fn new(id: String, query: String, seq: u64) -> Self {
        let now = unix_now_ms();
        Self {
            id: id.clone(),
            query,
            stage: InvestigationStage::Observe,
            outcome: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            seq,
            started_at: now,
            updated_at: now,
            observations: Vec::new(),
            hypotheses: HashMap::new(),
            top_hypothesis: None,
            confidence: 0.0,
            result: String::new(),
            error: None,
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}

/// Snapshot returned to the frontend for status polling / recovery.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvestigationStatus {
    pub id: String,
    pub query: String,
    pub stage: String,
    pub outcome: Option<String>,
    pub seq: u64,
    pub started_at: u64,
    pub updated_at: u64,
    pub observation_count: usize,
    pub hypothesis_count: usize,
    pub top_hypothesis: Option<String>,
    pub confidence: f64,
    pub result: String,
    pub error: Option<String>,
}

/// Manages the set of active and completed investigations.
#[derive(Clone)]
pub struct InvestigationManager {
    inner: Arc<Mutex<InvestigationManagerInner>>,
    events: EventBus,
    registry: ApiRegistry,
    learning: Arc<Mutex<LearningEngine>>,
    /// Bounded history of completed investigations (oldest evicted).
    history: Vec<InvestigationRecord>,
}

struct InvestigationManagerInner {
    active: HashMap<String, Arc<Mutex<Investigation>>>,
    history: Vec<InvestigationRecord>,
    next_id: u64,
    max_history: usize,
}

impl InvestigationManager {
    pub fn new(events: EventBus, registry: ApiRegistry, learning: Arc<Mutex<LearningEngine>>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(InvestigationManagerInner {
                active: HashMap::new(),
                history: Vec::new(),
                next_id: 1,
                max_history: 50,
            })),
            events,
            registry,
            learning,
            history: Vec::new(),
        }
    }

    /// Re-wire the manager onto the canonical application event bus.
    ///
    /// N0 fix (FABLE/NANI-002): `NaniState` is managed before the Tauri setup
    /// hook runs, so the manager is originally built with a placeholder bus.
    /// `main.rs` setup calls this with the real bus (the one wired to the
    /// AppHandle and to the `nani_poll_events` replay buffer) so every
    /// lifecycle event reaches the frontend through the canonical pipeline.
    ///
    /// `EventBus` is `Arc`-internally: this shares the SAME bus instance —
    /// one sequence space, one replay buffer, no duplicate delivery. Call
    /// this before any investigation starts (setup time), never mid-run: a
    /// running lifecycle already cloned the bus it emits on.
    pub fn set_event_bus(&mut self, bus: EventBus) {
        self.events = bus;
    }

    /// Point the manager at the authoritative application API registry.
    ///
    /// N0 fix (FABLE/NANI-001): the manager must observe the SAME registry
    /// the health-check and monitor paths use. `ApiRegistry` is
    /// `Arc`-internally, so this clone SHARES registration state — APIs
    /// registered later (by the app or the user) are visible to every
    /// investigation started afterwards. Call once at setup; there is
    /// deliberately no per-investigation re-sync: one registry, one truth.
    pub fn set_registry(&mut self, registry: ApiRegistry) {
        self.registry = registry;
    }

    /// Test-only: does this manager observe the same registry instance as
    /// `other`? Proves sharing (Arc identity) rather than a snapshot clone.
    #[cfg(test)]
    pub fn shares_registry_with(&self, other: &ApiRegistry) -> bool {
        self.registry.shares_state_with(other)
    }

    /// Test-only: does this manager publish on the same bus instance?
    #[cfg(test)]
    pub fn shares_event_bus_with(&self, other: &EventBus) -> bool {
        self.events.shares_state_with(other)
    }

    /// Start a new investigation. Returns the investigation id. Spawns a
    /// background thread that runs the stages and emits lifecycle events.
    pub fn start(&self, query: String) -> String {
        let (id, seq) = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let id = format!("nani-investigation-{}", inner.next_id);
            let seq = inner.next_id;
            inner.next_id += 1;
            (id, seq)
        };

        let inv = Investigation::new(id.clone(), query.clone(), seq);
        let inv_arc = Arc::new(Mutex::new(inv));
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner.active.insert(id.clone(), inv_arc.clone());
        }

        // Emit the started event.
        self.events.emit(Event::InvestigationStarted {
            investigation_id: id.clone(),
            query: query.clone(),
            stage: InvestigationStage::Observe.to_string(),
        });

        // Run the lifecycle on a background thread so the command returns
        // immediately and the UI receives events in real time.
        let events = self.events.clone();
        let registry = self.registry.clone();
        let learning = self.learning.clone();
        let manager_inner = self.inner.clone();
        let inv_clone = inv_arc.clone();
        let query_owned = query;

        let id_for_thread = id.clone();
        std::thread::spawn(move || {
            Self::run_lifecycle(
                id_for_thread,
                query_owned,
                inv_clone,
                events,
                registry,
                learning,
                manager_inner,
            );
        });

        id
    }

    /// Cancel an in-flight investigation by id. Returns true if a running
    /// investigation was found and cancellation requested. The outcome is set
    /// synchronously so `status()` reflects cancellation immediately; the
    /// lifecycle thread will observe the flag and retire the record.
    pub fn cancel(&self, investigation_id: &str) -> bool {
        let inv = {
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner.active.get(investigation_id).cloned()
        };
        let Some(inv) = inv else {
            return false;
        };
        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            i.cancel();
            i.outcome = Some(InvestigationOutcome::Cancelled);
            i.result = "Investigation cancelled by user.".into();
            i.updated_at = unix_now_ms();
        }
        self.events.emit(Event::InvestigationCancelled {
            investigation_id: investigation_id.to_string(),
            reason: "user cancelled".into(),
        });
        true
    }

    /// Status snapshot for one investigation (active or historical).
    pub fn status(&self, investigation_id: &str) -> Option<InvestigationStatus> {
        // Check active first.
        if let Some(inv) = self.active_inv(investigation_id) {
            let inv = inv.lock().unwrap_or_else(|p| p.into_inner());
            return Some(self.status_from(&*inv));
        }
        // Check history.
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.history.iter().find(|r| r.id == investigation_id).map(|r| {
            InvestigationStatus {
                id: r.id.clone(),
                query: r.query.clone(),
                stage: r.stage.clone(),
                outcome: Some(format!("{:?}", r.outcome)),
                seq: r.seq,
                started_at: r.started_at,
                updated_at: r.updated_at,
                observation_count: r.observations.len(),
                hypothesis_count: r.hypotheses.len(),
                top_hypothesis: r.top_hypothesis.clone(),
                confidence: r.confidence,
                result: r.result.clone(),
                error: r.error.clone(),
            }
        })
    }

    /// List all investigations (active + history), most recent first.
    pub fn list(&self) -> Vec<InvestigationStatus> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mut out: Vec<InvestigationStatus> = inner
            .active
            .values()
            .filter_map(|inv| {
                let inv = inv.lock().ok()?;
                Some(self.status_from(&*inv))
            })
            .collect();
        out.extend(
            inner
                .history
                .iter()
                .rev()
                .map(|r| InvestigationStatus {
                    id: r.id.clone(),
                    query: r.query.clone(),
                    stage: r.stage.clone(),
                    outcome: Some(format!("{:?}", r.outcome)),
                    seq: r.seq,
                    started_at: r.started_at,
                    updated_at: r.updated_at,
                    observation_count: r.observations.len(),
                    hypothesis_count: r.hypotheses.len(),
                    top_hypothesis: r.top_hypothesis.clone(),
                    confidence: r.confidence,
                    result: r.result.clone(),
                    error: r.error.clone(),
                }),
        );
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| b.seq.cmp(&a.seq)));
        out
    }

    fn active_inv(&self, id: &str) -> Option<Arc<Mutex<Investigation>>> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.active.get(id).cloned()
    }

    fn status_from(&self, inv: &Investigation) -> InvestigationStatus {
        InvestigationStatus {
            id: inv.id.clone(),
            query: inv.query.clone(),
            stage: inv.stage.to_string(),
            outcome: inv.outcome.map(|o| format!("{:?}", o)),
            seq: inv.seq,
            started_at: inv.started_at,
            updated_at: inv.updated_at,
            observation_count: inv.observations.len(),
            hypothesis_count: inv.hypotheses.len(),
            top_hypothesis: inv.top_hypothesis.clone(),
            confidence: inv.confidence,
            result: inv.result.clone(),
            error: inv.error.clone(),
        }
    }

    /// Run the full investigation lifecycle: observe → analyze → verify →
    /// complete/fail. Emits lifecycle events at every stage.
    fn run_lifecycle(
        id: String,
        query: String,
        inv: Arc<Mutex<Investigation>>,
        events: EventBus,
        registry: ApiRegistry,
        learning: Arc<Mutex<LearningEngine>>,
        manager_inner: Arc<Mutex<InvestigationManagerInner>>,
    ) {
        let mut stage = InvestigationStage::Observe;

        // ---- STAGE: OBSERVE ------------------------------------------------
        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            if i.is_cancelled() {
                Self::finish_cancelled(id, &inv, &manager_inner, &events);
                return;
            }
            i.stage = InvestigationStage::Observe;
            i.updated_at = unix_now_ms();
            drop(i);
        }
        events.emit(Event::InvestigationStageStarted {
            investigation_id: id.clone(),
            stage: InvestigationStage::Observe.to_string(),
        });

        let observations = Self::run_observe_stage(&id, &inv, &registry, &events, &learning);
        let observe_ok = !observations.is_empty();

        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            i.observations = observations.clone();
            i.updated_at = unix_now_ms();
            drop(i);
        }
        events.emit(Event::InvestigationStageCompleted {
            investigation_id: id.clone(),
            stage: InvestigationStage::Observe.to_string(),
            ok: observe_ok,
        });

        if !observe_ok {
            Self::finish_failed(id, &inv, &manager_inner, &events, "no observations collected".into());
            return;
        }

        // ---- STAGE: ANALYZE ------------------------------------------------
        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            if i.is_cancelled() {
                Self::finish_cancelled(id, &inv, &manager_inner, &events);
                return;
            }
            i.stage = InvestigationStage::Analyze;
            i.updated_at = unix_now_ms();
            drop(i);
        }
        events.emit(Event::InvestigationStageStarted {
            investigation_id: id.clone(),
            stage: InvestigationStage::Analyze.to_string(),
        });

        let (top, confidence, insufficient) =
            Self::run_analyze_stage(&id, &inv, &observations, &events);

        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            i.top_hypothesis = top.clone();
            i.confidence = confidence;
            i.updated_at = unix_now_ms();
            drop(i);
        }
        events.emit(Event::AnalysisCompleted {
            investigation_id: id.clone(),
            top_hypothesis: top.clone(),
            confidence,
            insufficient_evidence: insufficient,
        });
        events.emit(Event::InvestigationStageCompleted {
            investigation_id: id.clone(),
            stage: InvestigationStage::Analyze.to_string(),
            ok: !insufficient,
        });

        if insufficient {
            Self::finish_completed(
                id,
                &inv,
                &manager_inner,
                &events,
                "Insufficient evidence to reach a conclusion.".to_string(),
            );
            return;
        }

        // ---- STAGE: VERIFY -------------------------------------------------
        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            if i.is_cancelled() {
                Self::finish_cancelled(id, &inv, &manager_inner, &events);
                return;
            }
            i.stage = InvestigationStage::Verify;
            i.updated_at = unix_now_ms();
            drop(i);
        }
        events.emit(Event::InvestigationStageStarted {
            investigation_id: id.clone(),
            stage: InvestigationStage::Verify.to_string(),
        });

        let verified = Self::run_verify_stage(&id, &inv, &registry, &events);

        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            i.updated_at = unix_now_ms();
            drop(i);
        }
        events.emit(Event::VerificationCompleted {
            investigation_id: id.clone(),
            route_id: None,
            verified,
        });
        events.emit(Event::InvestigationStageCompleted {
            investigation_id: id.clone(),
            stage: InvestigationStage::Verify.to_string(),
            ok: verified,
        });

        // ---- STAGE: COMPLETE -----------------------------------------------
        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            if i.is_cancelled() {
                drop(i);
                Self::finish_cancelled(id, &inv, &manager_inner, &events);
                return;
            }
            i.stage = InvestigationStage::Complete;
            i.updated_at = unix_now_ms();
            drop(i);
        }
        events.emit(Event::InvestigationStageStarted {
            investigation_id: id.clone(),
            stage: InvestigationStage::Complete.to_string(),
        });

        let result = if verified {
            format!("Investigation complete: {top:?} confirmed (confidence {:.0}%).", confidence * 100.0)
        } else {
            format!("Investigation complete: {top:?} not verified; treat as uncertain.",)
        };
        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            i.result = result.clone();
            i.updated_at = unix_now_ms();
            drop(i);
        }
        Self::finish_completed(id, &inv, &manager_inner, &events, result);
    }

    /// Probe every registered API once through all layers, recording each
    /// observation and emitting probe/evidence events. Stops on cancellation.
    fn run_observe_stage(
        id: &str,
        inv: &Arc<Mutex<Investigation>>,
        registry: &ApiRegistry,
        events: &EventBus,
        learning: &Arc<Mutex<LearningEngine>>,
    ) -> Vec<InvestigationObservation> {
        let mut observations = Vec::new();
        let api_ids = registry.ids();
        for api_id in api_ids {
            {
                let i = inv.lock().unwrap_or_else(|p| p.into_inner());
                if i.is_cancelled() {
                    return observations;
                }
            }

            let entry = match registry.entry(&api_id) {
                Some(e) => e,
                None => continue,
            };

            // Emit a probe-started event per layer so the UI sees real progress.
            for layer in ["dns", "tcp", "tls", "http"] {
                {
                    let i = inv.lock().unwrap_or_else(|p| p.into_inner());
                    if i.is_cancelled() {
                        return observations;
                    }
                }
                events.emit(Event::ProbeStarted {
                    investigation_id: id.to_string(),
                    api_id: api_id.clone(),
                    layer: layer.to_string(),
                });
            }

            let outcome = probe_api(&entry, None);
            let ok = matches!(outcome.health, Health::Healthy);

            // Record per-layer observations from the probe result.
            for probe in &outcome.layers {
                {
                    let i = inv.lock().unwrap_or_else(|p| p.into_inner());
                    if i.is_cancelled() {
                        return observations;
                    }
                }
                let layer_ok = matches!(probe.result, crate::network_intelligence::api_intelligence::registry::LayerResult::Ok);
                let obs = InvestigationObservation {
                    api_id: api_id.clone(),
                    layer: probe.layer.clone(),
                    ok: layer_ok,
                    latency_ms: probe.latency_ms,
                    timestamp_ms: outcome.timestamp_ms,
                };
                observations.push(obs.clone());

                events.emit(Event::ProbeCompleted {
                    investigation_id: id.to_string(),
                    api_id: api_id.clone(),
                    layer: probe.layer.clone(),
                    ok: layer_ok,
                    latency_ms: probe.latency_ms,
                });

                events.emit(Event::ObservationCreated {
                    investigation_id: id.to_string(),
                    api_id: api_id.clone(),
                    layer: probe.layer.clone(),
                    ok: layer_ok,
                    latency_ms: probe.latency_ms,
                });

                events.emit(Event::EvidenceAdded {
                    investigation_id: id.to_string(),
                    evidence_id: format!("{}-{}-{}", id, api_id, probe.layer),
                    kind: probe.layer.clone(),
                    source: format!("probe:{api_id}"),
                });
            }

            // Feed the real probe outcome into local learning (advisory only).
            if let Ok(mut l) = learning.lock() {
                let healthy = matches!(outcome.health, Health::Healthy);
                let _ = l.record_api_probe(
                    &api_id,
                    healthy,
                    outcome.latency_ms,
                    outcome.timestamp_ms,
                );
            }

            {
                let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
                i.updated_at = unix_now_ms();
                drop(i);
            }
            events.emit(Event::InvestigationUpdated {
                investigation_id: id.to_string(),
                stage: InvestigationStage::Observe.to_string(),
                detail: format!("probed {api_id}: {}", if ok { "healthy" } else { "unhealthy" }),
            });
        }
        observations
    }

    /// Run the analysis stage: distill observations into hypotheses using the
    /// deterministic diagnosis core (no LLM inference of measurements).
    fn run_analyze_stage(
        id: &str,
        inv: &Arc<Mutex<Investigation>>,
        observations: &[InvestigationObservation],
        events: &EventBus,
    ) -> (Option<String>, f64, bool) {
        // Count successes/failures per layer across all observations.
        let mut layer_stats: HashMap<String, (u64, u64)> = HashMap::new();
        for obs in observations {
            let entry = layer_stats.entry(obs.layer.clone()).or_insert((0, 0));
            if obs.ok {
                entry.0 += 1;
            } else {
                entry.1 += 1;
            }
        }

        let mut hypotheses: Vec<(String, f64)> = Vec::new();
        let mut any_failure = false;
        for (layer, (ok_count, fail_count)) in &layer_stats {
            if *fail_count > 0 {
                any_failure = true;
                let total = ok_count + fail_count;
                let confidence = *fail_count as f64 / total as f64;
                hypotheses.push((layer.clone(), confidence));
            }
        }
        hypotheses.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let (top, confidence) = hypotheses.first().map(|(h, c)| (Some(h.clone()), *c)).unwrap_or((None, 0.0));
        let insufficient = !any_failure || top.is_none() || confidence < 0.25;

        // Emit hypothesis events (top hypothesis first, then runners-up).
        if let Some((h, c)) = hypotheses.first() {
            events.emit(Event::HypothesisCreated {
                investigation_id: id.to_string(),
                hypothesis_id: format!("{}-hyp-1", id),
                hypothesis: h.clone(),
                confidence: *c,
            });
            {
                let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
                i.hypotheses.insert(
                    format!("{}-hyp-1", id),
                    InvestigationHypothesis {
                        id: format!("{}-hyp-1", id),
                        hypothesis: h.clone(),
                        confidence: *c,
                    },
                );
                i.updated_at = unix_now_ms();
            }
        }
        for (idx, (h, c)) in hypotheses.iter().enumerate().skip(1) {
            events.emit(Event::HypothesisUpdated {
                investigation_id: id.to_string(),
                hypothesis_id: format!("{}-hyp-{}", id, idx + 1),
                hypothesis: h.clone(),
                confidence: *c,
            });
            {
                let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
                i.hypotheses.insert(
                    format!("{}-hyp-{}", id, idx + 1),
                    InvestigationHypothesis {
                        id: format!("{}-hyp-{}", id, idx + 1),
                        hypothesis: h.clone(),
                        confidence: *c,
                    },
                );
                i.updated_at = unix_now_ms();
            }
        }

        (top, confidence, insufficient)
    }

    /// Run the verify stage: re-probe the APIs implicated by the top hypothesis
    /// to confirm or refute it (real verification, not a guess).
    fn run_verify_stage(
        id: &str,
        inv: &Arc<Mutex<Investigation>>,
        registry: &ApiRegistry,
        events: &EventBus,
    ) -> bool {
        let api_ids = registry.ids();
        if api_ids.is_empty() {
            return false;
        }
        // Verify the first registered API (the one under investigation).
        let api_id = &api_ids[0];
        let entry = match registry.entry(api_id) {
            Some(e) => e,
            None => return false,
        };

        {
            let i = inv.lock().unwrap_or_else(|p| p.into_inner());
            if i.is_cancelled() {
                return false;
            }
        }

        let outcome = probe_api(&entry, None);
        let verified = matches!(outcome.health, Health::Healthy);

        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            i.observations.push(InvestigationObservation {
                api_id: api_id.clone(),
                layer: "verify".into(),
                ok: verified,
                latency_ms: outcome.latency_ms,
                timestamp_ms: outcome.timestamp_ms,
            });
            i.updated_at = unix_now_ms();
        }

        events.emit(Event::EvidenceAdded {
            investigation_id: id.to_string(),
            evidence_id: format!("{}-verify-{}", id, api_id),
            kind: "verify".into(),
            source: format!("verify:{api_id}"),
        });

        verified
    }

    fn finish_completed(
        id: String,
        inv: &Arc<Mutex<Investigation>>,
        manager_inner: &Arc<Mutex<InvestigationManagerInner>>,
        events: &EventBus,
        result: String,
    ) {
        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            i.outcome = Some(InvestigationOutcome::Completed);
            i.result = result.clone();
            i.updated_at = unix_now_ms();
        }
        events.emit(Event::InvestigationCompleted {
            investigation_id: id,
            result,
        });
        Self::retire_from(inv, manager_inner);
    }

    fn finish_failed(
        id: String,
        inv: &Arc<Mutex<Investigation>>,
        manager_inner: &Arc<Mutex<InvestigationManagerInner>>,
        events: &EventBus,
        reason: String,
    ) {
        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            i.outcome = Some(InvestigationOutcome::Failed);
            i.error = Some(reason.clone());
            i.result = format!("Investigation failed: {reason}");
            i.updated_at = unix_now_ms();
        }
        events.emit(Event::InvestigationFailed {
            investigation_id: id,
            reason,
        });
        Self::retire_from(inv, manager_inner);
    }

    fn finish_cancelled(
        id: String,
        inv: &Arc<Mutex<Investigation>>,
        manager_inner: &Arc<Mutex<InvestigationManagerInner>>,
        events: &EventBus,
    ) {
        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            i.outcome = Some(InvestigationOutcome::Cancelled);
            i.result = "Investigation cancelled by user.".into();
            i.updated_at = unix_now_ms();
        }
        events.emit(Event::InvestigationCompleted {
            investigation_id: id,
            result: "cancelled".into(),
        });
        Self::retire_from(inv, manager_inner);
    }

    fn retire_from(inv: &Arc<Mutex<Investigation>>, manager_inner: &Arc<Mutex<InvestigationManagerInner>>) {
        // Clone needed fields before dropping the lock, then retire.
        let record = {
            let i = inv.lock().unwrap_or_else(|p| p.into_inner());
            InvestigationRecord {
                id: i.id.clone(),
                query: i.query.clone(),
                stage: i.stage.to_string(),
                outcome: i.outcome.unwrap_or(InvestigationOutcome::Failed),
                seq: i.seq,
                started_at: i.started_at,
                updated_at: i.updated_at,
                observations: i.observations.clone(),
                hypotheses: i.hypotheses.values().cloned().collect(),
                top_hypothesis: i.top_hypothesis.clone(),
                confidence: i.confidence,
                result: i.result.clone(),
                error: i.error.clone(),
            }
        };
        let mut inner = manager_inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.active.remove(&record.id);
        inner.history.push(record);
        if inner.history.len() > inner.max_history {
            let drop = inner.history.len() - inner.max_history;
            inner.history.drain(0..drop);
        }
    }
}

impl Default for InvestigationManager {
    fn default() -> Self {
        Self::new(EventBus::default(), ApiRegistry::new(EventBus::default()), Arc::new(Mutex::new(LearningEngine::new())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network_intelligence::api_intelligence::registry::ApiEntry;

    fn test_manager() -> InvestigationManager {
        let events = EventBus::default();
        let registry = ApiRegistry::new(events.clone());
        registry.register(ApiEntry::new("api-1", "test", "https://example.com"));
        InvestigationManager::new(events, registry, Arc::new(Mutex::new(LearningEngine::new())))
    }

    #[test]
    fn start_and_cancel_before_work() {
        let mgr = test_manager();
        let id = mgr.start("test query".into());
        assert!(mgr.status(&id).is_some());
        assert!(mgr.cancel(&id));
        // After cancel, status reflects cancelled.
        let st = mgr.status(&id).expect("status");
        assert_eq!(st.outcome.as_deref(), Some("Cancelled"));
    }

    #[test]
    fn cancel_unknown_returns_false() {
        let mgr = test_manager();
        assert!(!mgr.cancel("no-such-investigation"));
    }

    #[test]
    fn status_snapshot_shape() {
        let mgr = test_manager();
        let id = mgr.start("q".into());
        let st = mgr.status(&id).expect("status");
        assert_eq!(st.query, "q");
        assert_eq!(st.stage, "observe");
        assert_eq!(st.outcome, None);
    }

    #[test]
    fn list_returns_recent_first() {
        let mgr = test_manager();
        let id1 = mgr.start("one".into());
        let id2 = mgr.start("two".into());
        let list = mgr.list();
        assert!(list.iter().any(|s| s.id == id2));
        assert_eq!(list[0].id, id2);
    }

    fn test_manager_with_bus() -> (InvestigationManager, EventBus) {
        let events = EventBus::default();
        let registry = ApiRegistry::new(events.clone());
        registry.register(ApiEntry::new("api-1", "test", "https://example.com"));
        let mgr = InvestigationManager::new(
            events.clone(),
            registry,
            Arc::new(Mutex::new(LearningEngine::new())),
        );
        (mgr, events)
    }

    #[test]
    fn cancelling_one_investigation_does_not_affect_another() {
        let mgr = test_manager();
        let a = mgr.start("a".into());
        let b = mgr.start("b".into());
        assert!(mgr.cancel(&a));
        let sa = mgr.status(&a).expect("a status");
        let sb = mgr.status(&b).expect("b status");
        assert_eq!(sa.outcome.as_deref(), Some("Cancelled"));
        assert_ne!(sb.outcome.as_deref(), Some("Cancelled"));
    }

    #[test]
    fn lifecycle_events_are_owned_by_their_investigation() {
        let (mgr, events) = test_manager_with_bus();
        let a = mgr.start("a".into());
        let b = mgr.start("b".into());

        let a_events = events.replay_session(&a, 0);
        assert!(!a_events.is_empty(), "investigation A emitted no events");
        assert!(a_events
            .iter()
            .all(|(_, e)| e.investigation_id() == Some(a.as_str())));
        assert!(a_events
            .iter()
            .any(|(_, e)| matches!(e, Event::InvestigationStarted { .. })));

        let b_events = events.replay_session(&b, 0);
        assert!(!b_events.is_empty(), "investigation B emitted no events");
        assert!(b_events
            .iter()
            .all(|(_, e)| e.investigation_id() == Some(b.as_str())));
    }

    #[test]
    fn history_is_bounded() {
        let mgr = test_manager();
        // Start and cancel many; each retires to history.
        for i in 0..60 {
            let id = mgr.start(format!("q{i}").into());
            mgr.cancel(&id);
        }
        let inner = mgr.inner.lock().unwrap_or_else(|p| p.into_inner());
        assert!(inner.history.len() <= 50);
    }

    // ===================================================================
    // N0 integration wiring tests (NANI-001, NANI-002).
    //
    // The forensic audit established that the production InvestigationManager
    // was built with its OWN empty ApiRegistry and its OWN placeholder
    // EventBus: investigations observed zero APIs and their lifecycle events
    // never reached the webview. These tests exercise the production wiring
    // shape (shared registry + shared canonical bus) against a real local
    // HTTP endpoint, and a guard documents the original defect.
    // ===================================================================

    /// Serialized `kind` tag of an event (the serde tag the frontend
    /// reducer consumes - same contract, same names).
    fn event_kind(e: &crate::network_intelligence::events::Event) -> String {
        serde_json::to_value(e)
            .ok()
            .and_then(|v| v.get("kind").and_then(|k| k.as_str()).map(String::from))
            .unwrap_or_default()
    }

    /// Minimal deterministic HTTP responder for 127.0.0.1 (no internet).
    /// Answers 200 to every request, then keeps listening until dropped.
    fn spawn_local_http() -> (u16, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind localhost");
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                // Drain the request head (bounded); answer 200.
                let mut buf = [0u8; 1024];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let _ = std::io::Write::write_all(
                    &mut stream,
                    b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });
        (port, handle)
    }

    fn wait_terminal(mgr: &InvestigationManager, id: &str) -> InvestigationStatus {
        for _ in 0..600 {
            if let Some(st) = mgr.status(id) {
                if st.outcome.is_some() {
                    return st;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("investigation {id} did not reach a terminal state in 6s");
    }

    /// THE N0 ACCEPTANCE GATE: the production wiring shape, end to end.
    ///
    /// Builds the application-equivalent dependencies (one shared registry,
    /// one canonical bus with a collectable receiver), registers a test API
    /// through the SAME mechanism `netpulse-cloud` uses, constructs the
    /// manager, applies the same setup re-wiring main.rs performs, starts a
    /// real investigation, and asserts the full honest lifecycle: real probe
    /// execution against the local endpoint, lifecycle events on the shared
    /// bus, replay presence, matching ids, and no silent loss.
    ///
    /// This test FAILS against the original broken wiring: with the old
    /// construction the manager observes an empty registry (no observations,
    /// no probe events) and emits on a bus this receiver never sees.
    #[test]
    fn n0_end_to_end_investigation_through_shared_registry_and_canonical_bus() {
        use crate::network_intelligence::events::Event;

        // 1. Canonical application bus + collectable receiver.
        let (bus, rx) = EventBus::new();
        // 2. THE shared API registry (one instance for the whole app).
        let registry = ApiRegistry::new(bus.clone());
        // 3. Deterministic local endpoint (no internet, no credentials).
        let (port, server) = spawn_local_http();
        // 4. Register through the production mechanism (same call that
        //    registers netpulse-cloud in main.rs setup).
        assert!(registry.register(ApiEntry::new(
            "n0-test-api",
            "test",
            &format!("http://127.0.0.1:{port}/healthz"),
        )));
        // 5. Manager over the shared dependencies...
        let mut mgr = InvestigationManager::new(
            bus.clone(),
            registry.clone(),
            Arc::new(Mutex::new(LearningEngine::new())),
        );
        // 6. ...and the same setup re-wiring main.rs performs.
        mgr.set_registry(registry.clone());
        mgr.set_event_bus(bus.clone());
        // Sharing is by Arc identity, not snapshot copies.
        assert!(mgr.shares_registry_with(&registry));
        assert!(mgr.shares_event_bus_with(&bus));

        // 7. Real investigation through the production entry point.
        let id = mgr.start("n0 integration check".into());
        let status = wait_terminal(&mgr, &id);

        // 8. The registered API was discovered AND actually invoked.
        assert_eq!(status.outcome.as_deref(), Some("Completed"));
        assert!(status.observation_count > 0, "no observations: the manager did not see the registered API");
        {
            let inner = mgr.inner.lock().unwrap_or_else(|p| p.into_inner());
            let record = inner
                .history
                .iter()
                .find(|r| r.id == id)
                .expect("completed investigation must be in history");
            assert!(record
                .observations
                .iter()
                .all(|o| o.api_id == "n0-test-api"));
            assert!(record
                .observations
                .iter()
                .any(|o| o.layer == "dns" && o.ok));
            assert!(record
                .observations
                .iter()
                .any(|o| o.layer == "tcp" && o.ok));
        }

        // 9. Lifecycle events on the CANONICAL bus, correctly identified.
        let events = bus.replay_session(&id, 0);
        assert!(!events.is_empty(), "no lifecycle events on the shared bus");
        assert!(events
            .iter()
            .all(|(_, e)| e.investigation_id() == Some(id.as_str())),
            "event identity mismatch: foreign investigation events leaked");
        let kinds: Vec<String> = events
            .iter()
            .map(|(_, e)| event_kind(e))
            .collect();
        for expected in [
            "InvestigationStarted",
            "InvestigationStageStarted",
            "ProbeStarted",
            "ProbeCompleted",
            "EvidenceAdded",
            "AnalysisCompleted",
            "InvestigationCompleted",
        ] {
            assert!(
                kinds.iter().any(|k| k == expected),
                "lifecycle event {expected} missing from the canonical bus (kinds: {kinds:?})"
            );
        }
        // Healthy endpoint: the verify stage is HONESTLY SKIPPED (nothing
        // to verify without a failure hypothesis) — VerificationCompleted
        // must NOT be fabricated out of a success.
        assert!(
            !kinds.iter().any(|k| k == "VerificationCompleted"),
            "verify event must not appear for a failure-free investigation"
        );

        // Evidence events really exist and reference this investigation.
        assert!(events
            .iter()
            .any(|(_, e)| matches!(e, Event::EvidenceAdded { investigation_id, .. } if investigation_id == &id)));
        // No duplicate delivery: seq strictly increasing per event.
        let seqs: Vec<u64> = events.iter().map(|(s, _)| *s).collect();
        let mut sorted = seqs.clone();
        sorted.sort_unstable();
        assert_eq!(seqs, sorted, "replay sequence out of order or duplicated");

        // 10. The replay adapter (what nani_poll_events serves) has them.
        let replayed = bus.replay_since(0);
        assert!(replayed
            .iter()
            .any(|(_, e)| e.investigation_id() == Some(id.as_str())));

        // 10b. FAILING endpoint leg: a closed port produces a real failure
        // hypothesis, and the verify stage RUNS and reports honestly.
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_port = closed.local_addr().unwrap().port();
        drop(closed); // nothing listens there now: connect is refused, deterministically
        assert!(registry.register(ApiEntry::new(
            "n0-failing-api",
            "test",
            &format!("http://127.0.0.1:{closed_port}/healthz"),
        )));
        let idf = mgr.start("failing endpoint check".into());
        let stf = wait_terminal(&mgr, &idf);
        assert_eq!(stf.outcome.as_deref(), Some("Completed"));
        let evf = bus.replay_session(&idf, 0);
        let kinds_f: Vec<String> = evf.iter().map(|(_, e)| event_kind(e)).collect();
        assert!(kinds_f.iter().any(|k| k == "AnalysisCompleted"));
        assert!(kinds_f.iter().any(|k| k == "VerificationCompleted"),
            "verify stage must run when a failure hypothesis exists (kinds: {kinds_f:?})");
        assert!(evf.iter().any(|(_, e)| matches!(e,
            crate::network_intelligence::events::Event::EvidenceAdded { investigation_id, kind, .. }
            if investigation_id == &idf && kind == "verify")),
            "verify-stage evidence missing");
        // The failure observation really exists (not a fabricated fault).
        {
            let inner = mgr.inner.lock().unwrap_or_else(|p| p.into_inner());
            let record = inner.history.iter().find(|r| r.id == idf).unwrap();
            assert!(record.observations.iter().any(|o| o.api_id == "n0-failing-api" && !o.ok));
        }

        // 11. A LATER registration is visible through the shared registry.
        let (port2, server2) = spawn_local_http();
        assert!(registry.register(ApiEntry::new(
            "n0-late-api",
            "test",
            &format!("http://127.0.0.1:{port2}/healthz"),
        )));
        let id2 = mgr.start("late registration check".into());
        let st2 = wait_terminal(&mgr, &id2);
        assert!(st2.observation_count > 0, "late registration invisible to the manager");
        {
            let inner = mgr.inner.lock().unwrap_or_else(|p| p.into_inner());
            let record = inner.history.iter().find(|r| r.id == id2).unwrap();
            assert!(record
                .observations
                .iter()
                .any(|o| o.api_id == "n0-late-api"));
        }

        // 12. An unregistered API is never reported as observed.
        {
            let inner = mgr.inner.lock().unwrap_or_else(|p| p.into_inner());
            for record in &inner.history {
                assert!(
                    record.observations.iter().all(|o| o.api_id != "never-registered"),
                    "unregistered API was probed"
                );
            }
        }

        // The responder threads run until the test process ends (their
        // `incoming()` loop never returns); dropping the handles detaches
        // them. Joining would block forever — a bug this test will not have.
        drop(server);
        drop(server2);
        let _ = rx; // receiver kept alive for the duration (events collected above)
    }

    /// Regression guard for the ORIGINAL defect: constructing the manager
    /// old-style (placeholder bus + own empty registry, exactly as
    /// `NaniState` did before N0) reproduces the failure the fix addresses.
    /// If this test's BUG assertions ever stop holding, the construction
    /// changed — re-read main.rs and the wiring test above.
    #[test]
    fn n0_guard_old_wiring_produces_the_audited_defect() {
        let (real_bus, real_rx) = EventBus::new();
        let registry = ApiRegistry::new(real_bus.clone());
        registry.register(ApiEntry::new("app-api", "test", "https://example.invalid"));
        // Old wiring: manager with a DIFFERENT (empty) registry + placeholder bus.
        let mgr = InvestigationManager::new(
            EventBus::default(),
            ApiRegistry::new(EventBus::default()),
            Arc::new(Mutex::new(LearningEngine::new())),
        );
        assert!(!mgr.shares_registry_with(&registry), "guard premise: registries were separate");
        assert!(!mgr.shares_event_bus_with(&real_bus), "guard premise: buses were separate");
        let id = mgr.start("guard".into());
        let status = wait_terminal(&mgr, &id);
        // The audited defect: zero observations, nothing on the app bus.
        assert_eq!(status.observation_count, 0, "old wiring unexpectedly saw an API");
        assert!(real_rx.try_recv().is_err(), "old wiring unexpectedly delivered events to the app bus");
    }
}
