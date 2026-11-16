//! Live monitor loop.
//!
//! Polls each registered API at its retry-policy cadence, respects circuit
//! breakers (skipping tripped breakers except half-open trials), applies
//! bounded retries with jitter, and feeds every outcome into the API
//! registry. When a circuit breaker trips, a recovery plan is built and its
//! steps are executed on subsequent ticks.
//!
//! Runs on a background thread so the UI thread is never blocked. All probes
//! use bounded timeouts and never block the UI thread.

use crate::network_intelligence::api_intelligence::registry::{
    ApiEntry, ApiRegistry, Health, ProbeOutcomeRecord,
};
use crate::network_intelligence::api_model::{FailureCategory, RouteKind};
use crate::network_intelligence::events::{Event, EventBus};
use crate::network_intelligence::recovery::RecoveryPlanner;
use crate::network_intelligence::api_intelligence::monitor::probe_api;
use crate::network_intelligence::learning::LearningEngine;
use rand::Rng;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::thread;

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn unix_now_secs() -> u64 {
    unix_now_ms() / 1000
}

/// Bounded exponential backoff with jitter:
/// `t_n = min(t_max, t_0 * 2^n * U(0.8, 1.2))`.
///
/// Attempt `n` is 0-indexed. The result never exceeds `max_ms`. Jitter
/// prevents thundering-herd retries across multiple APIs recovering
/// simultaneously.
fn retry_backoff(attempt: u32, base_ms: u64, max_ms: u64) -> u64 {
    let base = base_ms.max(1);
    let max = max_ms.max(base);
    let exp = base.saturating_mul(2u64.saturating_pow(attempt));
    let jitter: f64 = rand::thread_rng().gen_range(0.8..1.2);
    (((exp as f64) * jitter).round() as u64).min(max)
}

/// Whether a failure category is transient and worth retrying.
///
/// Authentication failures (401/403) and rate limits (429) are NOT retried:
/// they are classification results indicating credential or policy problems,
/// not transient transport faults. Retrying them blindly would hammer an
/// endpoint that is explicitly rejecting us.
fn is_retryable(category: FailureCategory, health: Health) -> bool {
    if health == Health::Healthy {
        return false;
    }
    matches!(
        category,
        FailureCategory::TransportFailure
            | FailureCategory::TlsFailure
            | FailureCategory::DnsFailure
            | FailureCategory::Unknown
    )
}

/// The live monitor loop.
#[derive(Clone)]
pub struct MonitorLoop {
    registry: ApiRegistry,
    events: EventBus,
    recovery: Arc<Mutex<RecoveryPlanner>>,
    /// Phase 4 local learning. Every probe outcome is recorded here; the engine
    /// is advisory and never changes the probe or recovery decision.
    learning: Arc<Mutex<LearningEngine>>,
    poll_interval_ms: u64,
}

impl MonitorLoop {
    pub fn new(
        registry: ApiRegistry,
        events: EventBus,
        recovery: Arc<Mutex<RecoveryPlanner>>,
        learning: Arc<Mutex<LearningEngine>>,
    ) -> Self {
        Self {
            registry,
            events,
            recovery,
            learning,
            poll_interval_ms: 5000, // poll every 5s by default
        }
    }

