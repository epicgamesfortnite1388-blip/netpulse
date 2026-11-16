//! NANI Phase 4 — Unified Telemetry Pipeline
//!
//! Event-driven measurement pipeline: COLLECT → VALIDATE → NORMALIZE →
//! ENRICH → STORE → PUBLISH. Bounded queues, backpressure, event versioning.

use crate::network_intelligence::evidence::measurements::{Measurement, MeasureState};

/// The pipeline stages, in order.
const PIPELINE_STAGES: &[&str] = &["COLLECT", "VALIDATE", "NORMALIZE", "ENRICH", "STORE", "PUBLISH"];

/// Result of one pipeline stage.
#[derive(Debug, Clone)]
pub struct PipelineResult {
    pub stage: String,
    pub measurement: Measurement,
    pub elapsed_us: u128,
    pub error: Option<String>,
}

/// A bounded, cancellable telemetry queue with backpressure.
pub struct TelemetryQueue {
    name: String,
    capacity: usize,
    items: Vec<Measurement>,
    cancelled: bool,
}

impl TelemetryQueue {
    pub fn new(name: impl Into<String>, capacity: usize) -> Self {
        Self {
            name: name.into(),
            capacity: capacity.max(1),
            items: Vec::with_capacity(capacity),
            cancelled: false,
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn push(&mut self, measurement: Measurement) -> Result<(), String> {
        if self.cancelled {
            return Err("queue cancelled".into());
        }
        if self.items.len() >= self.capacity {
            // Drop the oldest item and add the new one — bounded queue.
            self.items.remove(0);
        }
        self.items.push(measurement);
        Ok(())
    }

    pub fn pop(&mut self) -> Option<Measurement> {
        if self.items.is_empty() {
            return None;
        }
        Some(self.items.remove(0))
    }

    pub fn cancel(&mut self) {
        self.cancelled = true;
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled
    }
}

/// Results buffer that preserves only the newest result per measurement.
#[derive(Debug, Default)]
pub struct ResultsStore {
    map: std::collections::BTreeMap<String, Measurement>,
}

impl ResultsStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, measurement: Measurement) {
        self.map.insert(measurement.id.clone(), measurement);
    }

    pub fn get(&self, id: &str) -> Option<&Measurement> {
        self.map.get(id)
    }

