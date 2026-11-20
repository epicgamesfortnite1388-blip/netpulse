//! Reactive event foundation for NANI.
//!
//! Every significant state transition (API health change, failure detected,
//! recovery step, circuit-breaker trip, drift detection, learning update) is
//! emitted as a typed [`Event`]. The [`EventBus`] is managed Tauri state that
//! fans each event out to:
//!   1. internal Rust subscribers (a `std::sync::mpsc` channel, for the
//!      control plane),
//!   2. the Tauri frontend via a native Tauri event (`nani:event`), so the UI
//!      reacts without polling.
//!
//! In web mode (no Tauri IPC), the frontend falls back to polling the replay
//! buffer. Events are serde-serializable and contain no secrets (no
//! authorization headers, cookies, tokens, or raw request bodies).

use serde::{Deserialize, Serialize};
use std::sync::{mpsc, Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// The NANI event channel name emitted to the Tauri frontend.
pub const NANI_EVENT_CHANNEL: &str = "nani:event";

/// Maximum events retained in the bounded replay buffer for late-joining
/// subscribers / poll-based web fallback.
const REPLAY_BUFFER: usize = 256;

/// All NANI event types. Add variants here when a new state transition needs
/// to be observable; do not reuse variants for unrelated transitions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "payload")]
pub enum Event {
    /// An API's health classification changed.
    ApiHealthChanged {
        api_id: String,
        previous: String,
        current: String,
        category: String,
        confidence: String,
    },
    /// A failure was detected (classified, not guessed).
    FailureDetected {
        api_id: String,
        category: String,
        confidence: String,
        summary: String,
    },
    /// Automatic recovery started for an API.
    RecoveryStarted { api_id: String, plan_id: String },
    /// A single recovery step completed.
    RecoveryStepCompleted {
        plan_id: String,
        step_id: String,
        success: bool,
    },
    /// Automatic recovery finished (succeeded or exhausted).
    RecoveryCompleted { api_id: String, plan_id: String, success: bool },
    /// A recovery was rolled back to the last known-good route.
    RecoveryRolledBack { api_id: String, plan_id: String },
    /// A route was selected for an API (direct or approved upstream).
    RouteSelected { api_id: String, route_id: String, reason: String },
    /// A circuit breaker tripped (stopped issuing requests).
    CircuitBreakerTripped { api_id: String },
    /// A circuit breaker recovered (half-open → closed after successes).
    CircuitBreakerRecovered { api_id: String },
    /// Drift detected in an observed metric.
    DriftDetected { metric: String, statistic: f64, threshold: f64 },
    /// The diagnostic hypothesis distribution changed.
    DiagnosisUpdated { hypotheses: Vec<(String, f64)> },
    /// A learning metric was updated (bandit/drift/calibration).
    LearningUpdate { metric: String, value: f64, context: String },
    /// Periodic telemetry snapshot (bounded frequency).
    TelemetryTick { timestamp_ms: u64, healthy_apis: usize, total_apis: usize },
    /// One health check finished for an API, whether or not its classification
    /// changed. `record_probe` reports transitions only, so a check that
    /// confirms the previous verdict would otherwise leave no trace at all.
    HealthCheckCompleted {
        api_id: String,
        health: String,
        category: String,
        /// How the HTTP leg reached the target: `direct` or `system-proxy-inferred`.
        /// Additive so older event consumers can ignore it.
        route: String,
        latency_ms: Option<f64>,
        healthy_layers: usize,
        total_layers: usize,
    },
    /// A user-initiated manual action completed.
    UserAction { action: String, api_id: Option<String>, success: bool },
    /// Investigation lifecycle — NANI command center sessions.
    InvestigationStarted {
        investigation_id: String,
        query: String,
        stage: String,
    },
    InvestigationUpdated {
        investigation_id: String,
        stage: String,
        detail: String,
    },
    InvestigationStageStarted {
        investigation_id: String,
        stage: String,
    },
    InvestigationStageCompleted {
        investigation_id: String,
        stage: String,
        ok: bool,
    },
    ObservationCreated {
        investigation_id: String,
        api_id: String,
        layer: String,
        ok: bool,
        latency_ms: Option<f64>,
    },
    ProbeStarted {
        investigation_id: String,
        api_id: String,
        layer: String,
    },
    ProbeCompleted {
        investigation_id: String,
        api_id: String,
        layer: String,
        ok: bool,
        latency_ms: Option<f64>,
    },
    EvidenceAdded {
        investigation_id: String,
        evidence_id: String,
        kind: String,
        source: String,
    },
    HypothesisCreated {
        investigation_id: String,
        hypothesis_id: String,
        hypothesis: String,
        confidence: f64,
    },
    HypothesisUpdated {
        investigation_id: String,
        hypothesis_id: String,
        hypothesis: String,
        confidence: f64,
    },
    AnalysisCompleted {
        investigation_id: String,
        top_hypothesis: Option<String>,
        confidence: f64,
        insufficient_evidence: bool,
    },
    VerificationCompleted {
        investigation_id: String,
        route_id: Option<String>,
        verified: bool,
    },
    InvestigationCompleted {
        investigation_id: String,
        result: String,
    },
    InvestigationFailed {
        investigation_id: String,
        reason: String,
    },
    InvestigationCancelled {
        investigation_id: String,
        reason: String,
    },
}

impl Event {
    /// The investigation that owns this event, if any.
    ///
    /// Used for session-scoped catch-up so one investigation's subscriber can
    /// never receive another's events. System-wide events (health, recovery,
    /// telemetry) return `None`.
    pub fn investigation_id(&self) -> Option<&str> {
        match self {
            Event::InvestigationStarted { investigation_id, .. }
            | Event::InvestigationUpdated { investigation_id, .. }
            | Event::InvestigationStageStarted { investigation_id, .. }
            | Event::InvestigationStageCompleted { investigation_id, .. }
            | Event::ObservationCreated { investigation_id, .. }
            | Event::ProbeStarted { investigation_id, .. }
            | Event::ProbeCompleted { investigation_id, .. }
            | Event::EvidenceAdded { investigation_id, .. }
            | Event::HypothesisCreated { investigation_id, .. }
            | Event::HypothesisUpdated { investigation_id, .. }
            | Event::AnalysisCompleted { investigation_id, .. }
            | Event::VerificationCompleted { investigation_id, .. }
            | Event::InvestigationCompleted { investigation_id, .. }
            | Event::InvestigationFailed { investigation_id, .. }
            | Event::InvestigationCancelled { investigation_id, .. } => Some(investigation_id),
            _ => None,
        }
    }
}

/// The event bus: unbounded mpsc channel + optional Tauri AppHandle for
/// frontend emission. Managed state, created once in `main.rs` setup.
#[derive(Debug, Clone)]
pub struct EventBus {
    inner: Arc<Mutex<EventBusInner>>,
}

#[derive(Debug)]
struct EventBusInner {
    /// Internal subscribers read from this channel (unbounded: send never
    /// blocks on a slow subscriber).
    tx: mpsc::Sender<Event>,
    /// Most recent events with their monotonic sequence, for late subscribers /
    /// poll fallback and reconnect catch-up.
    replay: Vec<(u64, Event)>,
    /// Tauri frontend emission target (None in web mode / before setup).
    app: Option<AppHandle>,
    /// Monotonic sequence so subscribers can detect gaps.
    seq: u64,
}

impl EventBus {
    /// Create a new bus with an internal channel. `app` is wired later by
    /// `set_app` (called from `main.rs` setup once the AppHandle exists).
    pub fn new() -> (Self, mpsc::Receiver<Event>) {
        let (tx, rx) = mpsc::channel();
        (
            Self {
                inner: Arc::new(Mutex::new(EventBusInner {
                    tx,
                    replay: Vec::new(),
                    app: None,
                    seq: 0,
                })),
            },
            rx,
        )
    }

    /// Test-only: does this bus share state with `other` (Arc identity)?
    #[cfg(test)]
    pub fn shares_state_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    /// Wire the Tauri AppHandle so events reach the frontend. Call once from
    /// `main.rs` setup after the AppHandle is available.
    pub fn set_app(&self, app: AppHandle) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.app = Some(app);
        }
    }

    /// Emit an event to internal subscribers and the Tauri frontend.
    pub fn emit(&self, event: Event) {
        let seq = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner.seq += 1;
            let s = inner.seq;
            // Bounded replay buffer (oldest dropped first).
            if inner.replay.len() >= REPLAY_BUFFER {
                inner.replay.drain(0..1);
            }
            inner.replay.push((s, event.clone()));
            // Unbounded channel: send never blocks on a slow subscriber.
            let _ = inner.tx.send(event.clone());
            s
        };
        // Tauri frontend emission (outside the lock). `emit` is sync; we
        // snapshot the AppHandle under the lock, then call it outside.
        let app = self.app_handle();
        if let Some(app) = app {
            let _ = app.emit(
                NANI_EVENT_CHANNEL,
                serde_json::json!({ "seq": seq, "event": serde_json::to_value(&event).unwrap_or(serde_json::Value::Null) }),
            );
        }
    }

    /// Sequence number of the most recently emitted event (for gap detection).
    pub fn seq(&self) -> u64 {
        self.inner.lock().map(|i| i.seq).unwrap_or(0)
    }

    /// Snapshot of the replay buffer (newest last).
    pub fn replay(&self) -> Vec<Event> {
        self.inner
            .lock()
            .map(|i| i.replay.iter().map(|(_, e)| e.clone()).collect())
            .unwrap_or_default()
    }

    /// Events strictly newer than `since_seq`, oldest first.
    ///
    /// Reconnect catch-up: a subscriber that remembers its last seen sequence
    /// asks for anything newer and therefore never re-applies an event it has
    /// already handled (reconnect dedupe).
    pub fn replay_since(&self, since_seq: u64) -> Vec<(u64, Event)> {
        self.inner
            .lock()
            .map(|i| {
                i.replay
                    .iter()
                    .filter(|(seq, _)| *seq > since_seq)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Oldest sequence still retained in the replay buffer (0 when empty).
    pub fn oldest_seq(&self) -> u64 {
        self.inner
            .lock()
            .map(|i| i.replay.first().map(|(s, _)| *s).unwrap_or(0))
            .unwrap_or(0)
    }

    /// Incremental catch-up from `since_seq`, for a subscriber that remembers
    /// the last sequence it applied.
    ///
    /// Returns `(events, gap)`:
    ///   - `events` is every retained event newer than `since_seq`, oldest first.
    ///   - `gap` is true when the caller cannot continue from its own sequence:
    ///     the bounded buffer evicted events it never saw, or the bus restarted
    ///     and its sequence went backwards. In that case `events` is the whole
    ///     retained buffer, so a single call is enough to rebuild — the caller
    ///     never has to make a second "full replay" request.
    pub fn catch_up(&self, since_seq: u64) -> (Vec<(u64, Event)>, bool) {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let latest = inner.seq;
        let oldest = inner.replay.first().map(|(s, _)| *s).unwrap_or(0);
        // Restart: the caller is ahead of this bus (fresh process, sequence
        // reset). Eviction: the oldest retained event is already past the
        // caller's next expected sequence.
        let restarted = since_seq > latest;
        let evicted = oldest > 0 && oldest > since_seq.saturating_add(1);
        let gap = restarted || evicted;
        let events: Vec<(u64, Event)> = if gap {
            inner.replay.clone()
        } else {
            inner
                .replay
                .iter()
                .filter(|(seq, _)| *seq > since_seq)
                .cloned()
                .collect()
        };
        (events, gap)
    }

    /// Investigation-scoped catch-up: only events owned by `investigation_id`
    /// and newer than `since_seq` (oldest first).
    ///
    /// Session ownership: a subscriber watching one investigation never sees
    /// another investigation's events, even when both share the bus.
    pub fn replay_session(&self, investigation_id: &str, since_seq: u64) -> Vec<(u64, Event)> {
        self.inner
            .lock()
            .map(|i| {
                i.replay
                    .iter()
                    .filter(|(seq, event)| {
                        *seq > since_seq
                            && event.investigation_id().is_some_and(|id| id == investigation_id)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    fn app_handle(&self) -> Option<AppHandle> {
        self.inner.lock().ok().and_then(|i| i.app.clone())
    }
}

impl Default for EventBus {
    fn default() -> Self {
        let (bus, _rx) = Self::new();
        bus
    }
}

/// Internal subscription handle: reads events off the bus channel.
#[derive(Debug)]
pub struct EventSubscription {
    rx: mpsc::Receiver<Event>,
    /// Sequence at subscription time (reserved; seq is not attached to events
    /// in this std-mpsc variant, so subscribers track `bus.seq()` separately).
    since_seq: u64,
}

impl EventSubscription {
    fn new(rx: mpsc::Receiver<Event>, since_seq: u64) -> Self {
        Self { rx, since_seq }
    }

    /// Block until the next event, or return None if the bus has been dropped.
    pub fn next(&mut self) -> Option<Event> {
        self.rx.recv().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn event_serializes_with_kind_tag() {
        let ev = Event::FailureDetected {
            api_id: "api-1".into(),
            category: "TLS failure".into(),
            confidence: "possible".into(),
            summary: "Possible cause: ...".into(),
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v.get("kind").and_then(|v| v.as_str()), Some("FailureDetected"));
    }

    #[test]
    fn replay_buffer_is_bounded() {
        let (bus, _rx) = EventBus::new();
        for i in 0..300 {
            bus.emit(Event::TelemetryTick {
                timestamp_ms: i,
                healthy_apis: 0,
                total_apis: 0,
            });
        }
        let replay = bus.replay();
        assert!(replay.len() <= REPLAY_BUFFER);
        assert!(replay.iter().any(|e| matches!(e, Event::TelemetryTick { timestamp_ms, .. } if *timestamp_ms == 299)));
    }

    #[test]
    fn seq_monotonically_increases() {
        let (bus, _rx) = EventBus::new();
        let s1 = bus.seq();
        bus.emit(Event::TelemetryTick {
            timestamp_ms: 0,
            healthy_apis: 0,
            total_apis: 0,
        });
        assert!(bus.seq() > s1);
    }

    #[test]
    fn json_payload_is_valid() {
        let ev = Event::RouteSelected {
            api_id: "xkiro".into(),
            route_id: "direct".into(),
            reason: "highest LCB success".into(),
        };
        let payload = json!({ "seq": 1u64, "event": ev });
        let _ = serde_json::to_string(&payload).unwrap();
    }

    fn stage_started(investigation_id: &str, stage: &str) -> Event {
        Event::InvestigationStageStarted {
            investigation_id: investigation_id.into(),
            stage: stage.into(),
        }
    }

    #[test]
    fn replay_since_preserves_sequence_order() {
        let (bus, _rx) = EventBus::new();
        for i in 0..5 {
            bus.emit(stage_started("inv-1", &format!("s{i}")));
        }
        let replayed = bus.replay_since(0);
        let seqs: Vec<u64> = replayed.iter().map(|(s, _)| *s).collect();
        assert_eq!(seqs, vec![1, 2, 3, 4, 5]);
        // Strictly increasing, no duplicates, no reordering.
        assert!(seqs.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn replay_since_dedupes_already_seen_events() {
        let (bus, _rx) = EventBus::new();
        for i in 0..4 {
            bus.emit(stage_started("inv-1", &format!("s{i}")));
        }
        // A subscriber that has handled seq 2 asks only for the rest.
        let catch_up = bus.replay_since(2);
        assert_eq!(catch_up.iter().map(|(s, _)| *s).collect::<Vec<_>>(), vec![3, 4]);
        // Repeating the same catch-up is idempotent: no duplicates, same set.
        let again = bus.replay_since(2);
        assert_eq!(
            catch_up.iter().map(|(s, _)| *s).collect::<Vec<_>>(),
            again.iter().map(|(s, _)| *s).collect::<Vec<_>>()
        );
        // Catching up to the head yields nothing (already applied).
        assert!(bus.replay_since(bus.seq()).is_empty());
    }

    #[test]
    fn replay_session_scopes_events_to_their_owner() {
        let (bus, _rx) = EventBus::new();
        bus.emit(stage_started("inv-a", "observe"));
        bus.emit(stage_started("inv-b", "observe"));
        bus.emit(Event::TelemetryTick {
            timestamp_ms: 1,
            healthy_apis: 1,
            total_apis: 1,
        });
        bus.emit(stage_started("inv-a", "analyze"));

        let a = bus.replay_session("inv-a", 0);
        assert_eq!(a.len(), 2);
        assert!(a.iter().all(|(_, e)| e.investigation_id() == Some("inv-a")));

        let b = bus.replay_session("inv-b", 0);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].1.investigation_id(), Some("inv-b"));

        // A follow-up scoped catch-up excludes events already seen.
        let a_after_first = bus.replay_session("inv-a", a[0].0);
        assert_eq!(a_after_first.len(), 1);
        assert_eq!(a_after_first[0].1.investigation_id(), Some("inv-a"));

        assert!(bus.replay_session("inv-missing", 0).is_empty());
    }

    #[test]
    fn system_events_have_no_investigation_owner() {
        let telemetry = Event::TelemetryTick {
            timestamp_ms: 0,
            healthy_apis: 0,
            total_apis: 0,
        };
        let failure = Event::FailureDetected {
            api_id: "api-1".into(),
            category: "tls".into(),
            confidence: "possible".into(),
            summary: "x".into(),
        };
        assert_eq!(telemetry.investigation_id(), None);
        assert_eq!(failure.investigation_id(), None);

        let (bus, _rx) = EventBus::new();
        bus.emit(telemetry);
        assert!(bus.replay_session("anything", 0).is_empty());
    }

    /// Once the ring buffer has evicted older events, a subscriber resuming
    /// from `0` receives only what is still retained. The order must stay
    /// intact, and the first retained sequence must be greater than `since + 1`
    /// so the client can detect that its catch-up is incomplete instead of
    /// assuming it missed nothing.
    #[test]
    fn replay_since_after_eviction_is_ordered_and_signals_the_gap() {
        let (bus, _rx) = EventBus::new();
        let total = REPLAY_BUFFER as u64 + 10;
        for i in 0..total {
            bus.emit(stage_started("inv-1", &format!("s{i}")));
        }

        let replayed = bus.replay_since(0);
        let seqs: Vec<u64> = replayed.iter().map(|(s, _)| *s).collect();

        assert_eq!(seqs.len(), REPLAY_BUFFER, "buffer is bounded");
        assert!(seqs.windows(2).all(|w| w[0] < w[1]), "order survives eviction");
        assert_eq!(*seqs.last().expect("non-empty"), total, "newest event is retained");
        assert_eq!(
            *seqs.first().expect("non-empty"),
            total - REPLAY_BUFFER as u64 + 1,
            "oldest retained sequence"
        );
        assert!(seqs[0] > 1, "a gap after eviction is visible to the caller");
    }

    #[test]
    fn catch_up_is_incremental_and_contiguous() {
        let (bus, _rx) = EventBus::new();
        for i in 0..5 {
            bus.emit(stage_started("inv-1", &format!("s{i}")));
        }

        let (events, gap) = bus.catch_up(3);
        assert!(!gap, "3 -> 5 is contiguous");
        assert_eq!(events.iter().map(|(s, _)| *s).collect::<Vec<_>>(), vec![4, 5]);

        // Nothing new: a poll must return an empty slice, not a replay.
        let (events, gap) = bus.catch_up(5);
        assert!(!gap);
        assert!(events.is_empty());
        assert_eq!(bus.seq(), 5);
        assert_eq!(bus.oldest_seq(), 1);
    }

    #[test]
    fn catch_up_after_eviction_returns_the_whole_buffer_and_signals_the_gap() {
        let (bus, _rx) = EventBus::new();
        let total = REPLAY_BUFFER as u64 + 10;
        for i in 0..total {
            bus.emit(stage_started("inv-1", &format!("s{i}")));
        }
        let oldest = bus.oldest_seq();
        assert_eq!(oldest, total - REPLAY_BUFFER as u64 + 1);

        // A caller that only saw the first event lost everything up to `oldest`.
        let (events, gap) = bus.catch_up(1);
        assert!(gap, "evicted events are a gap for this caller");
        assert_eq!(events.len(), REPLAY_BUFFER, "the call rebuilds from the buffer");
        assert_eq!(events.first().map(|(s, _)| *s), Some(oldest));
        assert_eq!(events.last().map(|(s, _)| *s), Some(total));
    }

    #[test]
    fn catch_up_after_a_restart_returns_everything() {
        let (bus, _rx) = EventBus::new();
        bus.emit(stage_started("inv-1", "a"));
        bus.emit(stage_started("inv-1", "b"));

        // The caller remembers a sequence this (fresh) bus never reached.
        let (events, gap) = bus.catch_up(99);
        assert!(gap, "a sequence ahead of the bus means it restarted");
        assert_eq!(events.len(), 2);
    }

    /// Session-scoped catch-up keeps both properties across eviction: only the
    /// owner's events, still strictly ordered, and dedupe by sequence holds at
    /// the eviction boundary.
    #[test]
    fn replay_session_after_eviction_stays_ordered_and_scoped() {
        let (bus, _rx) = EventBus::new();
        let total = REPLAY_BUFFER as u64 + 10;
        for i in 0..total {
            let owner = if i % 2 == 0 { "inv-a" } else { "inv-b" };
            bus.emit(stage_started(owner, &format!("s{i}")));
        }

        let all_a = bus.replay_session("inv-a", 0);
        assert!(!all_a.is_empty());
        assert!(all_a.iter().all(|(_, e)| e.investigation_id() == Some("inv-a")));
        let seqs: Vec<u64> = all_a.iter().map(|(s, _)| *s).collect();
        assert!(seqs.windows(2).all(|w| w[0] < w[1]));
        assert!(seqs.iter().all(|s| *s <= total));

        // Resuming from the last seen sequence yields nothing for that owner.
        let resume = bus.replay_session("inv-a", *seqs.last().expect("non-empty"));
        assert!(resume.is_empty());

        // A scoped resume from a mid-buffer sequence excludes what was already
        // applied, even though unrelated owners' events sit in between.
        let mid = seqs[seqs.len() / 2];
        let after_mid = bus.replay_session("inv-a", mid);
        assert!(after_mid.iter().all(|(s, _)| *s > mid));
        assert_eq!(after_mid.len(), seqs.len() - seqs.len() / 2 - 1);
    }
}
