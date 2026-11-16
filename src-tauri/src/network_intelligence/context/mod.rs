//! NANI Phase 4 — Network personalization.
//!
//! Network context identification, per-context profile storage, and
//! hierarchical baselines. All identifiers are local random ids; no SSIDs,
//! MACs, private IPs, or browsing URLs are stored. Contexts can be reset or
//! deleted by the user at any time.

pub mod context_identity;
pub mod network_profiles;
pub mod transitions;
pub mod collector;
pub mod engine;
pub mod privacy;
pub mod storage;

pub use context_identity::{classify_interface, ContextIdentity, ContextSignals, InterfaceClass, NetworkContext, NetworkContextId};
pub use network_profiles::{MetricProfile, NetworkProfile, ProfileStore};
pub use engine::{NetworkProfileEngine, PersonalizationStatus, ProfileEngineSnapshot, TransitionRecord};
pub use storage::{load_engine, save_engine, profile_path, ProfileStorageError};
