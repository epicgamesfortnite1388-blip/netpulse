# N0_05 — End-to-End Integration Test (the acceptance gate)

Location: `src-tauri/src/network_intelligence/investigation.rs`, `mod tests` →
`n0_end_to_end_investigation_through_shared_registry_and_canonical_bus` (+ guard `n0_guard_old_wiring_produces_the_audited_defect`).

## Execution path (what the test actually does)

1. `(bus, rx) = EventBus::new()` — the canonical-bus shape with a collectable receiver (the `nani_poll_events` source).
2. `registry = ApiRegistry::new(bus.clone())` — ONE authoritative registry.
3. Deterministic local HTTP responder on `127.0.0.1:<ephemeral>` (no internet, no credentials).
4. `registry.register(ApiEntry::new("n0-test-api", …))` — the SAME mechanism that registers `netpulse-cloud`.
5. `InvestigationManager::new(bus.clone(), registry.clone(), learning)` + the same setup re-wiring `main.rs` performs (`set_registry`, `set_event_bus`).
6. Sharing proven by **Arc identity** (`shares_registry_with` / `shares_event_bus_with`), not by value equality.
7. Real investigation via the production entry point `mgr.start(...)` → background lifecycle thread.
8. Terminal wait via `mgr.status()` polling (6 s bound).

## Assertions (actual, executed)

- Outcome `Completed`; `observation_count > 0`; every observation's `api_id == "n0-test-api"`; `dns` and `tcp` layers genuinely `Ok`.
- `bus.replay_session(id)`: non-empty; ALL events carry the correct `investigation_id`; kinds include InvestigationStarted, StageStarted, ProbeStarted×4, ProbeCompleted×4, ObservationCreated, EvidenceAdded, AnalysisCompleted, StageCompleted, InvestigationCompleted; sequences strictly increasing (no duplicates).
- `bus.replay_since(0)` (the replay adapter `nani_poll_events` serves) contains the investigation.
- **Healthy leg**: NO `VerificationCompleted` (verify honestly skipped — must not fabricate verification from success).
- **Failing leg** (registered closed port): real failure observations, `AnalysisCompleted`, `VerificationCompleted` present, `EvidenceAdded{kind:"verify"}` present — the verify stage runs and reports honestly.
- **Late registration**: an API registered AFTER manager construction is visible to a subsequent investigation (Arc sharing, no re-sync).
- **Unregistered API**: never appears in any observation record.
- Responder threads detached (a hang bug explicitly prevented and commented).

## Regression validity (fails against the original broken wiring)

- Under the old construction the manager observed an empty registry → `observation_count == 0` → the test fails at the first observation assertion; events went to a bus this receiver never sees → the replay assertions fail too.
- The guard test pins the defect: old-style wiring yields `shares_* == false`, zero observations, and an empty app-bus receiver — with a comment explaining which defect it documents.

## Honesty boundaries

`EventBus::new()`'s receiver + `replay_since` replicate the `nani_poll_events` path exactly (same bus internals), but the **full Tauri AppHandle emission and the WebView listener are not exercised in-process** — the desktop-runtime hop is verified only by code trace + the existing `naniEvents.ts` reducer tests. Marked in Limitations; a packaged-app launch remains recommended before claiming visual E2E.
