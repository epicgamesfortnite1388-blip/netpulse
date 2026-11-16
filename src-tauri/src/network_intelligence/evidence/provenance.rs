//! NANI Phase 4 — Evidence Provenance
//!
//! Tracks where each measurement came from so the engine can distinguish
//! measurement from inference and never treat fabricated evidence as data.

// Provenance is defined in measurements.rs and re-exported by evidence/mod.rs

use crate::network_intelligence::evidence::measurements::Provenance;

#[derive(Debug, Clone)]
pub struct ProvenanceRecord {
    pub source_id: String,
    pub provenance: Provenance,
    pub timestamp: u64,
    pub channel: Option<String>,
}

impl ProvenanceRecord {
    pub fn new(source_id: impl Into<String>, provenance: Provenance) -> Self {
        Self {
            source_id: source_id.into(),
            provenance,
            timestamp: 0,
            channel: None,
        }
    }

    pub fn is_verified(&self) -> bool {
        matches!(
            self.provenance.clone(),
            Provenance::Direct | Provenance::IndependentlyVerified
        )
    }

    pub fn can_be_authorized(&self) -> bool {
        !self.provenance.clone().is_likely_fabricated()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_provenance_allowed() {
        let r = ProvenanceRecord::new("s1", Provenance::Direct);
        assert!(r.is_verified());
        assert!(r.can_be_authorized());
    }

    #[test]
    fn llm_hypothesis_not_verified() {
        let r = ProvenanceRecord::new("s1", Provenance::LlmHypothesis);
        assert!(!r.is_verified());
        assert!(!r.can_be_authorized());
    }
}
