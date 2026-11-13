//! Causal outcome tracking for recovery interventions.
//!
//! A connection that succeeds after switching proxies does not prove the proxy
//! caused the recovery: DNS, credentials or the provider may have changed in the
//! same window. This module records controlled interventions and estimates the
//! average treatment effect (ATE) from potential outcomes:
//!
//!   τ = E[Y(1) - Y(0)]
//!
//! Only records whose `controlled` flag is true (exactly one variable changed,
//! and the outcome was verified after a stability period) enter the estimate.
//! When there are too few treated or control observations, the estimate is
//! explicitly not identifiable rather than defaulting to a causal claim.

/// Action label used for observations where no intervention was applied.
pub const CONTROL_ACTION: &str = "none";

/// One observed intervention window.
#[derive(Debug, Clone, PartialEq)]
pub struct InterventionRecord {
    /// Network context (API, network profile) the intervention happened in.
    pub context: String,
    /// Action that was applied, or [`CONTROL_ACTION`].
    pub action: String,
    /// Connectivity succeeded before the intervention.
    pub baseline_success: bool,
    /// Connectivity succeeded after the intervention and the stability window.
    pub post_success: bool,
    /// True only when exactly one variable changed and the result was verified.
    pub controlled: bool,
    /// Variables the intervention changed (secrets never belong here).
    pub changed_variables: Vec<String>,
    /// How long the post-intervention state stayed stable, in seconds.
    pub stability_seconds: u64,
}

impl InterventionRecord {
    pub fn new(
        context: impl Into<String>,
        action: impl Into<String>,
        baseline_success: bool,
        post_success: bool,
        changed_variables: Vec<String>,
        stability_seconds: u64,
    ) -> Self {
        let controlled = changed_variables.len() == 1 && stability_seconds > 0;
        Self {
            context: context.into(),
            action: action.into(),
            baseline_success,
            post_success,
            controlled,
            changed_variables,
            stability_seconds,
        }
    }
}

/// Estimated effect of one action in one context.
#[derive(Debug, Clone, PartialEq)]
pub struct CausalEstimate {
    pub action: String,
    pub context: String,
    pub treated_n: usize,
    pub control_n: usize,
    pub treated_success_rate: Option<f64>,
    pub control_success_rate: Option<f64>,
    /// Average treatment effect `E[Y(1) - Y(0)]` when identifiable.
    pub ate: Option<f64>,
    /// 95% CI for the difference of proportions (normal approximation).
    pub ci95: Option<(f64, f64)>,
    /// Whether enough controlled evidence exists to estimate the effect.
    pub identifiable: bool,
    /// Why the estimate is or is not identifiable.
    pub reason: &'static str,
}

/// Bounded history of intervention records.
#[derive(Debug, Clone)]
pub struct CausalTracker {
    records: Vec<InterventionRecord>,
    max_records: usize,
    /// Minimum controlled observations per arm before an estimate is made.
    pub min_arm_size: usize,
}

impl Default for CausalTracker {
    fn default() -> Self {
        Self::new(1_000)
    }
}

impl CausalTracker {
    pub fn new(max_records: usize) -> Self {
        Self {
            records: Vec::new(),
            max_records: max_records.max(1),
            min_arm_size: 8,
        }
    }

