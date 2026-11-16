# N0_02 — Shared API Registry Fix (NANI-001)

## Original behavior

`InvestigationManager` was constructed with `ApiRegistry::new(EventBus::default())` — a second, **empty** registry. The real `netpulse-cloud` API was registered only into `state.registry`. `run_observe_stage` iterated `registry.ids()` → empty → **zero probes, always**.

## Actual change

1. `investigation.rs` — new method:
   - `pub fn set_registry(&mut self, registry: ApiRegistry)` with a doc comment stating the Arc-sharing semantics and the "call once at setup" rule.
   - `#[cfg(test)] pub fn shares_registry_with(&self, other: &ApiRegistry) -> bool` → `self.registry.shares_state_with(other)` → `Arc::ptr_eq` on the registry internals (proves instance identity, not snapshot equality).
2. `api_intelligence/registry.rs` — test-only accessor `shares_state_with` (`Arc::ptr_eq(&self.inner, &other.inner)`).
3. `main.rs` setup — after `registry.register(netpulse-cloud)`, before `MonitorLoop::spawn`:
   `investigations.set_registry(state.registry.lock().unwrap().clone())`.

## Why this fixes it

`ApiRegistry::clone()` shares the `Arc<Mutex<ApiRegistryInner>>` — the manager observes the **same** registry object the health-check command and MonitorLoop use. Later registrations (the app's or a future user-editable registry, N1.2) are visible to every investigation started afterwards, with no copy synchronization anywhere.

## Constraints honored

- No second registry; no sync loops; no hardcoding of `netpulse-cloud` into the engine (the manager still discovers whatever is registered).
- Initialization order deterministic: registration → share → monitor spawn.

## Tests proving it (all in `investigation.rs::tests`, executed)

| Test | Asserts |
|---|---|
| `n0_end_to_end_investigation_through_shared_registry_and_canonical_bus` | `shares_registry_with` is true (Arc identity); registered `n0-test-api` discovered and actually probed (observations recorded, dns+tcp layers Ok against a real local endpoint); a LATER-registered `n0-late-api` is visible to a subsequent investigation; an unregistered API never appears in any observation record |
| `n0_guard_old_wiring_produces_the_audited_defect` | Old-style construction yields `shares_registry_with == false`, zero observations — the audited defect, guarded |
