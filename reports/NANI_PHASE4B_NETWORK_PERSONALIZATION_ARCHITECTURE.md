# Phase 4B - Network Personalization Architecture

## Objective
Make observations belong to a local network profile instead of one global model.

## Inspected
context/context_identity.rs, context/network_profiles.rs, context/transitions.rs, hierarchical.rs, learning.rs.

## Design
NetworkProfileEngine coordinates ContextTransitionTracker, ProfileStore and HierarchicalBetaBernoulli. LearningEngine delegates personalization to it instead of owning parallel maps.

## Implemented
- context/engine.rs: lifecycle, transitions, metric/outcome recording, status, reset/delete, snapshots.
- learning.rs: owns the engine, loads/saves under the app data dir.
- commands/nani.rs + main.rs: status, transitions, context observe, delete IPC; profile load at boot.

## Tests
New/returning contexts, isolation, invalid/missing values, transitions, deletion, reset, snapshot round-trip, corrupt snapshot rejection.

## Automatic context collection
context/collector.rs runs a fixed, read-only PowerShell query (12 s timeout, 16 KiB cap) every 120 s, classifies the active adapter, and selects the local profile. It never reads SSIDs, MACs, IPs or payloads. On failure it returns `None`; no context is invented.

## Limitation
Adapter classification is name-based and PowerShell startup costs roughly one second every two minutes. It was unit-tested but not exercised against every adapter driver.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3, 200 iters): update 139.2us, rank 4487.7us, route 0.1us.
