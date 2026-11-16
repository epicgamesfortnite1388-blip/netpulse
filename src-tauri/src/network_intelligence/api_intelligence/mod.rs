//! API intelligence — registry, monitor, failure classifier, recovery.
//!
//! The control plane for autonomous API connectivity.

pub mod failure_classifier;
pub mod monitor;
pub mod monitor_loop;
pub mod registry;
