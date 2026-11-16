//! Tauri IPC commands for NANI.
//!
//! The desktop frontend primarily consumes NANI events through Tauri's native
//! event system (`app.emit("nani:event", ...)` from Rust,
//! `window.__TAURI__.event.listen("nani:event", …)` from JS). In web mode
//! (no Tauri IPC), the frontend polls [`nani_poll_events`] instead.
//!
//! Commands are narrow and side-effect free where possible.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

use crate::network_intelligence::ai::explanation::ExplanationFacts;
use crate::network_intelligence::ai::{AiStatus, Explanation, LocalLlm};
use crate::network_intelligence::api_intelligence::monitor::probe_api;
use crate::network_intelligence::api_intelligence::monitor::diagnostic_probes;
use crate::network_intelligence::api_intelligence::registry::{ApiRegistry, Health};
use crate::network_intelligence::events::{Event, EventBus};
use crate::network_intelligence::context::context_identity::ContextSignals;
use crate::network_intelligence::context::engine::{
    PersonalizationStatus, TransitionRecord,
};
use crate::network_intelligence::foundation::NaniMathEngine;
use crate::network_intelligence::foundation::HypothesisView;
use crate::network_intelligence::investigation::InvestigationManager;
use crate::network_intelligence::learning::{LearningEngine, LearningStatus};
use crate::network_intelligence::persistence::PersistenceStore;
use crate::network_intelligence::recovery::RecoveryPlanner;

/// Managed NANI state, wired in `main.rs`.
///
/// `events` starts as `None` and is populated (with the AppHandle) during
/// `main.rs` setup, because the AppHandle is not available at builder time.
pub struct NaniState {
    pub events: Mutex<Option<EventBus>>,
    /// Persistent observation journal + model state.
    pub persistence: Mutex<PersistenceStore>,
    /// Centralized API registry + current per-API state.
    pub registry: Mutex<ApiRegistry>,
    /// Recovery planner shared with the background monitor loop.
    pub recovery: Arc<Mutex<RecoveryPlanner>>,
    /// Phase 4 local learning: measurements, profiles, reliability, drift.
    pub learning: Arc<Mutex<LearningEngine>>,
    /// Investigation lifecycle manager (start/cancel/status/history).
    pub investigations: Arc<Mutex<InvestigationManager>>,
    /// Optional local language model. Disabled unless explicitly configured.
    pub ai: Mutex<LocalLlm>,
    /// Unified mathematical engine (foundation + information theory).
    pub math: Arc<Mutex<NaniMathEngine>>,
    /// Internal control-plane subscriber (receiver half of the bus channel).
    /// Held so the channel stays alive; consumed by a background task in Stage 5.
    pub events_rx: Mutex<Option<std::sync::mpsc::Receiver<Event>>>,
}

/// Snapshot returned to the frontend on init / poll.
#[derive(Clone, Serialize)]
pub struct NaniStatus {
    pub seq: u64,
    pub healthy_apis: usize,
    pub total_apis: usize,
    pub recovery_active: bool,
    pub drift_detected: bool,
}

/// One catch-up slice of the replay buffer.
#[derive(Serialize)]
pub struct EventReplaySlice {
    /// Newest sequence the bus has emitted (0 when it has none).
    pub latest_seq: u64,
    /// Oldest sequence still retained in the bounded buffer.
    pub oldest_seq: u64,
    /// True when `since` could not be honoured: the buffer evicted unseen events
    /// or the bus restarted. `events` then holds the whole retained buffer.
    pub gap: bool,
    /// `{ seq, event }` envelopes, oldest first — the same shape the live
    /// `nani:event` channel emits, so one parser handles both.
    pub events: Vec<serde_json::Value>,
}

