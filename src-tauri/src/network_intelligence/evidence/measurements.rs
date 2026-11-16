//! NANI Phase 4 — Unified Measurement Evidence Schema
//!
//! The foundation of all learning: every measurement carries explicit metadata
//! so that uncertainty, origins, and validity are never hidden inside an
//! opaque float or boolean.

use crate::network_intelligence::math::{clamp_probability, finite_or_default};
use serde::{Deserialize, Serialize};

/// Explicit measurement states. Missing data is never represented as zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MeasureState {
    NotMeasured,
    Pending,
    Successful,
    Failed,
    TimedOut,
    Unavailable,
    Invalid,
    InsufficientEvidence,
    Cancelled,
    Expired,
}

impl MeasureState {
    /// Missing = not measured or unavailable. All other states are meaningful.
    pub fn is_missing(self) -> bool {
        matches!(self, MeasureState::NotMeasured | MeasureState::Pending | MeasureState::Unavailable | MeasureState::Invalid | MeasureState::InsufficientEvidence | MeasureState::Cancelled | MeasureState::Expired)
    }
}

/// Provenance — where this measurement came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Provenance {
    Direct,
    Derived,
    Predicted,
    UserCorrection,
    LlmHypothesis,
    IndependentlyVerified,
    ImportedHistorical,
}

impl Provenance {
    pub fn is_likely_fabricated(self) -> bool {
        matches!(self, Provenance::Predicted | Provenance::LlmHypothesis)
    }
}

/// One unified measurement record — the only schema that crosses the evidence
/// boundary into the mathematical engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Measurement {
    /// Unique, monotonically increasing measurement ID.
    pub id: String,
    /// Epoch ms. Must be non-negative.
    pub timestamp: u64,
    /// Optional duration ms.
    pub duration_ms: Option<f64>,
    /// Human-readable type. Used for routing to the right analysis path.
    pub kind: String,
    /// Target category (endpoint, service, api, config, network).
    pub target_category: String,
    /// Network context ID — local random identifier, pseudonymized.
    pub network_context_id: String,
    /// Measurement method.
    pub method: String,
    /// Observed value. Optional — a measuring algorithm may not produce one
    /// (e.g. a probe timed out).
    pub observed_value: Option<f64>,
    /// Unit for observed_value, if applicable.
    pub unit: Option<String>,
    /// Result classification.
    pub state: MeasureState,
    /// Validity: false means the measurement was unusable.
    pub valid: bool,
    /// Confidence in this measurement (0..1). None = unknown.
    pub confidence: Option<f64>,
    /// Sample count if the measurement aggregated multiple probes.
    pub sample_count: Option<u64>,
    /// Evidence freshness window.
    pub freshness_window_ms: f64,
    /// Provenance.
    pub provenance: Provenance,
    /// Collection permissions.
    pub collection_permissions: Option<String>,
    /// Version of the measuring algorithm.
    pub algorithm_version: String,
}

impl Measurement {
    pub fn new(
        id: impl Into<String>,
        timestamp: u64,
        kind: impl Into<String>,
        target_category: impl Into<String>,
        network_context_id: impl Into<String>,
        method: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            timestamp,
            duration_ms: None,
            kind: kind.into(),
            target_category: target_category.into(),
            network_context_id: network_context_id.into(),
            method: method.into(),
            observed_value: None,
            unit: None,
            state: MeasureState::NotMeasured,
            valid: false,
            confidence: None,
            sample_count: None,
            freshness_window_ms: 300_000.0,
            provenance: Provenance::Direct,
            collection_permissions: None,
            algorithm_version: "v4.0.0".into(),
        }
    }

    /// Set the observed value.
    ///
    /// Values are physical quantities (ms, bytes, Mbps, counts) or probabilities;
    /// they must never be clamped into `[0, 1]` here. Clamping belongs to the
    /// unit-aware normalization stage, not to the evidence record itself —
    /// otherwise a 12.5 ms latency would be stored as 1.0.
    pub fn set_value(&mut self, value: f64) {
        if value.is_finite() {
            self.observed_value = Some(value);
            self.valid = true;
        } else {
            self.observed_value = None;
            self.valid = false;
            self.state = MeasureState::Invalid;
        }
    }

    /// Set the measurement result state.
    pub fn set_state(&mut self, state: MeasureState) {
        self.state = state;
        self.valid = !state.is_missing();
    }

    /// Set the confidence.
    pub fn set_confidence(&mut self, confidence: f64) {
        self.confidence = Some(clamp_probability(confidence));
    }

    /// Create a missing-data observation (never zero-valued).
    pub fn missing(id: impl Into<String>, timestamp: u64, kind: impl Into<String>) -> Self {
        let mut m = Self::new(id, timestamp, kind, "", "", "");
        m.state = MeasureState::InsufficientEvidence;
        m.valid = false;
        m
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_is_not_measured_success() {
        let m = Measurement::missing("m1", 1000, "test");
        assert_eq!(m.state, MeasureState::InsufficientEvidence);
        assert!(!m.valid);
    }

    #[test]
    fn successful_measured_value() {
        let mut m = Measurement::new("m1", 1000, "latency", "network", "ctx1", "probe");
        m.set_value(12.5);
        m.set_state(MeasureState::Successful);
        assert!(m.valid);
        assert_eq!(m.observed_value, Some(12.5));
    }

    #[test]
    fn physical_values_are_not_clamped_to_probabilities() {
        let mut m = Measurement::new("m1", 1000, "latency_ms", "network", "ctx1", "probe");
        m.set_value(850.0);
        assert_eq!(m.observed_value, Some(850.0));
        m.set_value(-1.0);
        assert_eq!(m.observed_value, Some(-1.0));
    }

    #[test]
    fn non_finite_value_invalidates_the_measurement() {
        let mut m = Measurement::new("m1", 1000, "latency_ms", "network", "ctx1", "probe");
        m.set_value(f64::NAN);
        assert!(m.observed_value.is_none());
        assert!(!m.valid);
        assert_eq!(m.state, MeasureState::Invalid);
    }

    #[test]
    fn confidence_clamped() {
        let mut m = Measurement::new("m1", 1000, "test", "net", "ctx", "m");
        m.set_confidence(-1.0);
        assert!((m.confidence.unwrap() - crate::network_intelligence::math::PROB_FLOOR).abs() < f64::EPSILON);
        m.set_confidence(2.0);
        assert!((m.confidence.unwrap() - (1.0 - crate::network_intelligence::math::PROB_FLOOR)).abs() < f64::EPSILON);
    }
}
