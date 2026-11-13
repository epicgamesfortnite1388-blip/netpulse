// Recovery control: safe recovery planning, circuit breaker, rollback.
//
// The recovery loop: DETECT → CLASSIFY → TEST DIRECT → EVALUATE APPROVED
// UPSTREAM → PREDICT → SELECT → VERIFY REAL API RESPONSE → ACTIVATE →
// MONITOR → ROLLBACK IF NECESSARY → LEARN.
//
// Constraints: authorization, safe state transitions, maximum recovery
// duration, retry budgets, resource limits, rollback availability. Execute
// the first action only, observe, and replan (model predictive control).

use crate::network_intelligence::math::clamp_probability;
use std::time::Duration;

/// Circuit breaker state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakerState {
    /// Normal operation: requests pass through.
    Closed,
    /// Tripped: requests are short-circuited (no attempts).
    Open,
    /// Testing recovery: a limited trial request is allowed.
    HalfOpen,
}

impl std::fmt::Display for BreakerState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BreakerState::Closed => write!(f, "closed"),
            BreakerState::Open => write!(f, "open"),
            BreakerState::HalfOpen => write!(f, "half_open"),
        }
    }
}

/// A circuit breaker that trips on consecutive failures and recovers
// gradually via half-open trials.
#[derive(Debug, Clone)]
pub struct CircuitBreaker {
    pub state: BreakerState,
    /// Failures required to trip.
    pub failure_threshold: u64,
    /// Successes required in half-open to close again.
    pub success_threshold: u64,
    /// How long to stay open before trying half-open.
    pub recovery_timeout_sec: u64,
    consecutive_failures: u64,
    consecutive_successes: u64,
    tripped_at_unix: Option<u64>,
}

impl CircuitBreaker {
    pub fn new() -> Self {
        Self {
            state: BreakerState::Closed,
            failure_threshold: 5,
            success_threshold: 3,
            recovery_timeout_sec: 60,
            consecutive_failures: 0,
            consecutive_successes: 0,
            tripped_at_unix: None,
        }
    }

    /// Record a successful call. May close the breaker if we're half-open.
    pub fn record_success(&mut self, now_unix: u64) {
        match self.state {
            BreakerState::Closed => {
                self.consecutive_failures = 0;
            }
            BreakerState::HalfOpen => {
                self.consecutive_successes += 1;
                if self.consecutive_successes >= self.success_threshold {
                    self.state = BreakerState::Closed;
                    self.consecutive_failures = 0;
                    self.consecutive_successes = 0;
                    self.tripped_at_unix = None;
                }
            }
            BreakerState::Open => {
                // Should not happen: open state rejects calls.
            }
        }
    }

    /// Record a failed call. May trip the breaker.
    pub fn record_failure(&mut self, now_unix: u64) {
        self.consecutive_failures += 1;
        self.consecutive_successes = 0;
        if self.state == BreakerState::HalfOpen {
            // Any failure in half-open trips again immediately.
            self.trip(now_unix);
        } else if self.state == BreakerState::Closed
            && self.consecutive_failures >= self.failure_threshold
        {
            self.trip(now_unix);
        }
    }

    fn trip(&mut self, now_unix: u64) {
        self.state = BreakerState::Open;
        self.tripped_at_unix = Some(now_unix);
        self.consecutive_successes = 0;
    }

    /// Whether a call is allowed through the breaker right now.
    pub fn is_allowed(&self, now_unix: u64) -> bool {
        match self.state {
            BreakerState::Closed => true,
            BreakerState::Open => {
                // After recovery_timeout_sec, allow a half-open trial.
                if let Some(tripped) = self.tripped_at_unix {
                    now_unix.saturating_sub(tripped) >= self.recovery_timeout_sec
                } else {
                    false
                }
            }
            BreakerState::HalfOpen => true,
        }
    }