/// Poll for NANI events (web-mode fallback; desktop also uses Tauri events).
///
/// `since` is the last sequence the caller applied. Omit it for a full (bounded)
/// replay; pass it for incremental catch-up, which returns only events the
/// caller has not seen and never re-sends the whole buffer just to be safe.
#[tauri::command]
pub fn nani_poll_events(state: State<'_, NaniState>, since: Option<u64>) -> EventReplaySlice {
    let events = state.events.lock().unwrap_or_else(|p| p.into_inner());
    let Some(bus) = events.as_ref() else {
        return EventReplaySlice {
            latest_seq: 0,
            oldest_seq: 0,
            gap: false,
            events: Vec::new(),
        };
    };
    let (slice, gap) = match since {
        Some(since_seq) => bus.catch_up(since_seq),
        None => (bus.replay_since(0), false),
    };
    EventReplaySlice {
        latest_seq: bus.seq(),
        oldest_seq: bus.oldest_seq(),
        gap,
        events: slice
            .into_iter()
            .map(|(seq, event)| {
                serde_json::json!({
                    "seq": seq,
                    "event": serde_json::to_value(&event).unwrap_or(serde_json::Value::Null),
                })
            })
            .collect(),
    }
}

/// Start a new NANI investigation. Runs the observe → analyze → verify
/// lifecycle on a background thread and emits lifecycle events on the `nani:event`
/// channel. Returns the investigation id immediately.
#[tauri::command]
pub fn nani_start_investigation(state: State<'_, NaniState>, query: String) -> Result<String, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("investigation query is required".into());
    }
    if query.chars().count() > 500 {
        return Err("investigation query is too long (maximum 500 characters)".into());
    }
    let inv = state.investigations.lock().unwrap_or_else(|p| p.into_inner());
    Ok(inv.start(query.to_string()))
}

/// Cancel an in-flight investigation by id. Returns true when cancellation was
/// requested for a running investigation.
#[tauri::command]
pub fn nani_cancel_investigation(state: State<'_, NaniState>, investigation_id: String) -> Result<bool, String> {
    let inv = state.investigations.lock().unwrap_or_else(|p| p.into_inner());
    Ok(inv.cancel(&investigation_id))
}

/// Status snapshot for one investigation (active or historical).
#[tauri::command]
pub fn nani_investigation_status(state: State<'_, NaniState>, investigation_id: String) -> Result<Option<serde_json::Value>, String> {
    let inv = state.investigations.lock().unwrap_or_else(|p| p.into_inner());
    let st = inv.status(&investigation_id);
    Ok(st.map(|s| serde_json::to_value(&s).unwrap_or(serde_json::Value::Null)))
}

/// List all investigations (active + history), most recent first.
#[tauri::command]
pub fn nani_investigations(state: State<'_, NaniState>) -> Result<Vec<serde_json::Value>, String> {
    let inv = state.investigations.lock().unwrap_or_else(|p| p.into_inner());
    let list = inv.list();
    Ok(list
        .into_iter()
        .map(|s| serde_json::to_value(&s).unwrap_or(serde_json::Value::Null))
        .collect())
}

/// Current NANI status snapshot.
#[tauri::command]
pub fn nani_status(state: State<'_, NaniState>) -> NaniStatus {
    let events = state.events.lock().unwrap_or_else(|p| p.into_inner());
    let seq = events.as_ref().map(|b| b.seq()).unwrap_or(0);

    let registry = state.registry.lock().unwrap_or_else(|p| p.into_inner());
    let ids = registry.ids();
    let total = ids.len();
    let healthy = ids
        .iter()
        .filter(|id| {
            registry
                .state(id)
                .is_some_and(|s| s.health == Health::Healthy)
        })
        .count();

    let recovery = state.recovery.lock().unwrap_or_else(|p| p.into_inner());
    let recovery_active = recovery.active_plan.is_some() && !recovery.is_complete();

    NaniStatus {
        seq,
        healthy_apis: healthy,
        total_apis: total,
        recovery_active,
        drift_detected: false,
    }
}

/// Phase 4 learning status. Reports only counts and the global prior; no raw
/// measurements, targets, or personal data leave the engine.
#[tauri::command]
pub fn nani_learning_status(state: State<'_, NaniState>) -> LearningStatus {
    state
        .learning
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .status()
}

/// Drift events recorded by local learning (bounded history).
#[tauri::command]
pub fn nani_learning_drift(state: State<'_, NaniState>) -> Vec<serde_json::Value> {
    state
        .learning
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .drift_events()
        .into_iter()
        .filter_map(|e| serde_json::to_value(&e).ok())
        .collect()
}

