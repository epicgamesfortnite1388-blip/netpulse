//! NANI Phase 4 — Network context transitions.
//!
//! Detects when a user's network environment has changed substantially, so
//! observations from incompatible contexts are not mixed. Multiple profiles
//! can coexist; transitions do not delete old knowledge.

use crate::network_intelligence::context::context_identity::{ContextIdentity, ContextSignals, InterfaceClass, NetworkContext, NetworkContextId};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The result of checking whether a context transition occurred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    /// No change; same context.
    None,
    /// Context switched to a different known context (reconnect).
    ContextSwitch(NetworkContextId),
    /// New context detected (first time seeing this environment).
    NewContext(NetworkContextId),
}

/// Tracks the currently active context and detects transitions.
///
/// A transition is signalled when the interface class or gateway/resolver
/// class changes, indicating the device may have moved to a different
/// network. Old contexts are retained so that returning to a known network
/// restores its profile.
#[derive(Debug, Clone, Default)]
pub struct ContextTransitionTracker {
    current: Option<NetworkContextId>,
    identity: ContextIdentity,
    last_signal_ms: u64,
}

impl ContextTransitionTracker {
    pub fn new() -> Self {
        Self {
            current: None,
            identity: ContextIdentity::new(),
            last_signal_ms: 0,
        }
    }

    /// Evaluate a new set of signals. Returns a `Transition` and updates the
    /// active context if one is detected.
    pub fn evaluate(&mut self, signals: &ContextSignals) -> Transition {
        let now = unix_now_ms();
        let (id, _is_new) = self.identity.identify(signals);

        let transition = match self.current {
            // No current context → this is a new context.
            None => Transition::NewContext(id),
            // Same context as before.
            Some(current) if current == id => Transition::None,
            // Switched to a different context (new or known).
            Some(_) => Transition::ContextSwitch(id),
        };

        if transition != Transition::None {
            self.current = Some(id);
            self.last_signal_ms = now;
        }
        transition
    }

    /// The currently active context, if any.
    pub fn current(&self) -> Option<NetworkContextId> {
        self.current
    }

    /// Whether a transition has been observed since construction.
    pub fn has_transitioned(&self) -> bool {
        self.last_signal_ms > 0
    }

    /// Set the active context directly (tests/restore). Unknown ids are ignored.
    pub fn set_current(&mut self, id: Option<NetworkContextId>) {
        self.current = id.filter(|id| self.identity.get(*id).is_some());
        if self.current.is_none() {
            self.last_signal_ms = 0;
        }
    }

    /// Manually reset the active context (user-initiated).
    pub fn reset(&mut self) {
        self.current = None;
        self.last_signal_ms = 0;
    }

    /// Access the underlying identity manager (for inspection / persistence).
    pub fn identity(&self) -> &ContextIdentity {
        &self.identity
    }

    pub fn identity_mut(&mut self) -> &mut ContextIdentity {
        &mut self.identity
    }

    /// Persisted tracker state: active id, known contexts, last transition time.
    pub fn export_parts(&self) -> (Option<NetworkContextId>, Vec<NetworkContext>, u64) {
        (
            self.current,
            self.identity.contexts().to_vec(),
            self.last_signal_ms,
        )
    }

    pub fn from_parts(
        current: Option<NetworkContextId>,
        contexts: Vec<NetworkContext>,
        last_signal_ms: u64,
    ) -> Self {
        let identity = ContextIdentity::from_contexts(contexts);
        let current = current.filter(|id| identity.get(*id).is_some());
        Self {
            current,
            identity,
            last_signal_ms: if current.is_some() { last_signal_ms } else { 0 },
        }
    }
}

impl InterfaceClass {
    /// Whether two interface classes are compatible (same broad category).
    pub fn is_compatible(self, other: InterfaceClass) -> bool {
        self == other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_signal_is_new_context() {
        let mut tracker = ContextTransitionTracker::new();
        let mut signals = ContextSignals::default();
        signals.is_wifi = true;
        signals.gateway_class = Some("home".into());
        match tracker.evaluate(&signals) {
            Transition::NewContext(_) => {}
            other => panic!("expected NewContext, got {:?}", other),
        }
    }

    #[test]
    fn repeated_signal_is_none() {
        let mut tracker = ContextTransitionTracker::new();
        let mut signals = ContextSignals::default();
        signals.is_wifi = true;
        signals.gateway_class = Some("home".into());
        tracker.evaluate(&signals);
        match tracker.evaluate(&signals) {
            Transition::None => {}
            other => panic!("expected None, got {:?}", other),
        }
    }

    #[test]
    fn class_change_is_switch() {
        let mut tracker = ContextTransitionTracker::new();
        let mut wifi = ContextSignals::default();
        wifi.is_wifi = true;
        wifi.gateway_class = Some("home".into());
        let mut eth = ContextSignals::default();
        eth.is_ethernet = true;
        eth.gateway_class = Some("office".into());

        tracker.evaluate(&wifi);
        match tracker.evaluate(&eth) {
            Transition::ContextSwitch(_) => {}
            other => panic!("expected ContextSwitch, got {:?}", other),
        }
    }

    #[test]
    fn reset_clears_active() {
        let mut tracker = ContextTransitionTracker::new();
        let mut signals = ContextSignals::default();
        signals.is_wifi = true;
        signals.gateway_class = Some("home".into());
        tracker.evaluate(&signals);
        tracker.reset();
        assert_eq!(tracker.current(), None);
        assert!(!tracker.has_transitioned());
    }
}
