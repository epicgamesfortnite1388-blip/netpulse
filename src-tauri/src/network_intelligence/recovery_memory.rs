//! NANI Phase 2 — Recovery memory: verified outcome tracking for learning.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryOutcome {
    pub incident_id: String,
    pub action: String,
    pub network_context: String,
    pub predicted_success: f64,
    pub verified_success: bool,
    pub duration_ms: u64,
    pub rolled_back: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RecoveryMemory {
    records: Vec<RecoveryOutcome>,
    capacity: usize,
}

impl RecoveryMemory {
    pub fn new(capacity: usize) -> Self {
        Self {
            records: Vec::new(),
            capacity: capacity.max(1),
        }
    }

    pub fn record(&mut self, outcome: RecoveryOutcome) {
        if self.records.len() >= self.capacity {
            self.records.remove(0);
        }
        self.records.push(outcome);
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Empirical success rate for an action in a given network context.
    pub fn success_rate(&self, action: &str, context: &str) -> Option<f64> {
        let relevant: Vec<&RecoveryOutcome> = self
            .records
            .iter()
            .filter(|r| r.action == action && r.network_context == context)
            .collect();
        if relevant.is_empty() {
            return None;
        }
        let successes = relevant.iter().filter(|r| r.verified_success).count() as f64;
        Some(successes / relevant.len() as f64)
    }

    /// Average prediction error (Brier-style) for an action.
    pub fn mean_prediction_error(&self, action: &str) -> Option<f64> {
        let relevant: Vec<&RecoveryOutcome> =
            self.records.iter().filter(|r| r.action == action).collect();
        if relevant.is_empty() {
            return None;
        }
        let err: f64 = relevant
            .iter()
            .map(|r| {
                let actual = if r.verified_success { 1.0 } else { 0.0 };
                (r.predicted_success - actual).powi(2)
            })
            .sum::<f64>()
            / relevant.len() as f64;
        Some(err)
    }

    /// Summary counts by action.
    pub fn counts_by_action(&self) -> HashMap<String, (usize, usize)> {
        let mut map: HashMap<String, (usize, usize)> = HashMap::new();
        for r in &self.records {
            let entry = map.entry(r.action.clone()).or_insert((0, 0));
            entry.0 += 1;
            if r.verified_success {
                entry.1 += 1;
            }
        }
        map
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(action: &str, ctx: &str, pred: f64, ok: bool) -> RecoveryOutcome {
        RecoveryOutcome {
            incident_id: "i1".into(),
            action: action.into(),
            network_context: ctx.into(),
            predicted_success: pred,
            verified_success: ok,
            duration_ms: 100,
            rolled_back: false,
        }
    }

    #[test]
    fn records_and_evicts() {
        let mut m = RecoveryMemory::new(2);
        m.record(rec("a", "c", 0.5, true));
        m.record(rec("b", "c", 0.5, false));
        m.record(rec("c", "c", 0.5, true));
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn success_rate_filters_context() {
        let mut m = RecoveryMemory::new(10);
        m.record(rec("act", "ctx1", 0.8, true));
        m.record(rec("act", "ctx1", 0.8, false));
        m.record(rec("act", "ctx2", 0.8, true));
        assert_eq!(m.success_rate("act", "ctx1"), Some(0.5));
        assert_eq!(m.success_rate("act", "ctx2"), Some(1.0));
        assert_eq!(m.success_rate("act", "ctx3"), None);
    }

    #[test]
    fn prediction_error_computed() {
        let mut m = RecoveryMemory::new(10);
        m.record(rec("act", "c", 1.0, true));
        m.record(rec("act", "c", 0.0, false));
        let err = m.mean_prediction_error("act").unwrap();
        assert!(err < 1e-9);
    }
}