    /// Called when a call is about to be attempted: transition closed→half-open
    /// if the timeout has elapsed.
    pub fn before_attempt(&mut self, now_unix: u64) {
        if self.state == BreakerState::Open {
            if let Some(tripped) = self.tripped_at_unix {
                if now_unix.saturating_sub(tripped) >= self.recovery_timeout_sec {
                    self.state = BreakerState::HalfOpen;
                    self.consecutive_successes = 0;
                }
            }
        }
    }

    /// Whether the breaker is currently tripped (open).
    pub fn is_tripped(&self) -> bool {
        self.state == BreakerState::Open
    }
}

/// A single step in a recovery plan.
#[derive(Debug, Clone)]
pub struct RecoveryStep {
    pub id: String,
    pub action: String,
    /// Estimated success probability for this step.
    pub estimated_success: f64,
    /// Maximum time in seconds to spend on this step.
    pub timeout_sec: u64,
    /// Whether this step is reversible (has a rollback).
    pub reversible: bool,
    /// Whether this step has already been executed.
    pub executed: bool,
    /// Whether this step succeeded.
    pub succeeded: Option<bool>,
}

/// A recovery plan: an ordered sequence of steps with a total budget.
#[derive(Debug, Clone)]
pub struct RecoveryPlan {
    pub id: String,
    pub steps: Vec<RecoveryStep>,
    /// Maximum total recovery time in seconds.
    pub max_total_time_sec: u64,
    /// Maximum number of retries per step.
    pub max_retries_per_step: u64,
    pub started_at_unix: Option<u64>,
    pub completed: bool,
    pub succeeded: Option<bool>,
}

/// The recovery planner: builds plans, executes them one step at a time
/// (model predictive control), and rolls back on failure.
#[derive(Debug, Clone)]
pub struct RecoveryPlanner {
    pub breaker: CircuitBreaker,
    pub plans: Vec<RecoveryPlan>,
    pub active_plan: Option<String>,
}

impl RecoveryPlanner {
    pub fn new() -> Self {
        Self {
            breaker: CircuitBreaker::new(),
            plans: Vec::new(),
            active_plan: None,
        }
    }

    /// Create a recovery plan from candidate actions, ordered by estimated
    /// success. The first step is the least intrusive (verify known-good
    /// route), then progressively more intrusive.
    pub fn build_plan(
        &mut self,
        plan_id: &str,
        actions: Vec<(String, f64)>, // (action, estimated_success)
        max_total_time_sec: u64,
    ) -> String {
        let mut steps: Vec<RecoveryStep> = actions
            .into_iter()
            .enumerate()
            .map(|(i, (action, est))| RecoveryStep {
                id: format!("{}-step-{}", plan_id, i),
                action,
                estimated_success: clamp_probability(est),
                timeout_sec: 30,
                reversible: true,
                executed: false,
                succeeded: None,
            })
            .collect();
        // Most-reversible / least-intrusive first: sort descending by estimated
        // success so we try the most likely-safe action first.
        steps.sort_by(|a, b| b.estimated_success.partial_cmp(&a.estimated_success).unwrap_or(std::cmp::Ordering::Equal));

        let plan = RecoveryPlan {
            id: plan_id.to_string(),
            steps,
            max_total_time_sec,
            max_retries_per_step: 2,
            started_at_unix: None,
            completed: false,
            succeeded: None,
        };
        self.plans.push(plan.clone());
        self.active_plan = Some(plan.id.to_string());
        plan.id
    }

    /// Get the next unexecuted step of the active plan, if the breaker allows
    /// an attempt and the total budget hasn't been exceeded.
    pub fn next_step(&mut self, now_unix: u64) -> Option<&mut RecoveryStep> {
        let plan_id = self.active_plan.as_ref()?;
        let plan = self.plans.iter_mut().find(|p| p.id == *plan_id)?;

        if !self.breaker.is_allowed(now_unix) {
            return None;
        }
        self.breaker.before_attempt(now_unix);

        // Check total time budget
        if let Some(started) = plan.started_at_unix {
            if now_unix.saturating_sub(started) >= plan.max_total_time_sec {
                plan.completed = true;
                plan.succeeded = Some(false);
                return None;
            }
        } else {
            plan.started_at_unix = Some(now_unix);
        }

        plan.steps.iter_mut().find(|s| !s.executed)
    }