/// User-initiated: delete all per-context profiles, episodes and drift history.
/// Returns the number of episodes removed.
#[tauri::command]
pub fn nani_learning_reset(state: State<'_, NaniState>) -> Result<usize, String> {
    Ok(state
        .learning
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .reset_personalization())
}

/// Network-personalization status. Only counts and confidence leave the
/// engine; no raw measurements, SSIDs, or addresses are exposed.
#[tauri::command]
pub fn nani_personalization_status(
    state: State<'_, NaniState>,
) -> PersonalizationStatus {
    state
        .learning
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .personalization_status()
}

/// Bounded network transition history (local profile ids only).
#[tauri::command]
pub fn nani_personalization_transitions(
    state: State<'_, NaniState>,
) -> Vec<TransitionRecord> {
    state
        .learning
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .context_transitions()
}

/// Observe privacy-safe network signals and select/create the local profile.
/// Returns `none`, `new`, or `switch`. A transition is not a failure.
#[tauri::command]
pub fn nani_context_observe(
    state: State<'_, NaniState>,
    signals: ContextSignals,
) -> String {
    state
        .learning
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .observe_network(&signals)
}

/// User-initiated deletion of one local profile.
#[tauri::command]
pub fn nani_personalization_delete(
    state: State<'_, NaniState>,
    context_id: u64,
) -> bool {
    state
        .learning
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .delete_context(context_id)
}

/// Manually trigger a health check across all registered APIs (desktop only;
/// web mode delegates to the same-origin deployment).
#[tauri::command]
pub fn nani_health_check_all(state: State<'_, NaniState>) -> Result<String, String> {
    let registry = state.registry.lock().unwrap_or_else(|p| p.into_inner());
    let ids: Vec<String> = registry.ids();
    let mut checked = 0usize;
    let mut healthy = 0usize;

    for api_id in ids {
        let Some(entry) = registry.entry(&api_id) else {
            continue;
        };
        let outcome = probe_api(&entry, None);
        registry.record_probe(&outcome);
        // Feed the measured layers into the Bayesian diagnosis so priors and
        // posteriors describe real probes instead of staying at the initial
        // uniform distribution forever.
        {
            let probes = diagnostic_probes(&outcome);
            let mut math = state
                .math
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            for probe in &probes {
                math.observe_probe(probe);
            }
        }
        checked += 1;
        if outcome.health == Health::Healthy {
            healthy += 1;
        }
    }

    Ok(format!(
        "health_check_complete: {healthy}/{checked} healthy"
    ))
}

/// Optional local language-model status. Reports configuration only, never a
/// model path's contents. The deterministic engine works with this disabled.
#[tauri::command]
pub fn nani_ai_status(state: State<'_, NaniState>) -> AiStatus {
    state
        .ai
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .status()
}

