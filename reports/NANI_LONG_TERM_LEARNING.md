# NANI Long-Term Learning

## Implemented
- Persistence store with versioned model state and observations.
- Recovery memory for verified outcomes.
- Calibration metrics in `validation.rs` / `evaluation.rs`.

## Not implemented
- Schema migrations beyond current version.
- Retention policies, duplicate detection, model rollback automation.
- Traceability of learned models to training data versions.

## Status
- Storage foundation exists and tests pass.
- Advanced knowledge management pending.
