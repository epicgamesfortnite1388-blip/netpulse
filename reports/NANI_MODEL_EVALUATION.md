# NANI Model Evaluation

## Status
No local model evaluated.

## Planned evaluation
- Compare deterministic rules vs Bayesian diagnosis vs full NANI on simulator scenarios.
- Metrics: Brier score, log loss, ECE, precision, recall, FPR, recovery success, time-to-recovery.
- Chronological train/validation/test splits (no random shuffling of correlated observations).

## Current
- Simulator scenarios exist in `simulation.rs`.
- Evaluation helpers exist in `evaluation.rs` and `validation.rs`.
- No model training or inference performed.
