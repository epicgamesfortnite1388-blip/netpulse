//! NANI Phase 4 — Evidence Validation
//!
//! Validates measurement evidence before it enters the mathematical engine.
//! Validating evidence is mandatory — unvalidated evidence is rejected.

use crate::network_intelligence::evidence::measurements::{Measurement, MeasureState};

/// Sanitized validation error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    MissingId,
    MissingTimestamp,
    InvalidState,
    InvalidConfidence,
    OutdatedEvidence,
    ProvenanceMismatch,
}

impl ValidationError {
    pub fn message(&self) -> &'static str {
        match self {
            ValidationError::MissingId => "measurement id is required",
            ValidationError::MissingTimestamp => "measurement timestamp is required",
            ValidationError::InvalidState => "measurement state is invalid",
            ValidationError::InvalidConfidence => "measurement confidence is invalid",
            ValidationError::OutdatedEvidence => "evidence is older than its freshness window",
            ValidationError::ProvenanceMismatch => "provenance and state are inconsistent",
        }
    }
}

impl Measurement {
    /// Run core validation. Returns None on success.
    pub fn validate(&self) -> Option<ValidationError> {
        if self.id.is_empty() {
            return Some(ValidationError::MissingId);
        }
        if self.timestamp == 0 {
            return Some(ValidationError::MissingTimestamp);
        }
        match self.state {
            MeasureState::NotMeasured | MeasureState::Pending => {
                if self.valid {
                    return Some(ValidationError::InvalidState);
                }
            }
            MeasureState::Successful | MeasureState::Failed | MeasureState::TimedOut => {
                if !self.valid {
                    return Some(ValidationError::InvalidState);
                }
            }
            _ => {
                return Some(ValidationError::InvalidState);
            }
        }
        if let Some(c) = self.confidence {
            if c < 0.0 || c > 1.0 {
                return Some(ValidationError::InvalidConfidence);
            }
        }
        if self.provenance.clone().is_likely_fabricated() && self.valid {
            // Predicted/LLM-derived evidence requires explicit override
            return Some(ValidationError::ProvenanceMismatch);
        }
        None
    }

    /// Full validation with freshness check. Freshness is measured from now.
    pub fn validate_full(&self, now: u64, max_freshness_ms: f64) -> Option<ValidationError> {
        self.validate()?;
        if (now as i128 - self.timestamp as i128) as f64 > max_freshness_ms {
            return Some(ValidationError::OutdatedEvidence);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network_intelligence::evidence::measurements::MeasureState;

    #[test]
    fn valid_measurement_passes() {
        let mut m = Measurement::new("m1", 1000, "test", "net", "ctx", "m");
        m.set_value(0.5);
        m.set_state(MeasureState::Successful);
        assert!(m.validate().is_none());
    }

    #[test]
    fn missing_measurement_fails() {
        let m = Measurement::missing("m1", 1000, "test");
        assert!(m.validate().is_some());
    }

    #[test]
    fn outdated_evidence_fails() {
        let mut m = Measurement::new("m1", 0, "test", "net", "ctx", "m");
        m.set_value(0.5);
        m.set_state(MeasureState::Successful);
        assert!(m.validate_full(1_000_000, 60_000.0).is_some());
    }
}