    /// Mark a step as executed with an outcome.
    pub fn complete_step(&mut self, step_id: &str, success: bool, now_unix: u64) {
        // Update the breaker
        if success {
            self.breaker.record_success(now_unix);
        } else {
            self.breaker.record_failure(now_unix);
        }

        // Update the step
        for plan in &mut self.plans {
            for step in &mut plan.steps {
                if step.id == step_id {
                    step.executed = true;
                    step.succeeded = Some(success);
                }
            }
        }

        // If the step succeeded, the plan is done (recovery achieved).
        // If it failed, try the next step; if no steps remain, mark failed.
        if success {
            if let Some(plan_id) = &self.active_plan {
                if let Some(plan) = self.plans.iter_mut().find(|p| p.id == *plan_id) {
                    plan.completed = true;
                    plan.succeeded = Some(true);
                }
            }
        } else {
            let Some(plan_id) = self.active_plan.as_ref() else {
                return;
            };
            let Some(plan) = self
                .plans
                .iter_mut()
                .find(|p| p.id.as_str() == plan_id.as_str())
            else {
                return;
            };
            let remaining = plan.steps.iter().any(|s| !s.executed);
            if !remaining {
                plan.completed = true;
                plan.succeeded = Some(false);
            }
        }
    }

    /// Roll back the active plan: mark all steps as not executed, reset the
    /// breaker to closed if it was tripped by this plan.
    pub fn rollback(&mut self) {
        if let Some(plan_id) = &self.active_plan {
            if let Some(plan) = self
                .plans
                .iter_mut()
                .find(|p| p.id.as_str() == plan_id.as_str())
            {
                for step in &mut plan.steps {
                    step.executed = false;
                    step.succeeded = None;
                }
                plan.completed = true;
                plan.succeeded = Some(false);
            }
        }
        self.breaker.state = BreakerState::Closed;
        self.breaker.consecutive_failures = 0;
        self.breaker.tripped_at_unix = None;
        self.active_plan = None;
    }

