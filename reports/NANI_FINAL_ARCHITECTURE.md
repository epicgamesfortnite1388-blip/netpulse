# NANI Final Architecture

## Layers
- Layer A — Rust Intelligence Core: implemented in `src-tauri/src/network_intelligence/`.
- Layer B — Mathematical Learning Engine: implemented (`math`, `bayesian`, `probability`, `diagnosis`, `route`, `bandit`, `drift`, `causal`).
- Layer C — Optional Local AI: not implemented; abstraction points exist but no runtime.
- Layer D — Application/UI: minimal; Tauri commands and event bus exist, web panels not implemented.
- Layer E — Optional Cloud Sync: not implemented beyond existing app services.

## Data flow
Observation → validation → diagnosis → candidate generation → policy filter → ranking → execution → independent verification → learning → monitoring. Reactive events via `EventBus` (`nani:event`).

## Key constraints
- Hard authorization and safety checks are enforced in recovery and registry.
- Missing measurements are never converted to zero (`ObservationValidity`, `Measurement::missing`).
- Correlated observations are handled via explicit dependency structures in diagnosis.

## Status
- Implemented and tested: Rust core modules listed above.
- Experimental: contextual bandits and causal evaluation (unit-tested, not real-world validated).
- Not implemented: local AI runtime, full UI, cloud sync.