    pub fn iter_newest(&self) -> impl Iterator<Item = &Measurement> {
        self.map.values().rev()
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn clear(&mut self) {
        self.map.clear();
    }
}

/// Units whose values are genuinely bounded to `[0, 1]`.
fn is_ratio_unit(unit: Option<&str>) -> bool {
    matches!(
        unit.map(|u| u.trim().to_ascii_lowercase()),
        Some(u) if u == "ratio" || u == "probability" || u == "fraction"
            || u == "%" || u == "percent" || u == "percentage"
    )
}

/// Normalize without destroying magnitude.
///
/// Only ratio/probability units are clamped to `[0, 1]`; physical quantities
/// (ms, Mbps, bytes, counts) keep their value and are rejected when negative.
/// A non-finite value becomes an explicit `Invalid` measurement, never zero.
fn normalize(measurement: &Measurement) -> Measurement {
    let mut m = measurement.clone();
    match m.observed_value {
        None => {}
        Some(v) if !v.is_finite() => {
            m.observed_value = None;
            m.valid = false;
            m.state = MeasureState::Invalid;
        }
        Some(v) if is_ratio_unit(m.unit.as_deref()) => {
            m.observed_value = Some(v.clamp(0.0, 1.0));
        }
        Some(v) if v < 0.0 => {
            // Latency, bytes and counters cannot be negative; keep the
            // measurement but mark it unusable rather than silently |x|.
            m.observed_value = Some(v);
            m.valid = false;
            m.state = MeasureState::Invalid;
        }
        Some(_) => {}
    }
    m
}

/// Run a single pipeline stage.
pub fn run_stage(stage: &str, measurement: &Measurement) -> PipelineResult {
    let start = std::time::Instant::now();
    let result = if stage == "COLLECT" {
        measurement.clone()
    } else if stage == "VALIDATE" {
        match measurement.validate() {
            Some(err) => return PipelineResult {
                stage: stage.to_string(),
                measurement: measurement.clone(),
                elapsed_us: start.elapsed().as_micros(),
                error: Some(err.message().to_string()),
            },
            None => measurement.clone(),
        }
    } else if stage == "NORMALIZE" {
        normalize(measurement)
    } else {
        measurement.clone()
    };
    PipelineResult {
        stage: stage.to_string(),
        measurement: result,
        elapsed_us: start.elapsed().as_micros(),
        error: None,
    }
}

/// The complete pipeline. Returns Ok(()) when all stages completed without
/// unrecoverable errors.
pub fn run_pipeline(
    stages: &[&str],
    initial: &Measurement,
) -> Vec<PipelineResult> {
    let mut results = Vec::new();
    let mut current = initial.clone();
    for &stage in stages {
        let result = run_stage(stage, &current);
        results.push(result.clone());
        if let Some(_err) = result.error {
            break;
        }
        current = result.measurement.clone();
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_pipeline_stage_counts() {
        let mut m = Measurement::new("m1", 1000, "test", "net", "ctx", "m");
        m.set_value(0.5);
        m.set_state(MeasureState::Successful);
        let results = run_pipeline(PIPELINE_STAGES, &m);
        assert_eq!(results.len(), PIPELINE_STAGES.len());
    }

    #[test]
    fn telemetry_queue_is_bounded() {
        let mut q = TelemetryQueue::new("test", 2);
        q.push(Measurement::new("a", 0, "test", "net", "ctx", "m")).unwrap();
        q.push(Measurement::new("b", 0, "test", "net", "ctx", "m")).unwrap();
        q.push(Measurement::new("c", 0, "test", "net", "ctx", "m")).unwrap();
        assert_eq!(q.len(), 2);
    }

    #[test]
    fn results_store_keeps_newest() {
        let mut s = ResultsStore::new();
        let m1 = Measurement::new("a", 0, "test", "net", "ctx", "m");
        let m2 = Measurement::new("a", 1, "test", "net", "ctx", "m");
        s.insert(m1);
        s.insert(m2);
        assert_eq!(s.len(), 1);
        assert!(s.iter_newest().next().is_some());
    }

    #[test]
    fn pipeline_stage_names() {
        assert_eq!(PIPELINE_STAGES.len(), 6);
    }

    #[test]
    fn normalize_preserves_physical_quantities() {
        let mut m = Measurement::new("m1", 1000, "latency_ms", "net", "ctx", "probe");
        m.unit = Some("ms".into());
        m.set_value(850.0);
        m.set_state(MeasureState::Successful);
        let out = run_stage("NORMALIZE", &m);
        assert_eq!(out.measurement.observed_value, Some(850.0));
    }

    #[test]
    fn normalize_clamps_ratio_units_only() {
        let mut m = Measurement::new("m1", 1000, "loss", "net", "ctx", "probe");
        m.unit = Some("ratio".into());
        m.set_value(1.7);
        m.set_state(MeasureState::Successful);
        let out = run_stage("NORMALIZE", &m);
        assert_eq!(out.measurement.observed_value, Some(1.0));
    }

    #[test]
    fn normalize_rejects_negative_physical_values() {
        let mut m = Measurement::new("m1", 1000, "latency_ms", "net", "ctx", "probe");
        m.unit = Some("ms".into());
        m.set_value(-5.0);
        m.set_state(MeasureState::Successful);
        let out = run_stage("NORMALIZE", &m);
        assert!(!out.measurement.valid);
        assert_eq!(out.measurement.state, MeasureState::Invalid);
    }

    #[test]
    fn validate_stage_reports_the_actual_error() {
        let m = Measurement::missing("", 1000, "test");
        let out = run_stage("VALIDATE", &m);
        assert_eq!(out.error.as_deref(), Some("measurement id is required"));
    }
}
