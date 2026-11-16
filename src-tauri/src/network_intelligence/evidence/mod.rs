//! NANI Phase 4 — Evidence Foundation
//!
//! The foundation of all learning: a typed measurement schema, provenance,
//! validation, and a unified telemetry pipeline. Every observation that enters
//! the mathematical engine goes through here first.

pub mod measurements;
pub mod correlation;

pub mod telemetry_pipeline;
pub mod provenance;
pub mod validation;



pub use measurements::{Measurement, MeasureState, Provenance};
pub use correlation::{CorrelationGroup, CorrelationModel};
pub use provenance::ProvenanceRecord;
pub use validation::ValidationError;

/// Find and verify an evidence module.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::network_intelligence::evidence::measurements:: Measurement;

    #[test]
    fn evidence_module_loads() {
        let _ = Measurement::new("t", 0, "t", "t", "t", "t");
    }
}
