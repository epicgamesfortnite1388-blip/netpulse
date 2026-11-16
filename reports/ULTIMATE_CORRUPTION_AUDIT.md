# ULTIMATE CORRUPTION AUDIT

**Audit date:** 2026-11-16. Prioritized by startup → connection → entitlement → NANI evidence → security → persistence → UI. **[V]** verified from code/compiler · **[A]** analysis · **[F]** fixed this audit.

---

## 1. Confirmed corrupt / incomplete code

### C1 — Stale enum binding in InterfaceCheck likelihood [V] [F] [HIGH]
`src-tauri/src/network_intelligence/diagnosis.rs:307`. The user's uncommitted refactor removed `Hypothesis::LocalInterface` from the enum (13 → 19 hypotheses) but left `LocalInterface => 0.97` in the `InterfaceCheck` signature match. In Rust a bare capitalized identifier is an **irrefutable binding**, so it matched every hypothesis: all 19 got a 0.97 failure probability and the `Gateway`/`_` arms were unreachable. The compiler emitted `unreachable pattern` ×2, `unused variable`, and `non_snake_case` warnings.
- **Impact:** the InterfaceCheck probe was uninformative; it could never discriminate gateway failure. NANI evidence integrity degraded silently while tests still passed.
- **Fix applied:** removed the stale arm; `Gateway => 0.25, _ => 0.05` now applies. Added regression test `interface_check_failure_is_not_uniformly_shared`. Compiler warnings gone; 529 tests pass.

### C2 — Correlation-window reset never fires [V] [F] [HIGH]
`diagnosis.rs:622` set `self.previous_timestamp = Some(result.timestamp)` **before** the gap check at `:629-634` that computes `result.timestamp.saturating_sub(prev)`. After the overwrite the gap is always 0, so `observation_history.clear()` never executed. The comment promised "A long gap starts a new window"; in reality probes from hours earlier kept discounting new evidence forever.
- **Fix applied:** capture `previous` before advancing it, use it for the gap check, then assign `previous_timestamp`. Added regression test `long_gap_starts_a_fresh_correlation_window`. 529 tests pass.

### C3 — Serialization failures wrote empty files [V] [F] [HIGH]
`src-tauri/src/network_intelligence/persistence.rs:197-198, 209, 256`: `serde_json::to_string(...).unwrap_or_default()` turned any serialization error into an empty string, which was then written as a blank JSONL line or as an empty `model_state.json` and **atomically renamed over good state** — irrecoverable corruption.
- **Fix applied:** all three sites now `map_err` into `std::io::Error(InvalidData)` and propagate. Serialization failure now aborts the write and leaves the previous good file intact.

### C4 — Orphan corrupt source file [V] [UNFIXED — dead, no consumer]
`apps/web/src/features/nani-memory` (extensionless file, only one under source). Contains `useNaniActionHistory()` using undefined `useCallback` and `usePersistentState`; no imports reference it. It would break typechecking if imported. Classified as **REMOVE** in the legacy plan, but not deleted (no blind deletion without owner confirmation).

### C5 — Malformed formatting artifact [V] [LOW]
`apps/api/src/services/vpnSelfTestService.ts:248`: `return false;    } catch {` on one line — cosmetic evidence of a patched/generated section. No functional impact.

### C6 — Verify stage logically inverted [V] [UNFIXED — needs design decision]
`src-tauri/src/network_intelligence/investigation.rs:726-741`: `run_verify_stage` always re-probes `api_ids[0]` (first registered API), not the API implicated by the diagnosis, and sets `verified = health == Healthy`. The completion text (`investigation.rs:512-516`) then says the failure hypothesis was "confirmed" precisely when the API is healthy — the opposite of verification. Tests cover lifecycle/cancel/history but not diagnostic correctness. This is a correctness bug in the advertised NANI workflow; fixing it requires defining which API/hypothesis to verify and updating the narrative → deferred to Stage D with an owner decision.

### C7 — Evidence gap plus +inf poisoning [V]/[A] [UNFIXED]
- `bayesian.rs:198-201` preserves `+inf` likelihoods; `math.rs:95-105` then computes `+inf − +inf = NaN`, `softmax` returns `None`, all probabilities become `0.0`. No test covers `+inf`. Reachable only if a caller supplies a certain-outcome likelihood. **[A]** analysis; the latest commit fixed a related underflow case, so the author is aware of the area.
- `evidence/validation.rs:71` accepts future timestamps; `:41-55` rejects several legitimate `MeasureState` variants. **[V]/[A]** — see NANI audit.

### C8 — Startup unguarded mutex unwrap [V] [UNFIXED — MED]
`src-tauri/src/main.rs:394-431`: 6 `.unwrap()` calls in `setup()` acquiring `NaniState` mutexes. A poisoned lock panics before window presentation (`main.rs:439`), producing a silent startup failure. Should use `unwrap_or_else(|p| p.into_inner())` as the rest of the codebase does.

### C9 — Parse/normalization defects [V] [UNFIXED — MED]
- `diagnosis.rs:219-390`: large hardcoded prior/likelihood tables — structurally valid but expert-assigned, not measured (see mathematical audit).
- `probability.rs:163-183`: `credible_interval` claims quantile search but always uses a normal approximation.
- `drift.rs:126-138`: Page-Hinkley triggers on `sum_ph > lambda` rather than the textbook `max − PH`.
- `changepoint.rs:115-117,219`: BOCPD documents a normal-inverse-gamma model but uses fixed variance.

## 2. Compiler warning baseline [V]
`cargo check` on a clean build produced **279 warnings**: unused imports across the new NANI modules, plus the C1 warnings (now gone). `cargo clippy` and `cargo fmt` are **not installed** in this toolchain, so lint/format gates could not be executed. This is an environment limitation, recorded not hidden.

## 3. Non-corruption lookalikes (verified intact) [V]
- `serde_json` round-trips in the local SQLite client use a `quick_check` integrity gate and quarantine corrupt DBs rather than deleting them (`db/client.ts:98-167`).
- `dpapi.rs` unsafe FFI is scoped and fail-closed on tampered blobs (`dpapi.rs:263-274`).
- `capabilities/default.json` and CSP are narrow — no shell/fs/http plugins, `script-src 'self'` with no `unsafe-eval`.

## 4. Repair summary

| ID | Defect | Fix | Verification |
|---|---|---|---|
| C1 | stale `LocalInterface` binding | arm removed | compiler warning gone; regression test passes |
| C2 | correlation window never clears | timestamp captured before overwrite | regression test passes |
| C3 | empty files on serialization error | error propagation | full suite 529 pass |

All other items remain **unfixed** with reasons above and are tracked in `ROADMAP.md`.
