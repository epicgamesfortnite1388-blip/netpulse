# Phase 4B - Local Baseline Storage

## Objective
Persist personalization without corruption or unbounded growth.

## Implementation
context/storage.rs writes a versioned JSON envelope to <dataDir>/nani/network_profiles.json via temp file, sync_all, rename. Loads cap at 4 MiB, validate schema version and reject invalid model parameters.

The snapshot includes contexts, current id, bounded transitions, metric profiles and hierarchical posteriors.

## Tests
Missing file -> clean; save/load round-trip; corrupt JSON rejected; unsupported version rejected; invalid kappa rejected on restore.

## Limitation
Writes are synchronous after accepted probes when a path is configured. No encryption at rest; the file contains numeric summaries and random ids only.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3, 200 iters): update 139.2us, rank 4487.7us, route 0.1us.
