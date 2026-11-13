//! Network Intelligence — NANI (NetPulse Adaptive Network Intelligence).
//!
//! A mathematical engine that learns how networks behave, understands why
//! connectivity fails, predicts which permitted action is most likely to work,
//! selects the best diagnostic experiment, performs safe recovery, verifies the
//! outcome, and improves its future decisions.
//!
//! Design constraints (from the specification):
//!   - Security, authorization, certificate verification and hard resource
//!     limits are constraints, not soft preferences.
//!   - Never treat missing data as zero.
//!   - Never disable TLS verification to make a proxy work.
//!   - Never claim a causal effect where controlled evidence is insufficient.
//!   - No empty functions or placeholder implementations reported as complete.
//!
//! Structure:
//!   - math         — numerical foundations (log-sum-exp, stable sigmoid, etc.)
//!   - probability  — Beta-Bernoulli conjugate model, categorical distributions
//!   - bayesian     — priors, posteriors, entropy, KL divergence, confidence
//!   - diagnosis    — hypothesis space, dynamic Bayesian diagnosis, information gain
//!   - api_model    — API health model, failure classification, logistic regression
//!   - route        — route evaluation, multi-objective optimization, Pareto, CVaR, LCB
//!   - bandit       — contextual bandit, Thompson sampling, reward, safe filtering
//!   - drift        — CUSUM / Page-Hinkley change detection
//!   - recovery     — recovery planning, circuit breaker, rollback
//!   - simulation   — deterministic network simulator
//!   - validation   — Brier score, log loss, expected calibration error
//!
//! Every module keeps pure mathematics separate from Tauri IPC plumbing, is
//! numerically stable (log probabilities, no silent NaN replacement), and is
//! covered by deterministic unit tests.

pub mod api_model;
pub mod bandit;
pub mod bayesian;
pub mod causal;
pub mod diagnosis;
pub mod drift;
pub mod evaluation;
pub mod math;
pub mod probability;
pub mod recovery;
pub mod route;
pub mod simulation;
pub mod validation;
