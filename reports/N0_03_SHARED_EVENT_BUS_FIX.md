# N0_03 — Shared Event Bus Fix (NANI-002)

## Original behavior

The manager held `EventBus::default()` — an isolated bus with no AppHandle and a private replay buffer. Lifecycle events were emitted into the void: never on the `nani:event` Tauri channel, never in the `nani_poll_events` replay.

## Actual change

1. `investigation.rs` — `pub fn set_event_bus(&mut self, bus: EventBus)` (doc comment: one sequence space, one replay buffer, call before any investigation starts — a running lifecycle already cloned its bus).
2. `#[cfg(test)] shares_event_bus_with` → `EventBus::shares_state_with` (`Arc::ptr_eq`), added test-only to `events/mod.rs`.
3. `main.rs` setup — `investigations.set_event_bus(nani_bus.clone())` immediately after the registry share.

## Why this fixes it

`EventBus` is `Arc`-internally; the manager now publishes on the **same instance** the MonitorLoop uses — the one wired to the AppHandle (`set_app`) whose `mpsc` receiver is drained by `nani_poll_events`. Every lifecycle event (`InvestigationStarted`, `InvestigationStageStarted/Completed`, `ProbeStarted`, `ProbeCompleted`, `ObservationCreated`, `EvidenceAdded`, `HypothesisCreated/Updated`, `AnalysisCompleted`, `VerificationCompleted`, `InvestigationCompleted/Failed/Cancelled`) now flows producer → canonical bus → Tauri emission + bounded replay → frontend.

## Delivery-failure honesty

`EventBus::emit` already returns `()` but logs via the `let _ = app.emit(...)` pattern; no false success is manufactured (events are recorded in the replay buffer regardless of webview delivery, and `nani_poll_events` is the polling fallback by design). A missing AppHandle (pre-setup/web mode) degrades to replay-polling — existing documented behavior, unchanged.

## No duplicate delivery

One bus = one seq counter. The integration test asserts strictly increasing sequences in the replay and exactly-once lifecycle kinds. The reducer's dedupe (`${seq}:${type}`) remains the second layer.

## Tests proving it (executed)

| Test | Asserts |
|---|---|
| `n0_end_to_end…` | All 8 expected lifecycle kinds present on the canonical bus via `replay_session(id)`; every event's `investigation_id` matches; seqs strictly ordered; `replay_since(0)` (the `nani_poll_events` source) contains the investigation; healthy-network leg has NO fabricated `VerificationCompleted`; failing-network leg HAS it plus `verify` evidence |
| `n0_guard_old_wiring_produces_the_audited_defect` | Old wiring: `shares_event_bus_with == false` and the app-bus receiver receives NOTHING from an investigation |