    /// Spawn the background monitor loop. Returns a JoinHandle.
    pub fn spawn(self) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            loop {
                self.tick();
                thread::sleep(Duration::from_millis(self.poll_interval_ms));
            }
        })
    }

    /// One pass: probe every due API, then execute any pending recovery step.
    fn tick(&self) {
        let ids = self.registry.ids();
        for api_id in ids {
            let _ = self.probe_api(&api_id);
        }
        self.execute_recovery_steps();
    }

    /// Probe one API, respecting cadence and circuit breaker.
    fn probe_api(&self, api_id: &str) -> Result<(), String> {
        let entry = self
            .registry
            .entry(api_id)
            .ok_or_else(|| format!("unknown api {api_id}"))?;
        let mut state = self
            .registry
            .state(api_id)
            .ok_or_else(|| format!("no state for {api_id}"))?;

        // Cadence check: don't probe more often than initial_backoff_ms.
        let now = unix_now_ms();
        if let Some(last) = state.last_probe_ms {
            if now.saturating_sub(last) < entry.retry.initial_backoff_ms {
                return Ok(()); // not yet due
            }
        }

        // Circuit breaker gating.
        let now_secs = unix_now_secs();
        if !state.circuit_breaker.is_allowed(now_secs) {
            return Ok(()); // tripped: skip until half-open trial allowed
        }
        state.circuit_breaker.before_attempt(now_secs);

        // Probe with bounded retries + jitter.
        let outcome = self.probe_with_retries(&entry);

        // Record outcome (updates breaker, emits events).
        self.registry.record_probe(&outcome);

        // Phase 4: feed the real probe outcome into local learning. This is
        // observational only; a learning failure must never affect probing.
        if let Ok(mut learning) = self.learning.lock() {
            let healthy = matches!(outcome.health, Health::Healthy);
            learning.record_api_probe(
                &outcome.api_id,
                healthy,
                outcome.latency_ms,
                outcome.timestamp_ms,
            );
        }

        // If the breaker tripped, trigger recovery.
        let updated = self.registry.state(api_id).unwrap_or(state);
        if updated.circuit_breaker.is_tripped() {
            self.trigger_recovery(api_id, &outcome);
        }

        Ok(())
    }

    /// Probe an API with bounded retries and jitter.
    ///
    /// Only transient failures (transport/TLS/DNS/unknown) are retried. Auth
    /// and rate-limit failures are not retried. Each retry waits an
    /// exponentially larger, jittered delay.
    fn probe_with_retries(&self, entry: &ApiEntry) -> ProbeOutcomeRecord {
        let mut last_outcome: Option<ProbeOutcomeRecord> = None;
        let max_attempts = entry.retry.max_attempts.max(1);

        for attempt in 0..max_attempts {
            let outcome = probe_api(entry, None);
            last_outcome = Some(outcome.clone());

            if !is_retryable(outcome.category, outcome.health)
                || attempt + 1 >= max_attempts
            {
                break;
            }

            let delay_ms = retry_backoff(
                attempt,
                entry.retry.initial_backoff_ms,
                entry.retry.max_backoff_ms,
            );
            thread::sleep(Duration::from_millis(delay_ms));
        }

        last_outcome.expect("at least one attempt")
    }

    /// Trigger a recovery plan for a tripped breaker, unless one is active.
    fn trigger_recovery(&self, api_id: &str, outcome: &ProbeOutcomeRecord) {
        let mut recovery = self.recovery.lock().unwrap_or_else(|p| p.into_inner());

        // Don't double-spawn while a plan is active/incomplete.
        if recovery.active_plan.is_some() && !recovery.is_complete() {
            return;
        }

        let actions = self.recovery_actions(api_id, &outcome);
        let plan_id = format!("recovery__{api_id}__{}", unix_now_ms());
        recovery.build_plan(api_id, &plan_id, actions, 120); // 2 min max

        self.events.emit(Event::RecoveryStarted {
            api_id: api_id.to_string(),
            plan_id,
        });
    }

    /// Candidate recovery actions, ordered least-intrusive first.
    fn recovery_actions(&self, api_id: &str, outcome: &ProbeOutcomeRecord) -> Vec<(String, f64)> {
        let entry = self.registry.entry(api_id);
        let mut actions: Vec<(String, f64)> = Vec::new();

        // 1. Verify the direct route (least intrusive).
        actions.push(("verify_direct".into(), 0.5));

        // 2. Test an approved upstream if any are authorized.
        if let Some(entry) = entry {
            let has_upstream = entry.upstreams.iter().any(|u| u.authorized);
            if has_upstream {
                actions.push(("test_approved_upstream".into(), 0.4));
            }
        }

        // 3. Restore previous known-good route (last resort).
        actions.push(("restore_known_good".into(), 0.3));

        actions
    }

    /// Execute the next step of the active recovery plan, if the breaker
    /// allows an attempt (half-open trial). One step per tick; observe and
    /// replan (model predictive control).
    fn execute_recovery_steps(&self) {
        let now_secs = unix_now_secs();
        let mut recovery = self.recovery.lock().unwrap_or_else(|p| p.into_inner());

        // No active plan, or already complete: nothing to do.
        let Some(api_id) = recovery.active_api.clone() else {
            return;
        };
        if recovery.is_complete() {
            return;
        }

        let Some(mut step) = recovery.next_step(now_secs) else {
            return; // breaker not yet in half-open, or no unexecuted steps
        };
        let step_id = step.id.clone();

        // Execute the step: probe the API once.
        let entry = match self.registry.entry(&api_id) {
            Some(e) => e,
            None => {
                recovery.complete_step(&step_id, false, now_secs);
                return;
            }
        };
        let outcome = self.probe_with_retries(&entry);
        let success = matches!(outcome.health, Health::Healthy);

        recovery.complete_step(&step_id, success, now_secs);

        // Emit step completion.
        self.events.emit(Event::RecoveryStepCompleted {
            plan_id: recovery.active_plan.clone().unwrap_or_default(),
            step_id,
            success,
        });

        // If the plan is now complete, emit the terminal event.
        if recovery.is_complete() {
            let plan_succeeded = recovery
                .plans
                .iter()
                .find(|p| p.id == recovery.active_plan.as_deref().unwrap_or(""))
                .and_then(|p| p.succeeded)
                .unwrap_or(false);
            if plan_succeeded {
                self.events.emit(Event::RecoveryCompleted {
                    api_id,
                    plan_id: recovery.active_plan.clone().unwrap_or_default(),
                    success: true,
                });
            } else {
                self.events.emit(Event::RecoveryCompleted {
                    api_id,
                    plan_id: recovery.active_plan.clone().unwrap_or_default(),
                    success: false,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network_intelligence::api_intelligence::registry::{ApiEntry, UpstreamRoute};
use crate::network_intelligence::events::{Event, EventBus};

    #[test]
    fn retry_backoff_is_bounded_and_jittered() {
        let b0 = retry_backoff(0, 1000, 30000);
        assert!(b0 >= 800 && b0 <= 1200, "base backoff with jitter: {b0}");
        let b1 = retry_backoff(1, 1000, 30000);
        assert!(b1 >= 1600 && b1 <= 2400, "2x backoff: {b1}");
        let b_large = retry_backoff(20, 1000, 30000);
        assert!(b_large <= 30000, "capped at max: {b_large}");
        // Different attempts should differ (jitter).
        let mut diff = 0;
        for _ in 0..20 {
            if retry_backoff(2, 1000, 30000) != retry_backoff(2, 1000, 30000) {
                diff += 1;
            }
        }
        assert!(diff > 0, "jitter produces varied delays");
    }

    #[test]
    fn is_retryable_excludes_auth_and_rate_limit() {
        assert!(!is_retryable(FailureCategory::AuthenticationFailure, Health::Degraded));
        assert!(!is_retryable(FailureCategory::RateLimited, Health::Degraded));
        assert!(!is_retryable(FailureCategory::ServerFailure, Health::Unhealthy));
        assert!(!is_retryable(FailureCategory::HttpError, Health::Degraded));
        assert!(is_retryable(FailureCategory::TransportFailure, Health::Unhealthy));
        assert!(is_retryable(FailureCategory::TlsFailure, Health::Unhealthy));
        assert!(is_retryable(FailureCategory::DnsFailure, Health::Unhealthy));
        assert!(is_retryable(FailureCategory::Unknown, Health::Unhealthy));
        assert!(!is_retryable(FailureCategory::TransportFailure, Health::Healthy));
    }

    #[test]
    fn recovery_actions_order_least_intrusive_first() {
        let bus = EventBus::default();
        let reg = ApiRegistry::new(bus);
        let mut entry = ApiEntry::new("xkiro", "xKiro", "https://api.xkiro.com/v1");
        entry.upstreams.push(UpstreamRoute {
            id: "u1".into(),
            category: "residential".into(),
            authorized: true,
            tls_verified: true,
        });
        reg.register(entry);
        let ml = MonitorLoop::new(
            reg,
            EventBus::default(),
            Arc::new(Mutex::new(RecoveryPlanner::new())),
            Arc::new(Mutex::new(LearningEngine::new())),
        );
        let acts = ml.recovery_actions("xkiro", &ProbeOutcomeRecord {
            timestamp_ms: 0,
            api_id: "xkiro".into(),
            health: Health::Unhealthy,
            category: FailureCategory::TransportFailure,
            route: RouteKind::Direct,
            layers: vec![],
            latency_ms: None,
        });
        assert_eq!(acts[0].0, "verify_direct");
        assert!(acts.iter().any(|(a, _)| a == "test_approved_upstream"));
        assert_eq!(acts.last().map(|(a, _)| a.as_str()), Some("restore_known_good"));
    }
}
