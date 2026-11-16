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
//!   - events          — reactive event bus (Tauri `nani:event` + internal channel)
//!   - math            — numerical foundations (log-sum-exp, stable sigmoid, etc.)
//!   - probability     — Beta-Bernoulli conjugate model, categorical distributions
//!   - bayesian        — priors, posteriors, entropy, KL divergence, confidence
//!   - diagnosis       — hypothesis space, dynamic Bayesian diagnosis, information gain
//!   - api_model       — API health model (math), failure classification, logistic regression
//!   - route           — route evaluation, multi-objective optimization, Pareto, CVaR, LCB
//!   - bandit          — contextual bandit, Thompson sampling, reward, safe filtering
//!   - drift           — CUSUM / Page-Hinkley change detection
//!   - recovery        — recovery planning, circuit breaker, rollback
//!   - causal          — causal outcome tracking (ATE with identifiability gating)
//!   - evaluation      — chronological diagnosis accuracy, micro-benchmarks
//!   - simulation      — deterministic network simulator
//!   - validation      — Brier score, log loss, expected calibration error
//!   - persistence     — versioned local storage of observations & model state
//!
//! Every module keeps pure mathematics separate from Tauri IPC plumbing, is
//! numerically stable (log probabilities, no silent NaN replacement), and is
//! covered by deterministic unit tests.

pub mod ai;
pub mod api_model;
pub mod bandit;
pub mod bayesian;
pub mod causal;
pub mod config_intelligence;
pub mod context;
pub mod diagnosis;
pub mod drift;
pub mod episodes;
pub mod events;
pub mod evaluation;
pub mod graph;
pub mod hardware;
pub mod hierarchical;
pub mod learning;
pub mod math;
pub mod robust_stats;
pub mod persistence;
pub mod probability;
pub mod recovery;
pub mod recovery_memory;
pub mod route;
pub mod sequential;
pub mod simulation;
pub mod timeseries;
pub mod information_theory;
pub mod changepoint;
pub mod api_intelligence;
pub mod evidence;
pub mod validation;
pub mod investigation;
pub mod foundation;