/// Explain the current NANI state in plain language.
///
/// The mathematical engine builds every fact. The optional local model may
/// only rewrite that text; it cannot change a diagnosis or recommend an
/// unauthorized action. With the model off, the deterministic explanation is
/// returned unchanged.
#[tauri::command]
pub async fn nani_explain(app: AppHandle, question: String) -> Result<Explanation, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("question is required".into());
    }
    if question.chars().count() > 500 {
        return Err("question is too long (maximum 500 characters)".into());
    }
    let question = question.to_string();
    let state = app.state::<NaniState>();

    let facts = {
        let registry = state.registry.lock().unwrap_or_else(|p| p.into_inner());
        let states = registry.states();
        let healthy = states.iter().filter(|s| s.health == Health::Healthy).count();
        let total = states.len();
        let learning = state.learning.lock().unwrap_or_else(|p| p.into_inner());
        let status = learning.status();

        let mut observed: Vec<String> = states
            .iter()
            .take(12)
            .map(|s| {
                format!(
                    "{}: {:?}, last category {:?}, {} consecutive failures",
                    s.api_id, s.health, s.last_category, s.consecutive_failures
                )
            })
            .collect();
        if observed.is_empty() {
            observed.push("no API probes have been recorded yet".into());
        }
        if status.measurements_accepted > 0 {
            observed.push(format!(
                "{} accepted local measurements, {} rejected",
                status.measurements_accepted, status.measurements_rejected
            ));
        }

        let mut inferred = vec![format!(
            "NANI has {} of {} monitored APIs healthy; global reliability prior {:.2}",
            healthy, total, status.global_reliability
        )];
        if status.drift_events > 0 {
            inferred.push(format!(
                "{} distribution-change events are recorded; inspect them before assuming a fault",
                status.drift_events
            ));
        }
        if healthy == 0 && total > 0 {
            inferred.push(
                "no monitored API is healthy; the evidence points to a shared or local fault, but the cause is not yet isolated"
                    .into(),
            );
        } else if total > 0 && healthy < total {
            inferred.push(
                "some APIs are unhealthy while others answer, which argues against a total local outage"
                    .into(),
            );
        }

        let next_step = if total == 0 || status.measurements_accepted == 0 {
            "Run a NANI health check to collect verified measurements.".to_string()
        } else if healthy < total {
            "Inspect the failing API's last failure category, then run one targeted probe before any recovery action."
                .to_string()
        } else {
            "No action is required; continue monitoring for drift.".to_string()
        };

        ExplanationFacts {
            question,
            observed,
            inferred,
            confidence: None,
            next_step,
        }
    };

    let llm = state
        .ai
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::network_intelligence::ai::explanation::explain(&llm, &facts)
    })
    .await
    .map_err(|e| format!("explanation task failed: {e}"))
}

/// Current diagnostic entropy (nats) — higher = more uncertain.
#[tauri::command]
pub fn nani_math_entropy(state: State<'_, NaniState>) -> f64 {
    state
        .math
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .diagnostic_entropy()
}

/// Ranked diagnostic hypotheses with probabilities.
#[tauri::command]
pub fn nani_math_rank_hypotheses(state: State<'_, NaniState>) -> Vec<(String, f64)> {
    state
        .math
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .ranked_hypotheses()
        .into_iter()
        .map(|(label, prob)| (label.to_string(), prob))
        .collect()
}

/// Select the best diagnostic probe to run next by expected IG/cost.
#[tauri::command]
pub fn nani_math_select_probe(state: State<'_, NaniState>) -> Option<crate::network_intelligence::foundation::ProbeSelection> {
    state
        .math
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .select_best_probe()
}

/// Hypothesis space as displayed: every posterior with its prior, the current
/// entropy, and the selected probe's expected information gain.
#[tauri::command]
pub fn nani_math_hypothesis_view(state: State<'_, NaniState>) -> HypothesisView {
    state
        .math
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .hypothesis_view()
}

/// Sequential stopping rule: should we stop diagnostic testing?
#[tauri::command]
pub fn nani_math_should_stop(
    state: State<'_, NaniState>,
    entropy_threshold: f64,
    confidence_target: f64,
) -> bool {
    state
        .math
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .should_stop_testing(entropy_threshold, confidence_target)
}

/// Drift analysis across all registered CUSUM and Page-Hinkley detectors.
#[tauri::command]
pub fn nani_math_drift_analysis(state: State<'_, NaniState>) -> Vec<crate::network_intelligence::foundation::DriftAnalysis> {
    state
        .math
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .drift_analyses()
}

/// Changepoint analysis across all registered Bayesian Online CPD detectors.
#[tauri::command]
pub fn nani_math_changepoint_analysis(state: State<'_, NaniState>) -> Vec<crate::network_intelligence::foundation::ChangepointAnalysis> {
    state
        .math
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .changepoint_analyses()
}

/// Mutual information I(X;Y) for a discrete joint distribution matrix.
#[tauri::command]
pub fn nani_math_mutual_information(
    p_xy: Vec<Vec<f64>>,
    p_x: Vec<f64>,
    p_y: Vec<f64>,
) -> Option<f64> {
    crate::network_intelligence::information_theory::mutual_information(&p_xy, &p_x, &p_y)
}
