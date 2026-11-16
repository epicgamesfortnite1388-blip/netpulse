# FABLE — NANI Target Ownership Contract

One authoritative owner per piece of NANI state. Derived from tracing actual ownership today (re-validated): Rust (`network_intelligence/*` + `commands/nani.rs`) and Node (`naniService.ts` + `naniShadowHealthLoop.ts` + shared TS core).

## 1. Current ownership map (as traced)

| NANI state | Rust today | Node/TS today | Conflict? |
|---|---|---|---|
| API registry (entries, health, layers) | `api_intelligence/registry.rs` (in-memory + persistence.rs) | `naniService` registry + repo tables | **YES — two registries** |
| Probe execution | `monitor.rs` (DNS/TCP/TLS/HTTP real I/O) | `naniProbeAdapter.ts` (real I/O) | **YES — both probe** |
| Failure classification | `failure_classifier.rs` | `classifyApiFailure` (TS) | YES — dual classifier |
| Hypothesis posteriors | `DiagnosticEngine` (foundation/diagnosis) | TS `diagnose` (web mode only) | YES on desktop |
| Transition model | Rust `TransitionModel` (time-scaled) | TS ε-kernel (web mode) | Subset, no conflict in math — conflict in authority |
| Investigation lifecycle | `investigation.rs` (START→…→CANCEL, events) | shadow health pass (timer loop) | Different lifecycles, same concept |
| Learning profiles | `learning.rs` + `persistence.rs` | none (TS has no learning) | No overlap |
| Drift/changepoint | `drift.rs`, `changepoint.rs` | TS PageHinkley/Cusum (web) | Subset |
| Recovery planning/memory | `recovery.rs`, `recovery_memory.rs` | `RecoveryController` (TS, web mode) | Overlap in web mode |
| Events | Rust `EventBus` → Tauri `nani:event` + replay 256 | `RealtimeBus` `nani:*` topics → WS | Two channels, same semantics — both KEEP (transport per surface) |
| Persistence | Rust JSON store | SQLite repo tables (shadow) | YES — two stores |
| Calibration | evaluation.rs (batch) | metrics.ts (batch, web) | After T-05: Rust continuous |

## 2. Target ownership contract (binding on all agents)

**Rule O-1 — Single brain per surface.** Desktop: Rust is the ONLY NANI brain; Node runs zero NANI timers/loops. Web: TS core is the ONLY NANI brain. No mode runs both.

**Rule O-2 — Ownership by concern (desktop mode):**
| Concern | Authoritative owner | Adapter |
|---|---|---|
| Evidence & probe results | Rust `investigation.rs`/`monitor.rs` | TS `naniApi.ts` reads via Tauri commands |
| Posterior/transition/IG | Rust `diagnosis.rs`/`foundation.rs` | TS renders DTOs |
| Hypothesis taxonomy | Rust `Hypothesis::all()` | TS imports **shared data file** for labels only |
| Learning/drift/episodes | Rust | TS renders |
| Persistence | Rust `persistence.rs` | none |
| Recovery | Rust `recovery.rs` + `commands/nani.rs` | TS `RecoveryControls.tsx` invokes |
| Events | Rust `EventBus` | TS `naniEvents.ts` reducer (transport+dedupe only) |
| AI explanation | Rust `ai/` | TS displays |

**Rule O-3 — Web mode keeps the TS core** (`packages/shared/src/nani` + `naniService.ts`) but it is explicitly labeled a *subset*; the shared taxonomy file (T-06) is data both use; web never claims parity (fixes UI-002).

**Rule O-4 — No hidden synchronization.** Neither side may read the other's NANI state. Cross-checking (if ever wanted) is an explicit, batch, read-only comparison job — not a live link.

**Rule O-5 — Stable interfaces during migration.** The following must remain byte-compatible until closure: Tauri commands `nani_status`, `nani_start_investigation`, `nani_investigation_status`, `nani_poll_events`, `nani_math_*` (signatures); event envelope `{seq, event:{kind,payload}}`; web DTO shapes in `naniApi.ts`.

**Rule O-6 — Deprecated-but-not-removed list.** After T-01+T-05 closure, these Node services may be flagged deprecated in desktop mode (kept for web): `naniShadowHealthLoop` (desktop stop only — the class stays for web), `naniDiagnosticAdapter` (mapped through shared taxonomy). Nothing in this list is deleted by T-01; deletion decisions belong to later, separately approved tickets.

**Rule O-7 — Persisted data migration.** None required: Rust store and SQLite shadow store hold disjoint records; T-01 stops writes on the shadow side in desktop mode. Shadow SQLite history in desktop remains readable (observed history) — no schema change, no data loss.

**Rule O-8 — Partial failure.** If the Rust engine is unavailable in desktop mode (engine panic — `panic=abort` risk), the UI shows the honest offline/blocked state; it MUST NOT fall back to the Node NANI loops (fallback would silently re-introduce the second brain). Fail-over is a design decision reserved for a future approved ticket.

**Rule O-9 — Version compatibility.** Event `version` field (TS `NANI_EVENT_VERSION = 1`) increments only with a migration note; webview tolerates unknown kinds verbatim (existing reducer behavior) — keep.

## 3. Transition plan (incremental, per the mission's sequence)

1. **Introduce/verify the authoritative interface** (already exists: Tauri commands). Verify no desktop UI path reads Node NANI state (`naniApi.ts` verified; re-check at Gate A).
2. **Add parity tests** (cross-oracle fixture, parity matrix §6).
3. **Redirect one consumer at a time**: (a) T-01 stops Node loops in desktop; (b) T-06 routes classification labels through shared data; (c) T-05 sources calibration numbers from Rust.
4. **Verify integration** after each step (full relevant suites + one manual desktop run).
5. **Remove redundant code only after all consumers have migrated** — and only in separately approved tickets (T-03-style deletion list regenerated at that time).
6. **Full regression suite** before closure.
