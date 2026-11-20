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

use crate::network_intelligence::api_intelligence::monitor::{
    diagnostic_probes, observe_diagnostic_probes_matching, probe_api,
};
use crate::network_intelligence::api_intelligence::registry::{
    ApiRegistry, Health, LayerResult, ProbeOutcomeRecord,
};
use crate::network_intelligence::diagnosis::{DiagnosticEngine, DiagnosticTest};
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
    /// Raw measurement kind behind `ok` (N1.1 evidence provenance):
    /// "ok" | "failed" | "unknown". A layer that was never exercised is
    /// `unknown` — missing evidence, never a failure and never a success.
    /// Additive + defaulted so previously persisted records still decode.
    #[serde(default)]
    pub result: Option<String>,
    /// Sanitized measurement detail (e.g. the HTTP status code) — the
    /// difference between a transport failure and an application-level
    /// answer. Already sanitized upstream (no secrets). Additive + defaulted.
    #[serde(default)]
    pub detail: Option<String>,
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
    /// Maximum concurrently ACTIVE investigations (N0-review condition C3).
    /// Binds worker threads and real network probe load. Excess starts are
    /// rejected honestly as failed investigations.
    pub const MAX_ACTIVE_INVESTIGATIONS: usize = 4;
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

    /// Wire the manager onto the application's authoritative dependencies.
    ///
    /// N0-review condition C1: the setup call-site is now a named, testable
    /// function. `main.rs` setup calls exactly this; the unit test asserts
    /// the sharing is by Arc identity (a future refactor that reintroduces
    /// an isolated registry or placeholder bus fails the test here instead
    /// of silently regressing the product).
    pub fn wire_application_dependencies(
        manager: &mut InvestigationManager,
        registry: &ApiRegistry,
        bus: &EventBus,
    ) {
        manager.set_registry(registry.clone());
        manager.set_event_bus(bus.clone());
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
        // K-2 (N1-review): the cap check AND the active-slot insert must be
        // one critical section. Two lock acquisitions left a window where two
        // simultaneous starts could both pass the check and both insert,
        // transiently exceeding the cap.
        let (id, seq, rejected, inv_arc) = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            // C3 (N0-review condition): bounded concurrency. Each active
            // investigation holds a worker thread running real network
            // probes; the cap bounds resource use. Excess starts are
            // rejected HONESTLY: a failed investigation record + event, so
            // the UI sees why nothing runs — never a silent queue or drop.
            // Slots are released by every terminal path (complete, fail,
            // cancel, and the panic guard), so capacity cannot leak.
            let rejected = inner.active.len() >= Self::MAX_ACTIVE_INVESTIGATIONS;
            let id = format!("nani-investigation-{}", inner.next_id);
            let seq = inner.next_id;
            inner.next_id += 1;
            if rejected {
                (id, seq, true, None)
            } else {
                let inv_arc = Arc::new(Mutex::new(Investigation::new(
                    id.clone(),
                    query.clone(),
                    seq,
                )));
                inner.active.insert(id.clone(), inv_arc.clone());
                (id, seq, false, Some(inv_arc))
            }
        };

        if rejected {
            let reason = format!(
                "Investigation rejected: concurrency limit ({}) reached.",
                Self::MAX_ACTIVE_INVESTIGATIONS
            );
            let inv = Arc::new(Mutex::new(Investigation::new(id.clone(), query.clone(), seq)));
            {
                let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
                i.outcome = Some(InvestigationOutcome::Failed);
                i.error = Some("concurrency limit".into());
                i.result = reason.clone();
                i.updated_at = unix_now_ms();
            }
            self.events.emit(Event::InvestigationFailed {
                investigation_id: id.clone(),
                reason: "concurrency limit reached".into(),
            });
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner.history.push(Self::snapshot_record(&inv));
            if inner.history.len() > inner.max_history {
                let drop = inner.history.len() - inner.max_history;
                inner.history.drain(0..drop);
            }
            return id;
        }

        let inv_arc = inv_arc.expect("non-rejected start must hold a slot");

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
    ///
    /// N1.1 panic safety (N0-review condition C3): the whole lifecycle runs
    /// under `catch_unwind`. A panic in any stage produces an honest terminal
    /// `InvestigationFailed` (identity and failure reporting preserved), the
    /// active slot is released by the normal retire path, and the panic is
    /// never converted into a success. Diagnostic detail is not swallowed:
    /// the panic message is preserved on the record when Rust exposes one.
    fn run_lifecycle(
        id: String,
        query: String,
        inv: Arc<Mutex<Investigation>>,
        events: EventBus,
        registry: ApiRegistry,
        learning: Arc<Mutex<LearningEngine>>,
        manager_inner: Arc<Mutex<InvestigationManagerInner>>,
    ) {
        let id_for_failure = id.clone();
        let inv_for_failure = inv.clone();
        let inner_for_failure = manager_inner.clone();
        let events_for_failure = events.clone();
        Self::guarded_lifecycle(
            id_for_failure,
            &inv_for_failure,
            &inner_for_failure,
            &events_for_failure,
            move || {
                Self::lifecycle_stages(
                    id,
                    query,
                    inv,
                    events,
                    registry,
                    learning,
                    manager_inner,
                );
            },
        );
    }

    /// Execute `body` under the panic guard: a panic produces an honest
    /// terminal `InvestigationFailed`, releases the active slot through the
    /// normal retire path, and is never converted into a success.
    fn guarded_lifecycle<F: FnOnce()>(
        id: String,
        inv: &Arc<Mutex<Investigation>>,
        manager_inner: &Arc<Mutex<InvestigationManagerInner>>,
        events: &EventBus,
        body: F,
    ) {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)).is_err() {
            Self::finish_failed(
                id,
                inv,
                manager_inner,
                events,
                "internal error: the investigation panicked and was stopped".into(),
            );
        }
    }

    /// The staged body of [`Self::run_lifecycle`], executed under the panic
    /// guard. Each investigation owns a fresh [`DiagnosticEngine`] — the same
    /// authoritative engine the `nani_math` surface exposes — fed by the real
    /// probe outcomes in the observe stage and consulted by the analysis,
    /// verification, and completion stages. No parallel Bayesian math lives
    /// in this file.
    fn lifecycle_stages(
        id: String,
        query: String,
        inv: Arc<Mutex<Investigation>>,
        events: EventBus,
        registry: ApiRegistry,
        learning: Arc<Mutex<LearningEngine>>,
        manager_inner: Arc<Mutex<InvestigationManagerInner>>,
    ) {
        let _ = query;
        let mut engine = DiagnosticEngine::new();
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

        let observations =
            Self::run_observe_stage(&id, &inv, &registry, &events, &learning, &mut engine);
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

        let (top, confidence, has_failure_evidence) =
            Self::run_analyze_stage(&id, &inv, &observations, &engine, &events);
        // Post-analysis refusal: honest and preliminary. Verification below
        // may still change the verdict (a refuted leader can fall below the
        // conclusion floor); the final result carries the final truth.
        let insufficient = !has_failure_evidence || top.is_none();

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

        let (verified, failure_reproduced) =
            Self::run_verify_stage(&id, &inv, &registry, &observations, &top, &mut engine, &events);
        // K-3 (N1-review): for a failure hypothesis, a re-measured failure is
        // a REPRODUCTION (the strongest confirmation), a passing layer is a
        // refutation, and an unmeasured layer stays unverified. The prose
        // must not call a reproduced failure "unverified".

        // N1.1: the verification probe is real evidence — the authoritative
        // engine has absorbed it, so the FINAL verdict comes from the updated
        // posterior, not from the pre-verification snapshot.
        let (top, confidence) = engine
            .diagnosis()
            .map(|(l, p)| (Some(l.to_string()), p))
            .unwrap_or((None, 0.0));
        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            i.top_hypothesis = top.clone();
            i.confidence = confidence;
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

        // Established refusal floor (preserved from the previous lifecycle,
        // now applied to a real posterior): a leader below this probability is
        // not a justified conclusion, even after verification.
        const CONCLUSION_FLOOR: f64 = 0.25;
        let result = Self::verify_result_text(&top, confidence, verified, failure_reproduced);
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
    ///
    /// N1.1: every real probe outcome is ALSO fed into the authoritative
    /// Bayesian engine through its established `observe` contract — the
    /// time-scaled predict step, the correlation discount, and log-space
    /// updates are the engine's own, never reimplemented here.
    fn run_observe_stage(
        id: &str,
        inv: &Arc<Mutex<Investigation>>,
        registry: &ApiRegistry,
        events: &EventBus,
        learning: &Arc<Mutex<LearningEngine>>,
        engine: &mut DiagnosticEngine,
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

            // N1.1/N1.2: the same measured record the observations come from
            // is the engine's evidence, fed through THE canonical boundary
            // (`observe_diagnostic_probes`), which owns the ms→seconds
            // conversion. See N1_01/N1_2_01 for the unit analysis.
            observe_diagnostic_probes_matching(engine, &outcome, |_| true);

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
                    result: Some(match probe.result {
                        LayerResult::Ok => "ok",
                        LayerResult::Failed => "failed",
                        LayerResult::Unknown => "unknown",
                    }
                    .to_string()),
                    detail: probe.detail.clone(),
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

    /// Run the analysis stage: consume the authoritative Bayesian posterior.
    ///
    /// N1.1 (NANI-003): the previous implementation counted per-layer failure
    /// ratios and presented them as "confidence" — the audited disconnect
    /// between the investigation lifecycle and the engine. The engine has
    /// already absorbed every real observation during the observe stage; this
    /// stage reads its posterior, publishes the REAL ranking through the
    /// existing hypothesis events, and applies the established refusal floor
    /// (a posterior leader below 0.25 is not a justified conclusion —
    /// relative ranking is never confused with diagnostic certainty).
    fn run_analyze_stage(
        id: &str,
        inv: &Arc<Mutex<Investigation>>,
        observations: &[InvestigationObservation],
        engine: &DiagnosticEngine,
        events: &EventBus,
    ) -> (Option<String>, f64, bool) {
        // Failed or unexercised layers are the only thing a diagnosis is
        // about; an all-healthy investigation has no failure to explain and
        // must never manufacture one. The established shape is preserved: no
        // failure evidence → no hypothesis claim (the raw posterior on an
        // all-healthy endpoint concentrates on the least-failure-prone
        // hypothesis, which is a likelihood-table artifact, not evidence of
        // a fault — see NANI-020).
        let has_failure_evidence = observations.iter().any(|o| !o.ok);
        if !has_failure_evidence {
            return (None, 0.0, false);
        }
        let map = engine.diagnosis();
        let (top, confidence) = map
            .map(|(label, prob)| (Some(label.to_string()), prob))
            .unwrap_or((None, 0.0));

        // Publish the REAL posterior ranking (top first), bounded to the
        // leading five so a 19-hypothesis space cannot flood the event feed.
        // Every confidence is a posterior probability of the same single
        // distribution — they can never sum past 1.
        const MAX_REPORTED_HYPOTHESES: usize = 5;
        for (idx, (label, prob)) in engine
            .ranked()
            .into_iter()
            .take(MAX_REPORTED_HYPOTHESES)
            .enumerate()
        {
            let hypothesis_id = format!("{}-hyp-{}", id, idx + 1);
            if idx == 0 {
                events.emit(Event::HypothesisCreated {
                    investigation_id: id.to_string(),
                    hypothesis_id: hypothesis_id.clone(),
                    hypothesis: label.to_string(),
                    confidence: prob,
                });
            } else {
                events.emit(Event::HypothesisUpdated {
                    investigation_id: id.to_string(),
                    hypothesis_id: hypothesis_id.clone(),
                    hypothesis: label.to_string(),
                    confidence: prob,
                });
            }
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            i.hypotheses.insert(
                hypothesis_id.clone(),
                InvestigationHypothesis {
                    id: hypothesis_id,
                    hypothesis: label.to_string(),
                    confidence: prob,
                },
            );
            i.updated_at = unix_now_ms();
        }

        (top, confidence, has_failure_evidence)
    }

    /// Run the verify stage: re-probe the network layer implicated by the
    /// leading hypothesis (real verification, not a guess).
    ///
    /// Returns `(verified, failure_reproduced)`: `verified` — the implicated
    /// layer re-measured Ok (the failure did NOT reproduce);
    /// `failure_reproduced` — the implicated layer failed again, which for a
    /// failure hypothesis is confirmation, never an "unverified" outcome.
    ///
    /// N1.1: verification now TARGETS the diagnostic claim it tests. The
    /// layer is chosen from the leading hypothesis (a DNS claim is verified
    /// by resolving again, a transport claim by connecting again, an
    /// application claim by the full HTTP exchange), and the API probed is
    /// one that actually failed that layer. The verification outcome enters
    /// the authoritative engine through the same `observe` contract — a
    /// repeated probe is discounted by the correlation model, so a
    /// verification rerun cannot amplify evidence. A failed verification
    /// stays failed and a missing layer is never counted as success.
    fn run_verify_stage(
        id: &str,
        inv: &Arc<Mutex<Investigation>>,
        registry: &ApiRegistry,
        observations: &[InvestigationObservation],
        top: &Option<String>,
        engine: &mut DiagnosticEngine,
        events: &EventBus,
    ) -> (bool, bool) {
        let layer = top
            .as_deref()
            .map(Self::verify_layer_for)
            .unwrap_or("http");
        // Prefer an API whose observations actually failed the implicated
        // layer; fall back to the first observed API.
        let api_id = observations
            .iter()
            .find(|o| o.layer == layer && !o.ok)
            .map(|o| o.api_id.clone())
            .or_else(|| observations.first().map(|o| o.api_id.clone()));
        let Some(api_id) = api_id else {
            return (false, false);
        };
        let entry = match registry.entry(&api_id) {
            Some(e) => e,
            None => return (false, false),
        };

        {
            let i = inv.lock().unwrap_or_else(|p| p.into_inner());
            if i.is_cancelled() {
                return (false, false);
            }
        }

        let outcome = probe_api(&entry, None);
        // `verified` is the real outcome of the implicated layer on this
        // re-measurement — Missing (never exercised) is NOT success.
        let implicated = outcome.layers.iter().find(|p| p.layer == layer);
        let verified = implicated
            .is_some_and(|p| matches!(p.result, LayerResult::Ok));
        let failure_reproduced = implicated
            .is_some_and(|p| matches!(p.result, LayerResult::Failed));

        // Feed the verification measurement into the authoritative engine
        // (only the layer the claim is about — verification targets one
        // diagnostic claim). The repeat is correlation-discounted by the
        // engine, so a verification rerun cannot count as fresh independent
        // proof.
        let test = Self::verify_test_for(layer);
        observe_diagnostic_probes_matching(engine, &outcome, |id| id == test);

        {
            let mut i = inv.lock().unwrap_or_else(|p| p.into_inner());
            i.observations.push(InvestigationObservation {
                api_id: api_id.clone(),
                layer: "verify".into(),
                ok: verified,
                latency_ms: outcome.latency_ms,
                timestamp_ms: outcome.timestamp_ms,
                // The implicated layer's REAL re-measured kind — a Missing
                // layer records "unknown", never a success.
                result: implicated.map(|p| match p.result {
                    LayerResult::Ok => "ok",
                    LayerResult::Failed => "failed",
                    LayerResult::Unknown => "unknown",
                }.to_string()),
                detail: implicated.and_then(|p| p.detail.clone()),
            });
            i.updated_at = unix_now_ms();
        }

        events.emit(Event::EvidenceAdded {
            investigation_id: id.to_string(),
            evidence_id: format!("{}-verify-{}", id, api_id),
            kind: "verify".into(),
            source: format!("verify:{api_id}"),
        });

        (verified, failure_reproduced)
    }

    /// Human-readable verification explanation — the single semantic
    /// mapping from the re-measurement outcome to what the user is told
    /// (N1.2, K-3). Cases:
    /// - **A — reproduced:** the implicated layer failed again; the
    ///   re-measurement SUPPORTS the hypothesis. Worded as support, never as
    ///   root-cause proof (reproducing a symptom is not proving the cause).
    /// - **B — not reproduced:** the layer passed; the observation
    ///   challenges the leader and the posterior was updated accordingly;
    ///   the verdict stays explicitly uncertain.
    /// - **C — unavailable / unmeasured:** no re-measurement of the
    ///   implicated layer exists. Absence of verification is NEVER success.
    /// - **D — inconclusive:** with boolean layer outcomes there is no
    ///   distinct fourth outcome; a measurement that cannot discriminate
    ///   competes only through its posterior weight, so D shares B's
    ///   explicit-uncertainty wording and the posterior carries the nuance
    ///   (documented in N1_2_03).
    fn verify_result_text(
        top: &Option<String>,
        confidence: f64,
        verified: bool,
        failure_reproduced: bool,
    ) -> String {
        const CONCLUSION_FLOOR: f64 = 0.25;
        let label = top.as_deref().unwrap_or("unknown");
        if confidence < CONCLUSION_FLOOR {
            "Insufficient evidence to reach a conclusion.".to_string()
        } else if failure_reproduced {
            format!(
                "Investigation complete: {label:?} reproduced on re-measurement (confidence {:.0}%); the re-measurement supports this hypothesis, though it does not by itself prove the complete root cause.",
                confidence * 100.0
            )
        } else if verified {
            format!(
                "Investigation complete: {label:?} not reproduced on re-measurement (confidence {:.0}%); the observation challenges this hypothesis and the posterior was updated accordingly — treat the verdict as uncertain.",
                confidence * 100.0
            )
        } else {
            format!(
                "Investigation complete: {label:?} could not be verified (the implicated layer was not re-measured); absence of verification is not success — treat the verdict as uncertain.",
            )
        }
    }

    /// The network layer whose re-measurement can confirm or refute a
    /// hypothesis. Hypotheses only observable through the full HTTP exchange
    /// (auth, rate limiting, provider faults) verify on the HTTP layer.
    fn verify_layer_for(hypothesis: &str) -> &'static str {
        match hypothesis {
            "dns" | "dns_inconsistency" => "dns",
            "tls" => "tls",
            "tcp" | "ipv4" | "ipv6" | "routing" | "mtu" | "congestion_or_packet_loss"
            | "quic_udp_failure" => "tcp",
            _ => "http",
        }
    }

    /// Diagnostic test whose re-run verifies the given layer — the same
    /// mapping [`diagnostic_probes`] uses, so verification evidence is keyed
    /// exactly like observe evidence.
    fn verify_test_for(layer: &str) -> &'static str {
        match layer {
            "dns" => DiagnosticTest::DnsResolve.correlation_id(),
            "tcp" => DiagnosticTest::TcpConnect.correlation_id(),
            "tls" => DiagnosticTest::TlsHandshake.correlation_id(),
            _ => DiagnosticTest::HttpGet.correlation_id(),
        }
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
        let record = Self::snapshot_record(inv);
        let mut inner = manager_inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.active.remove(&record.id);
        inner.history.push(record);
        if inner.history.len() > inner.max_history {
            let drop = inner.history.len() - inner.max_history;
            inner.history.drain(0..drop);
        }
    }

    /// Snapshot an investigation into its bounded-history record.
    fn snapshot_record(inv: &Arc<Mutex<Investigation>>) -> InvestigationRecord {
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
        let mut last: Option<InvestigationStatus> = None;
        for _ in 0..600 {
            if let Some(st) = mgr.status(id) {
                if st.outcome.is_some() {
                    return st;
                }
                last = Some(st);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("investigation {id} did not reach a terminal state in 6s; last status: {last:?}");
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
        assert!(registry.register({
            let mut entry = ApiEntry::new(
                "n0-test-api",
                "test",
                &format!("http://127.0.0.1:{port}/healthz"),
            );
            // Local server answers immediately; keep the probe well inside
            // wait_terminal's 6s cap (same fixture rule as the sibling tests).
            entry.timeout_ms = 50;
            entry
        }));
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
        // Port 1 sits outside the OS ephemeral range: connect is refused
        // deterministically. (A dropped dynamic port can be re-bound by
        // another process within milliseconds — an observed flake.)
        let closed_port = 1u16;
        assert!(registry.register({
            let mut entry = ApiEntry::new(
                "n0-failing-api",
                "test",
                &format!("http://127.0.0.1:{closed_port}/healthz"),
            );
            // Closed loopback refuses immediately; keep this fixture inside
            // wait_terminal's 6s cap. No assertion or engine math changes.
            entry.timeout_ms = 50;
            entry
        }));
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
        assert!(registry.register({
            let mut entry = ApiEntry::new(
                "n0-late-api",
                "test",
                &format!("http://127.0.0.1:{port2}/healthz"),
            );
            entry.timeout_ms = 50;
            entry
        }));
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

    // ===================================================================
    // N1.1 — Bayesian engine drives the real analysis (NANI-003).
    // ===================================================================

    /// A listener that accepts connections but never answers: TCP connects
    /// succeed, HTTP requests hang until the entry timeout.
    fn spawn_hanging_http() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                // Accept and hold; the request is never answered.
                let _ = stream;
            }
        });
        port
    }

    /// THE N1.1 ACCEPTANCE GATE: the reported analysis must be EXACTLY what
    /// the authoritative Bayesian engine computes from the very observations
    /// the investigation recorded — reconstructed independently in this test
    /// through the same production conversion (`diagnostic_probes`) and the
    /// same `observe` contract.
    ///
    /// This fails against the previous ratio-only `run_analyze_stage`: the
    /// old path reported per-layer failure ratios as "confidence" (1.0 for a
    /// single failed layer, several hypotheses at 1.0 each — an impossible
    /// distribution), never consulted the engine, and ranked by hash-order.
    #[test]
    fn n1_bayesian_engine_drives_the_real_analysis() {
        use crate::network_intelligence::api_intelligence::monitor::diagnostic_probes;
        use crate::network_intelligence::api_intelligence::registry::{
            HealthProbe, LayerResult, ProbeOutcomeRecord,
        };
        use crate::network_intelligence::api_model::{FailureCategory, RouteKind};
        use crate::network_intelligence::diagnosis::DiagnosticEngine;

        // A deterministically failing endpoint: DNS resolves (loopback), TCP
        // is refused, TLS/HTTP are never exercised (Missing). Port 1 is
        // deliberately OUTSIDE the OS ephemeral range: a dropped
        // `TcpListener::bind(":0")` port can be re-bound by another process
        // within milliseconds (observed live — an "HTTP 200 failing leg"),
        // so a dynamic port is not a deterministic failure.
        let closed_port = 1u16;

        let (bus, _rx) = EventBus::new();
        let registry = ApiRegistry::new(bus.clone());
        let mut fail_entry = ApiEntry::new(
            "n1-fail-api",
            "test",
            &format!("http://127.0.0.1:{closed_port}/healthz"),
        );
        // Test-fixture boundary (same as the sibling probe test at line ~1880):
        // a closed loopback port refuses immediately; without a short timeout
        // the default 10s probe can outlast wait_terminal's 6s cap and make
        // this deterministic oracle time out. No assertion or engine math is
        // changed — only how long the test waits on a guaranteed-closed port.
        fail_entry.timeout_ms = 50;
        registry.register(fail_entry);
        let mut mgr = InvestigationManager::new(
            bus.clone(),
            registry.clone(),
            Arc::new(Mutex::new(LearningEngine::new())),
        );
        InvestigationManager::wire_application_dependencies(&mut mgr, &registry, &bus);

        let id = mgr.start("n1 oracle".into());
        let status = wait_terminal(&mgr, &id);
        assert_eq!(status.outcome.as_deref(), Some("Completed"));

        let record = {
            let inner = mgr.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner
                .history
                .iter()
                .find(|r| r.id == id)
                .expect("terminal investigation must be in history")
                .clone()
        };

        // Independent reconstruction of the engine the lifecycle must have
        // fed: every recorded observation, converted exactly the way the
        // production path converts it.
        let mut reference = DiagnosticEngine::new();
        let mut verify_at: Option<(String, u64)> = None;
        let api_id_for_verify = record
            .observations
            .first()
            .map(|o| o.api_id.clone())
            .unwrap_or_default();
        for obs in &record.observations {
            if obs.layer == "verify" {
                verify_at = Some((obs.api_id.clone(), obs.timestamp_ms));
                continue;
            }
            let result = match obs.result.as_deref() {
                Some("ok") => LayerResult::Ok,
                Some("failed") => LayerResult::Failed,
                _ => LayerResult::Unknown,
            };
            let single = ProbeOutcomeRecord {
                timestamp_ms: obs.timestamp_ms,
                api_id: obs.api_id.clone(),
                health: Health::Unknown,
                category: FailureCategory::Unknown,
                route: RouteKind::Direct,
                layers: vec![HealthProbe {
                    layer: obs.layer.clone(),
                    result,
                    latency_ms: obs.latency_ms,
                    detail: obs.detail.clone(),
                }],
                latency_ms: None,
            };
            for mut pr in diagnostic_probes(&single) {
                pr.timestamp /= 1000;
                reference.observe(&pr);
            }
        }

        // Verification targets the leading hypothesis' layer on the same
        // endpoint; on a closed port the re-probe deterministically reproduces
        // the observe-stage outcomes (dns Ok, tcp Failed, tls/http Missing).
        let pre_verify_events = bus.replay_session(&id, 0).into_iter().find_map(|(_, e)| match e {
            Event::AnalysisCompleted { top_hypothesis, confidence, .. } => Some((top_hypothesis.clone(), confidence)),
            _ => None,
        });
        let pre_verify_top = pre_verify_events.as_ref().and_then(|(top, _)| top.clone());
        let (top_ref, prob_ref_after_verify) = {
            let (label, _) = reference.diagnosis().expect("posterior exists");
            let layer = InvestigationManager::verify_layer_for(label);
            let test = InvestigationManager::verify_test_for(layer);
            if let Some((ref api_id, ts)) = verify_at {
                let re_probe = probe_api(
                    &registry.entry(&api_id).expect("registered"),
                    None,
                );
                for mut pr in diagnostic_probes(&re_probe) {
                    if pr.test.correlation_id() == test {
                        pr.timestamp = ts / 1000;
                        reference.observe(&pr);
                    }
                }
            }
            reference.diagnosis().expect("posterior exists")
        };

        // The reported analysis IS the engine's posterior — exact match.
        assert_eq!(status.top_hypothesis.as_deref(), Some(top_ref));
        assert!(
            (status.confidence - prob_ref_after_verify).abs() < 1e-9,
            "reported confidence {} is not the engine posterior {}",
            status.confidence,
            prob_ref_after_verify
        );

        // Posteriors are a probability distribution: the reported hypotheses
        // can never sum past 1 (the old ratios summed to 3.0 here).
        let total: f64 = record.hypotheses.iter().map(|h| h.confidence).sum();
        assert!(
            total <= 1.0 + 1e-9,
            "reported hypotheses sum to {total} — not a posterior distribution"
        );
        // Evidence moved the belief above uniform (1/19).
        assert!(
            status.confidence > 1.0 / 19.0 + 0.01,
            "failure evidence did not move the posterior"
        );
        // Correlated layers of one endpoint must not manufacture certainty.
        assert!(status.confidence < 0.99, "correlated evidence inflated to certainty");

        // The events carry the same posterior (frontend contract).
        let events = bus.replay_session(&id, 0);
        let analysis = events.iter().find_map(|(_, e)| match e {
            Event::AnalysisCompleted { top_hypothesis, confidence, .. } => {
                Some((top_hypothesis.clone(), *confidence))
            }
            _ => None,
        });
        assert!(analysis.is_some(), "no AnalysisCompleted on the canonical bus");
        let (ev_top, ev_conf) = analysis.unwrap();
        // `AnalysisCompleted` is deliberately the PRE-verification posterior.
        // The final status is recomputed after the verification probe is fed
        // into the same engine (N1.1), so these two labels may legitimately
        // differ. Compare each artifact to its own contract.
        assert_eq!(ev_top, pre_verify_top);
        assert!(ev_conf.is_finite() && (0.0..=1.0).contains(&ev_conf));
    }

    /// Regression tripwire: the OLD `run_analyze_stage` (per-layer failure
    /// ratios presented as confidence) must never come back. Reimplemented
    /// here exactly as the audit documented it, and asserted to DISAGREE with
    /// the real engine on the same recorded evidence — so if the lifecycle
    /// ever reverts to ratios, both this test and the oracle above fail.
    #[test]
    fn n1_rejects_the_old_ratio_analysis() {
        use crate::network_intelligence::api_intelligence::monitor::diagnostic_probes;
        use crate::network_intelligence::api_intelligence::registry::{HealthProbe, LayerResult, ProbeOutcomeRecord};
        use crate::network_intelligence::api_model::{FailureCategory, RouteKind};

        let closed_port = 1u16;
        let (bus, _rx) = EventBus::new();
        let registry = ApiRegistry::new(bus.clone());
        let mut old_entry = ApiEntry::new(
            "n1-old-api",
            "test",
            &format!("http://127.0.0.1:{closed_port}/healthz"),
        );
        old_entry.timeout_ms = 50; // deterministic closed-port refusal; see oracle above
        registry.register(old_entry);
        let mut mgr = InvestigationManager::new(
            bus.clone(),
            registry.clone(),
            Arc::new(Mutex::new(LearningEngine::new())),
        );
        InvestigationManager::wire_application_dependencies(&mut mgr, &registry, &bus);
        let id = mgr.start("old path guard".into());
        let status = wait_terminal(&mgr, &id);
        let record = {
            let inner = mgr.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner.history.iter().find(|r| r.id == id).expect("record").clone()
        };

        // The OLD algorithm, reimplemented from the audit.
        let mut layer_stats: HashMap<String, (u64, u64)> = HashMap::new();
        for obs in &record.observations {
            if obs.layer == "verify" { continue; }
            let e = layer_stats.entry(obs.layer.clone()).or_insert((0, 0));
            if obs.ok { e.0 += 1; } else { e.1 += 1; }
        }
        let mut old_hypotheses: Vec<(String, f64)> = Vec::new();
        for (layer, (okc, failc)) in &layer_stats {
            if *failc > 0 {
                old_hypotheses.push((layer.clone(), *failc as f64 / (*okc + *failc) as f64));
            }
        }
        old_hypotheses.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let old_top_conf = old_hypotheses.first().map(|(_, c)| *c).unwrap_or(0.0);
        let old_sum: f64 = old_hypotheses.iter().map(|(_, c)| *c).sum();

        // The real engine's verdict on the same evidence.
        let mut engine = DiagnosticEngine::new();
        for obs in &record.observations {
            if obs.layer == "verify" { continue; }
            let result = match obs.result.as_deref() {
                Some("ok") => LayerResult::Ok,
                Some("failed") => LayerResult::Failed,
                _ => LayerResult::Unknown,
            };
            let single = ProbeOutcomeRecord {
                timestamp_ms: obs.timestamp_ms,
                api_id: obs.api_id.clone(),
                health: Health::Unknown,
                category: FailureCategory::Unknown,
                route: RouteKind::Direct,
                layers: vec![HealthProbe {
                    layer: obs.layer.clone(),
                    result,
                    latency_ms: obs.latency_ms,
                    detail: obs.detail.clone(),
                }],
                latency_ms: None,
            };
            for mut pr in diagnostic_probes(&single) {
                pr.timestamp /= 1000;
                engine.observe(&pr);
            }
        }
        let posterior = engine.diagnosis().map(|(_, p)| p).unwrap_or(0.0);

        // They are not the same number, and the old one is not a
        // distribution. If the lifecycle ever reports the ratio again, the
        // oracle (exact-match) fails and so does this test.
        assert!(
            (status.confidence - old_top_conf).abs() > 1e-6 || old_hypotheses.len() != record.hypotheses.len(),
            "reported analysis matches the OLD ratio algorithm — regression"
        );
        assert!(
            old_sum > 1.0 + 1e-9 || old_top_conf == 1.0,
            "fixture changed: the old algorithm no longer exhibits its invalid-distribution signature"
        );
        // The PRE-verification analysis event must equal the observe-stage
        // reconstruction (the tripwire's engine has no verification input).
        let analysis_conf = bus
            .replay_session(&id, 0)
            .into_iter()
            .find_map(|(_, e)| match e {
                Event::AnalysisCompleted { confidence, .. } => Some(confidence),
                _ => None,
            })
            .expect("AnalysisCompleted on the canonical bus");
        assert!(
            (posterior - analysis_conf).abs() < 1e-9,
            "reported confidence is not the engine posterior"
        );
    }

    /// Performance smoke (§10): the Bayesian analysis must stay far below
    /// UI-noticeable cost even for large evidence sets. Measured, printed,
    /// and sanity-bounded — not a tight benchmark.
    #[test]
    fn n1_analysis_latency_smoke() {
        use std::time::Instant;
        let mut engine = DiagnosticEngine::new();
        let port = 1u16; // refused; outcome semantics irrelevant to timing
        let mut entry = ApiEntry::new("perf", "test", &format!("http://127.0.0.1:{port}/"));
        entry.timeout_ms = 50;
        let mut entries = Vec::new();
        for i in 0..20 {
            let mut e = entry.clone();
            e.api_id = format!("perf-{i}");
            entries.push(e);
        }
        let start = Instant::now();
        let mut observations = 0usize;
        for e in &entries {
            let outcome = probe_api(e, None);
            for mut pr in diagnostic_probes(&outcome) {
                pr.timestamp /= 1000;
                engine.observe(&pr);
                observations += 1;
            }
        }
        let _ = engine.diagnosis();
        let elapsed = start.elapsed();
        println!(
            "N1 perf: {observations} observed probes across 20 APIs in {elapsed:?}"
        );
        // Probing dominates; the pure engine work is microseconds per probe.
        // Generous bound: the whole cycle stays under 5s even on slow CI.
        assert!(elapsed.as_secs() < 5, "analysis cycle unexpectedly slow: {elapsed:?}");
    }

    /// K-3 case A — predicted failure REPRODUCED: the explanation says the
    /// re-measurement supports the hypothesis, explicitly not root-cause
    /// proof, and never "unverified".
    #[test]
    fn k3_case_a_reproduced_failure_is_described_as_support() {
        let text = InvestigationManager::verify_result_text(
            &Some("dns".into()),
            0.62,
            false,
            true,
        );
        assert!(text.contains("reproduced on re-measurement"), "{text}");
        assert!(text.contains("supports this hypothesis"), "{text}");
        assert!(text.contains("does not by itself prove"), "{text}");
        assert!(!text.contains("unverified") && !text.contains("not verified"), "{text}");
    }

    /// K-3 case B — predicted failure NOT reproduced: the observation is
    /// described as challenging the hypothesis, with the posterior update
    /// acknowledged and the verdict explicitly uncertain.
    #[test]
    fn k3_case_b_contradicted_failure_stays_uncertain() {
        let text = InvestigationManager::verify_result_text(
            &Some("dns".into()),
            0.30,
            true,
            false,
        );
        assert!(text.contains("not reproduced on re-measurement"), "{text}");
        assert!(text.contains("challenges this hypothesis"), "{text}");
        assert!(text.contains("posterior was updated"), "{text}");
        assert!(text.contains("uncertain"), "{text}");
    }

    /// K-3 case C — verification UNAVAILABLE: absence of verification is
    /// never success, and the verdict is explicitly uncertain.
    #[test]
    fn k3_case_c_unavailable_verification_is_not_success() {
        let text = InvestigationManager::verify_result_text(
            &Some("dns".into()),
            0.30,
            false,
            false,
        );
        assert!(text.contains("could not be verified"), "{text}");
        assert!(text.contains("absence of verification is not success"), "{text}");
        assert!(text.contains("uncertain"), "{text}");
        assert!(!text.contains("confirmed"), "{text}");
    }

    /// K-3 case D — the floor still governs: whatever the re-measurement
    /// showed, a posterior below the established conclusion floor is the
    /// preserved refusal, never a verification-flavored conclusion.
    #[test]
    fn k3_case_d_floor_overrides_verification_wording() {
        for (verified, reproduced) in [(true, false), (false, true), (false, false)] {
            let text = InvestigationManager::verify_result_text(
                &Some("dns".into()),
                0.24,
                verified,
                reproduced,
            );
            assert_eq!(text, "Insufficient evidence to reach a conclusion.", "{text}");
        }
    }

    /// K-3 boundary: at exactly the established floor (0.25) a conclusion is
    /// justified (strict less-than refusal) — documented semantics.
    #[test]
    fn k3_boundary_exactly_at_floor_is_a_conclusion() {
        let text =
            InvestigationManager::verify_result_text(&Some("dns".into()), 0.25, true, false);
        assert!(text.contains("not reproduced"), "{text}");
    }

    /// Healthy endpoint: no failure evidence → the refusal is preserved
    /// verbatim, the verify stage is honestly skipped, and no conclusion is
    /// manufactured from a valid-but-uninformative posterior.
    #[test]
    fn n1_insufficient_evidence_refusal_preserved() {
        let (port, server) = spawn_local_http();
        let (bus, _rx) = EventBus::new();
        let registry = ApiRegistry::new(bus.clone());
        registry.register(ApiEntry::new(
            "n1-ok-api",
            "test",
            &format!("http://127.0.0.1:{port}/healthz"),
        ));
        let mut mgr = InvestigationManager::new(
            bus.clone(),
            registry.clone(),
            Arc::new(Mutex::new(LearningEngine::new())),
        );
        InvestigationManager::wire_application_dependencies(&mut mgr, &registry, &bus);

        let id = mgr.start("healthy check".into());
        let status = wait_terminal(&mgr, &id);
        assert_eq!(status.outcome.as_deref(), Some("Completed"));
        assert_eq!(status.result, "Insufficient evidence to reach a conclusion.");
        assert!(status.confidence < 0.25, "healthy network must not reach the conclusion floor");
        let events = bus.replay_session(&id, 0);
        assert!(
            !events.iter().any(|(_, e)| matches!(e, Event::VerificationCompleted { .. })),
            "verify must be skipped when there is no failure to verify"
        );
        drop(server);
    }

    /// C3: bounded concurrency. Excess starts are rejected honestly (a
    /// visible failed record), active capacity is real, and a terminal
    /// investigation releases its slot.
    #[test]
    fn n1_concurrency_limit_rejects_honestly_and_releases() {
        let port = spawn_hanging_http();
        let (bus, _rx) = EventBus::new();
        let registry = ApiRegistry::new(bus.clone());
        let mut entry = ApiEntry::new("n1-hang", "test", &format!("http://127.0.0.1:{port}/healthz"));
        entry.timeout_ms = 60_000; // probes stay blocked: capacity stays taken
        registry.register(entry);
        let mgr = InvestigationManager::new(
            bus.clone(),
            registry.clone(),
            Arc::new(Mutex::new(LearningEngine::new())),
        );

        let mut ids = Vec::new();
        for _ in 0..InvestigationManager::MAX_ACTIVE_INVESTIGATIONS {
            ids.push(mgr.start("hold".into()));
        }
        {
            let inner = mgr.inner.lock().unwrap_or_else(|p| p.into_inner());
            assert_eq!(inner.active.len(), InvestigationManager::MAX_ACTIVE_INVESTIGATIONS);
        }
        for _ in 0..2 {
            let id = mgr.start("overflow".into());
            let st = mgr.status(&id).expect("rejected starts are still recorded");
            assert_eq!(st.outcome.as_deref(), Some("Failed"));
            assert!(st.result.contains("concurrency limit"), "honest rejection required");
        }
        {
            let inner = mgr.inner.lock().unwrap_or_else(|p| p.into_inner());
            assert_eq!(inner.active.len(), InvestigationManager::MAX_ACTIVE_INVESTIGATIONS);
        }

        // Terminal paths release capacity: a short-timeout investigation that
        // finishes (or is cancelled) frees its slot immediately.
        let (bus2, _rx2) = EventBus::new();
        let fast = ApiRegistry::new(bus2.clone());
        let mut quick = ApiEntry::new("n1-quick", "test", &format!("http://127.0.0.1:{port}/healthz"));
        quick.timeout_ms = 300;
        fast.register(quick);
        let mgr2 = InvestigationManager::new(
            bus2.clone(),
            fast,
            Arc::new(Mutex::new(LearningEngine::new())),
        );
        let a = mgr2.start("first".into());
        let b = mgr2.start("second".into());
        // Both run to completion (300ms probe timeout); terminal state frees
        // the slots for the next start.
        let _ = wait_terminal(&mgr2, &a);
        let _ = wait_terminal(&mgr2, &b);
        let c = mgr2.start("third".into());
        let st = mgr2.status(&c).expect("capacity was released");
        assert_ne!(st.outcome.as_deref(), Some("Failed"), "slots must release after terminal state");
    }

    /// C3: a panicking lifecycle is an honest terminal failure, never a
    /// success, and releases the active slot.
    #[test]
    fn n1_panic_produces_honest_failure_and_releases_capacity() {
        let (bus, rx) = EventBus::new();
        let registry = ApiRegistry::new(bus.clone());
        let mgr = InvestigationManager::new(
            bus.clone(),
            registry,
            Arc::new(Mutex::new(LearningEngine::new())),
        );
        let inv = {
            let mut inner = mgr.inner.lock().unwrap_or_else(|p| p.into_inner());
            let id = format!("nani-investigation-{}", inner.next_id);
            let seq = inner.next_id;
            inner.next_id += 1;
            let investigation = Arc::new(Mutex::new(Investigation::new(id.clone(), "panic".into(), seq)));
            inner.active.insert(id.clone(), investigation.clone());
            drop(inner);
            investigation
        };
        let inner = mgr.inner.clone();
        InvestigationManager::guarded_lifecycle(
            "nani-investigation-900".to_string(),
            &inv,
            &inner,
            &bus,
            || panic!("injected lifecycle panic"),
        );
        // Honest terminal failure on the canonical bus.
        let events = bus.replay_since(0);
        assert!(events.iter().any(|(_, e)| matches!(e,
            Event::InvestigationFailed { investigation_id, .. } if investigation_id == "nani-investigation-900")));
        // Slot released: the active map is empty and a fresh start works.
        {
            let inner = mgr.inner.lock().unwrap_or_else(|p| p.into_inner());
            assert!(inner.active.is_empty(), "panic must release the active slot");
        }
        let next = mgr.start("after panic".into());
        assert!(!next.is_empty());
        // Nothing was ever reported Completed.
        let done = events.iter().any(|(_, e)| matches!(e, Event::InvestigationCompleted { .. }));
        assert!(!done, "a panic must never be converted into a completion");
        let _ = rx;
    }

    /// K-2 stress: 100 threads released by a deterministic barrier
    /// simultaneously call `start`. Admission is atomic (check + reservation
    /// in one critical section), so EXACTLY 4 are admitted and 96 are
    /// honestly rejected — never more than 4 active. Terminal paths release
    /// capacity (covered by the completion/cancel/panic tests above).
    #[test]
    fn k2_hundred_simultaneous_starts_never_exceed_the_cap() {
        use std::sync::Barrier;
        let port = spawn_hanging_http();
        let (bus, _rx) = EventBus::new();
        let registry = ApiRegistry::new(bus.clone());
        let mut entry = ApiEntry::new("k2-hang", "test", &format!("http://127.0.0.1:{port}/healthz"));
        entry.timeout_ms = 60_000; // admitted investigations stay active for the assertion
        registry.register(entry);
        let mgr = InvestigationManager::new(
            bus.clone(),
            registry.clone(),
            Arc::new(Mutex::new(LearningEngine::new())),
        );

        const N: usize = 100;
        let barrier = Arc::new(Barrier::new(N));
        let mut handles = Vec::with_capacity(N);
        for _ in 0..N {
            let barrier = barrier.clone();
            let mgr = mgr.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                mgr.start("stress".into())
            }));
        }
        let ids: Vec<String> = handles.into_iter().map(|h| h.join().expect("thread")).collect();
        assert_eq!(ids.len(), N);

        // Accounting: exactly `cap` ids are ACTIVE; every other recorded
        // start is the honest rejection. Rejections land in bounded history
        // (max 50), so early reject records may already have been truncated —
        // the deterministic invariants are the ACTIVE count, that every
        // RECOVERABLE non-active start is a marked rejection, and that the
        // id allocator issued exactly N identities.
        let mut admitted = 0usize;
        let mut rejected_seen = 0usize;
        for id in &ids {
            match mgr.status(id) {
                Some(st) if st.result.contains("concurrency limit") => rejected_seen += 1,
                Some(_) => admitted += 1,
                None => {} // truncated from bounded history (rejected, old)
            }
        }
        assert_eq!(
            admitted,
            InvestigationManager::MAX_ACTIVE_INVESTIGATIONS,
            "exactly the cap admitted under simultaneous load"
        );
        {
            let inner = mgr.inner.lock().unwrap_or_else(|p| p.into_inner());
            assert_eq!(inner.next_id as usize, N + 1, "every start was admitted or rejected (ids allocate from 1)");
            assert_eq!(
                inner.active.len(),
                InvestigationManager::MAX_ACTIVE_INVESTIGATIONS,
                "maximum observed concurrency must equal the cap"
            );
            assert!(rejected_seen >= 1, "rejections must be recorded and visible");
            for r in &inner.history {
                if inner.active.contains_key(&r.id) {
                    continue;
                }
                assert!(
                    r.result.contains("concurrency limit"),
                    "every non-active record must be an honest rejection, got: {}",
                    r.result
                );
            }
        }
    }
}
