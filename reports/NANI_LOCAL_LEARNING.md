# NANI Local Learning

## Implemented

`learning.rs` is the local adaptive engine. It is constructed once in `NaniState` and receives every live API probe from `MonitorLoop`:

- One measurement pipeline (`COLLECT → VALIDATE → NORMALIZE`) before any model update.
- Per-context robust profiles keyed by a local numeric context id.
- Hierarchical Beta-Bernoulli reliability per API.
- Bounded drift history (64 events, anomaly score ≥ 4 after ≥ 8 samples).
- Episode memory (bounded at 2000) with user corrections that do not change measurement quality.
- Correlation-adjusted evidence weights.
- User reset that deletes profiles, episodes, statistics and drift.

## Privacy

Stores numeric summaries, a local context id and short metric names. It does not store SSIDs, MAC addresses, private IPs, URLs, credentials or packet payloads. No network or LLM call is made by this module.

## Tested

- API probe updates hierarchical reliability; an unseen API stays conservative.
- Missing measurements are rejected, never counted as failure.
- Drift fires on a genuine spike after enough baseline samples.
- Reset removes personal state while the engine remains usable.
- Correlated probes get non-independent weights.
- Full Rust suite: 419 passed.

## Limits

- State is **in-memory only**; it resets when the app exits.
- Contexts are not yet selected from the live interface; the global context (0) is used.
- Episodes are created but not yet linked to recovery verification outcomes in the live loop.
- Reliability is not calibrated against real user data in this release.

## Deferred

- Persistence and migration for profiles/episodes/reliability.
- Context detection and per-network separation.
- Export/delete UI controls beyond the existing reset command.