    /// Record an intervention window. Oldest records are dropped first, which
    /// bounds memory without deleting the recent evidence drift detection needs.
    pub fn record(&mut self, record: InterventionRecord) {
        self.records.push(record);
        if self.records.len() > self.max_records {
            let excess = self.records.len() - self.max_records;
            self.records.drain(0..excess);
        }
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Estimate `E[Y(1) - Y(0)]` for `action` in `context`.
    ///
    /// Units are records where connectivity had already failed
    /// (`baseline_success == false`). Treated units are controlled records with
    /// the matching action; controls are controlled records with no action in
    /// the same context.
    pub fn estimate(&self, action: &str, context: &str) -> CausalEstimate {
        let base = |r: &InterventionRecord| {
            r.context == context && !r.baseline_success && r.controlled
        };
        let treated: Vec<&InterventionRecord> = self
            .records
            .iter()
            .filter(|r| base(r) && r.action == action)
            .collect();
        let control: Vec<&InterventionRecord> = self
            .records
            .iter()
            .filter(|r| base(r) && r.action == CONTROL_ACTION)
            .collect();

        let treated_n = treated.len();
        let control_n = control.len();
        let rate = |xs: &[&InterventionRecord]| {
            if xs.is_empty() {
                None
            } else {
                Some(xs.iter().filter(|r| r.post_success).count() as f64 / xs.len() as f64)
            }
        };
        let p1 = rate(&treated);
        let p0 = rate(&control);

        let mut est = CausalEstimate {
            action: action.to_string(),
            context: context.to_string(),
            treated_n,
            control_n,
            treated_success_rate: p1,
            control_success_rate: p0,
            ate: None,
            ci95: None,
            identifiable: false,
            reason: "insufficient controlled observations",
        };

        if action == CONTROL_ACTION {
            est.reason = "control action has no treatment effect";
            return est;
        }
        if treated_n < self.min_arm_size || control_n < self.min_arm_size {
            return est;
        }

        let (Some(p1), Some(p0)) = (p1, p0) else {
            return est;
        };
        let ate = p1 - p0;
        // Difference of two independent proportions.
        let se = (p1 * (1.0 - p1) / treated_n as f64 + p0 * (1.0 - p0) / control_n as f64)
            .sqrt();
        est.ate = Some(ate);
        est.ci95 = Some((ate - 1.96 * se, ate + 1.96 * se));
        est.identifiable = true;
        est.reason = "controlled comparison";
        est
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(tracker: &mut CausalTracker, action: &str, context: &str, post: bool, controlled: bool) {
        let mut r = InterventionRecord::new(
            context,
            action,
            false,
            post,
            vec!["route".to_string()],
            30,
        );
        r.controlled = controlled;
        tracker.record(r);
    }

    #[test]
    fn insufficient_samples_are_not_identifiable() {
        let mut t = CausalTracker::new(100);
        for _ in 0..3 {
            record(&mut t, "upstream", "ctx", true, true);
            record(&mut t, CONTROL_ACTION, "ctx", false, true);
        }
        let e = t.estimate("upstream", "ctx");
        assert!(!e.identifiable);
        assert!(e.ate.is_none());
        assert_eq!(e.reason, "insufficient controlled observations");
    }

    #[test]
    fn detects_clear_positive_effect() {
        let mut t = CausalTracker::new(100);
        for _ in 0..10 {
            record(&mut t, "upstream", "ctx", true, true);
            record(&mut t, CONTROL_ACTION, "ctx", false, true);
        }
        let e = t.estimate("upstream", "ctx");
        assert!(e.identifiable);
        assert!((e.ate.unwrap() - 1.0).abs() < 1e-9);
        let (lo, hi) = e.ci95.unwrap();
        assert!(lo > 0.0 && hi >= lo);
    }

    #[test]
    fn confounded_records_do_not_count() {
        let mut t = CausalTracker::new(100);
        for _ in 0..10 {
            record(&mut t, "upstream", "ctx", true, false);
            record(&mut t, CONTROL_ACTION, "ctx", false, false);
        }
        let e = t.estimate("upstream", "ctx");
        assert!(!e.identifiable);
        assert_eq!(e.treated_n, 0);
    }

    #[test]
    fn contexts_are_not_pooled() {
        let mut t = CausalTracker::new(100);
        for _ in 0..10 {
            record(&mut t, "upstream", "ctx-a", true, true);
            record(&mut t, CONTROL_ACTION, "ctx-a", false, true);
        }
        assert!(!t.estimate("upstream", "ctx-b").identifiable);
    }

    #[test]
    fn history_is_bounded() {
        let mut t = CausalTracker::new(5);
        for i in 0..20 {
            record(&mut t, "upstream", &format!("ctx-{i}"), true, true);
        }
        assert_eq!(t.len(), 5);
    }
}
