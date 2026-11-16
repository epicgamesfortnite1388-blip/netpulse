# N0_01 — Baseline and Initialization Map

Date: 2026-11-16 23:05–23:55. Implementer: Will (Senior Developer). Reviewer: Kim (pending).

## Baseline at mission start

| Item | Value |
|---|---|
| Branch / HEAD | `main` / `005de03` |
| Working tree | **Concurrent user agent active** (in-flight edits to `diagnosis.rs`, `evaluation.rs`, `persistence.rs`, `validation.rs`, web UI brand/connection work, new untracked `apps/web/src/features/connection/*` created 22:28–22:30) |
| Pre-change test results (executed) | investigation: 8 passed · full Rust: 532 passed 0 failed 2 ignored (after N0 edits; before edits the user tree had transient compile errors from in-flight calibration work — see Limitations) |

## Initialization map (verified current, by symbol)

```
tauri Builder
 └─ .manage(NaniState)                      main.rs:238
     ├─ registry:     Mutex<ApiRegistry>            (instance R1, placeholder bus)
     ├─ investigations: InvestigationManager      (placeholder bus B0, own registry R2, own learning L2)
     └─ persistence/events/math/recovery/ai
 └─ .setup(handle)                           main.rs:391
     ├─ (nani_bus, nani_rx) = EventBus::new()             ← THE canonical bus
     ├─ nani_bus.set_app(handle)                          ← webview delivery
     ├─ state.registry.set_event_bus(nani_bus)            (R1 now canonical)
     ├─ state.registry.register(netpulse-cloud)           (main.rs:416)
     ├─ [N0] investigations.set_registry(R1.clone())      ← Arc-shared (NANI-001 fix)
     ├─ [N0] investigations.set_event_bus(nani_bus)       ← Arc-shared (NANI-002 fix)
     ├─ PersistenceStore::new(data_dir)                   (unchanged; writers are N2)
     └─ MonitorLoop::new(R1.clone(), nani_bus, …).spawn()
```

Key type facts that shaped the fix (verified in source):
- `ApiRegistry { inner: Arc<Mutex<ApiRegistryInner>>, events: EventBus }` with `#[derive(Clone)]` → **clone = shared handle**, later registrations visible everywhere.
- `EventBus { inner: Arc<Mutex<EventBusInner>> }` with `#[derive(Clone)]` → same sharing semantics; one seq space, one replay buffer.

Therefore the fix is *rewiring at setup*, not restructuring ownership: the placeholders remain until setup replaces them (no UI can start an investigation before setup completes).
