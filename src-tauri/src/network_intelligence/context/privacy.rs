//! NANI Phase 4 — Network privacy controls.
//!
//! User-facing controls for resetting or deleting network context profiles and
//! associated learned baselines. All data is local; these operations remove
//! it from the device.

use crate::network_intelligence::context::context_identity::NetworkContextId;
use crate::network_intelligence::context::network_profiles::ProfileStore;
use crate::network_intelligence::context::transitions::ContextTransitionTracker;

/// Result of a privacy operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivacyAction {
    /// A single context profile was deleted.
    ContextDeleted,
    /// All context profiles were deleted (global prior retained).
    AllContextsDeleted,
    /// No matching context existed.
    NotFound,
}

/// Privacy controller: coordinates user-initiated deletion/reset of network
/// learning state across the identity tracker and profile store.
pub struct PrivacyController {
    tracker: ContextTransitionTracker,
    store: ProfileStore,
}

impl PrivacyController {
    pub fn new(tracker: ContextTransitionTracker, store: ProfileStore) -> Self {
        Self { tracker, store }
    }

    /// Delete a single network context and its learned profile.
    pub fn delete_context(&mut self, id: NetworkContextId) -> PrivacyAction {
        let profile_removed = self.store.remove_context(id);
        if profile_removed {
            // If this was the active context, drop it from the tracker too.
            if self.tracker.current() == Some(id) {
                self.tracker.reset();
            }
            PrivacyAction::ContextDeleted
        } else {
            PrivacyAction::NotFound
        }
    }

    /// Delete all network context profiles and reset the active context.
    /// The global prior is retained.
    pub fn delete_all_contexts(&mut self) -> PrivacyAction {
        if self.store.contexts.len() == 0 {
            return PrivacyAction::NotFound;
        }
        self.store.clear_contexts();
        self.tracker.reset();
        PrivacyAction::AllContextsDeleted
    }

    /// Reset the active context without deleting any learned data.
    pub fn reset_active(&mut self) {
        self.tracker.reset();
    }

    /// Number of retained contexts.
    pub fn context_count(&self) -> usize {
        self.store.contexts.len()
    }

    pub fn store(&self) -> &ProfileStore {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut ProfileStore {
        &mut self.store
    }

    pub fn identity(&self) -> &ContextTransitionTracker {
        &self.tracker
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_context_removes_profile() {
        let tracker = ContextTransitionTracker::new();
        let store = ProfileStore::new();
        let mut ctrl = PrivacyController::new(tracker, store);
        // Manually add a context via store_mut.
        let id = NetworkContextId(1);
        ctrl.store_mut().context_profile_mut(id);
        assert_eq!(ctrl.context_count(), 1);
        assert_eq!(ctrl.delete_context(id), PrivacyAction::ContextDeleted);
        assert_eq!(ctrl.context_count(), 0);
    }

    #[test]
    fn delete_all_contexts() {
        let tracker = ContextTransitionTracker::new();
        let store = ProfileStore::new();
        let mut ctrl = PrivacyController::new(tracker, store);
        ctrl.store_mut().context_profile_mut(NetworkContextId(1));
        ctrl.store_mut().context_profile_mut(NetworkContextId(2));
        assert_eq!(ctrl.context_count(), 2);
        assert_eq!(ctrl.delete_all_contexts(), PrivacyAction::AllContextsDeleted);
        assert_eq!(ctrl.context_count(), 0);
    }

    #[test]
    fn delete_nonexistent_is_not_found() {
        let tracker = ContextTransitionTracker::new();
        let store = ProfileStore::new();
        let mut ctrl = PrivacyController::new(tracker, store);
        assert_eq!(ctrl.delete_context(NetworkContextId(999)), PrivacyAction::NotFound);
    }
}