    /// Whether the active plan has completed (succeeded or failed).
    pub fn is_complete(&self) -> bool {
        self.active_plan
            .as_ref()
            .and_then(|id| {
                self.plans
                    .iter()
                    .find(|p| p.id.as_str() == id.as_str())
                    .map(|p| p.completed)
            })
            .unwrap_or(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn breaker_starts_closed_and_allows_calls() {
        let b = CircuitBreaker::new();
        assert!(b.is_allowed(0));
        assert_eq!(b.state, BreakerState::Closed);
    }

    #[test]
    fn breaker_trips_after_threshold_failures() {
        let mut b = CircuitBreaker::new();
        b.failure_threshold = 3;
        for i in 0..3 {
            b.record_failure(i);
        }
        assert_eq!(b.state, BreakerState::Open);
        assert!(b.is_tripped());
        // is_allowed returns true once the recovery timeout elapses
        // (a half-open trial would be permitted), but the breaker is still open.
        assert!(!b.is_allowed(5));
    }

    #[test]
    fn breaker_recovers_via_half_open_after_timeout() {
        let mut b = CircuitBreaker::new();
        b.failure_threshold = 2;
        b.recovery_timeout_sec = 10;
        b.record_failure(0);
        b.record_failure(1);
        assert_eq!(b.state, BreakerState::Open);
        assert!(!b.is_allowed(5)); // before timeout
        assert!(!b.is_allowed(5));
        // before_attempt moves open→half_open after timeout
        b.before_attempt(15);
        assert_eq!(b.state, BreakerState::HalfOpen);
        assert!(b.is_allowed(15));
        // Success in half-open: needs success_threshold (3) to close
        b.record_success(15);
        b.record_success(15);
        assert_eq!(b.state, BreakerState::HalfOpen);
        b.record_success(15);
        assert_eq!(b.state, BreakerState::Closed);
    }

    #[test]
    fn failure_in_half_open_trips_again() {
        let mut b = CircuitBreaker::new();
        b.failure_threshold = 2;
        b.recovery_timeout_sec = 10;
        b.record_failure(0);
        b.record_failure(1);
        b.before_attempt(15);
        assert_eq!(b.state, BreakerState::HalfOpen);
        b.record_failure(15);
        assert_eq!(b.state, BreakerState::Open);
    }

    #[test]
    fn build_plan_orders_by_success() {
        let mut p = RecoveryPlanner::new();
        let id = p.build_plan(
            "plan-1",
            vec![
                ("mtu_experiment".into(), 0.4),
                ("known_good_route".into(), 0.9),
                ("upstream_proxy".into(), 0.6),
            ],
            120,
        );
        let plan = p.plans.iter().find(|pl| pl.id == id).expect("plan");
        // First step should be highest estimated success
        assert_eq!(plan.steps[0].action, "known_good_route");
        assert_eq!(plan.steps[0].estimated_success, 0.9);
    }

    #[test]
    fn next_step_returns_first_unexecuted() {
        let mut p = RecoveryPlanner::new();
        p.build_plan("plan-2", vec![("a".into(), 0.5), ("b".into(), 0.6)], 120);
        let step = p.next_step(0).expect("first step");
        // Steps are sorted by estimated success descending, so "b" (0.6) is first
        assert_eq!(step.action, "b");
        assert!(!step.executed);
    }

    #[test]
    fn completing_step_succeeds_plan() {
        let mut p = RecoveryPlanner::new();
        p.build_plan("plan-3", vec![("a".into(), 0.5)], 120);
        let step = p.next_step(0).expect("step");
        let step_id = step.id.clone();
        p.complete_step(&step_id, true, 0);
        assert!(p.is_complete());
        assert_eq!(p.breaker.state, BreakerState::Closed);
    }

    #[test]
    fn failing_all_steps_fails_plan() {
        let mut p = RecoveryPlanner::new();
        p.build_plan("plan-4", vec![("a".into(), 0.5), ("b".into(), 0.6)], 120);
        let s1 = p.next_step(0).expect("s1").id.clone();
        p.complete_step(&s1, false, 0);
        let s2 = p.next_step(0).expect("s2").id.clone();
        p.complete_step(&s2, false, 0);
        assert!(p.is_complete());
        let plan = p.plans.iter().find(|pl| pl.id == "plan-4").expect("plan");
        assert_eq!(plan.succeeded, Some(false));
    }

    #[test]
    fn rollback_resets_plan_and_breaker() {
        let mut p = RecoveryPlanner::new();
        p.breaker.failure_threshold = 1;
        p.build_plan("plan-5", vec![("a".into(), 0.5)], 120);
        let s = p.next_step(0).expect("s").id.clone();
        p.complete_step(&s, false, 100);
        assert_eq!(p.breaker.state, BreakerState::Open);
        p.rollback();
        assert_eq!(p.breaker.state, BreakerState::Closed);
        assert_eq!(p.active_plan, None);
    }

    #[test]
    fn breaker_respects_recovery_timeout() {
        let mut b = CircuitBreaker::new();
        b.failure_threshold = 1;
        b.recovery_timeout_sec = 60;
        b.record_failure(0);
        assert_eq!(b.state, BreakerState::Open);
        assert!(!b.is_allowed(30));
        b.before_attempt(70);
        assert_eq!(b.state, BreakerState::HalfOpen);
        assert!(b.is_allowed(70));
    }
}

