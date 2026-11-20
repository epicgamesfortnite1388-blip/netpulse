# NANI_AUDIT_01 — Actual Architecture and Call Graph (traced, not assumed)

## 1. The three NANI instances inside one desktop app

Traced in `src-tauri/src/main.rs:238–436`:

| Instance | Constructed at | Gets the real event bus? | Gets registered APIs? |
|---|---|---|---|
| `NaniState.registry` (health/monitor/explain) | main.rs:241 | ✅ (`set_event_bus(nani_bus)` main.rs:399) | ✅ `netpulse-cloud` (main.rs:416) |
| `NaniState.investigations` → `InvestigationManager::new(EventBus::default(), ApiRegistry::new(EventBus::default()), …)` | main.rs:243–249 | ❌ **placeholder bus, never re-wired** | ❌ **its own empty registry, never populated** |
| `MonitorLoop` (background prober) | main.rs:435 | ✅ (built from `state.registry` clone + `nani_bus`) | ✅ (same 1 API) |

**Nothing anywhere in the tree registers an API into the InvestigationManager's registry or re-wires its bus** — verified by grepping every `register(`/`set_event_bus`/`set_app` call site.

## 2. The actual execution graph, with link status

```
USER ACTION (NaniPage "Start investigation")
 → startInvestigation()                    naniApi.ts:198        WIRED
 → tauriInvoke nani_start_investigation    commands/nani.rs:121  WIRED (bg thread, investigation.rs:235)
 → run_lifecycle                            investigation.rs:365
    → OBSERVE run_observe_stage :528       ❌ BREAKS: iterates manager's EMPTY registry
        → probe_api()                       monitor.rs            never reached (0 APIs)
        → EvidenceAdded events              ❌ BREAKS: emitted on placeholder bus
    → ANALYZE run_analyze_stage :637       ⚠️ runs, but is a per-layer frequency counter —
        (12-hypothesis Bayesian engine NOT invoked — 0 references in file)
    → VERIFY run_verify_stage :716         ❌ BREAKS: `registry.ids()` empty → returns false
    → COMPLETE/FAIL                        status recorded in memory (real, listable)
 → live events to webview (`nani:event`)   ❌ NEVER DELIVERED (placeholder bus has no AppHandle)
 → nani_poll_events replay                 ❌ replay buffer is the REAL bus's — investigation events absent
 → NaniPage evidence/hypotheses tabs       ❌ derive from the event stream (`deriveEvidence(events)`
                                              NaniPage.tsx:1053) → permanently empty for investigations
 → persistence of investigation             ❌ in-memory only (`max_history: 50`, investigation.rs:191)
 → report artifact                          ❌ none exists (nani-reports page unrouted/dead)
```

## 3. Parallel paths that DO work

| Path | Status |
|---|---|
| `nani_health_check_all` (user button) | ✅ probes `netpulse-cloud` (real HTTP, 4 layers), records probes into `state.registry`, feeds `math.observe_probe()` (nani.rs:288–303) — the only place the Bayesian engine's posteriors move from UI action |
| `MonitorLoop` timer | ✅ polls the 1 API, events reach the webview (real bus), learning engine observes |
| `nani_status` / `nani_math_*` (13 commands) | ✅ read real engine state |
| `nani_explain` (Copilot core) | ✅ builds facts from `state.registry.states()` + learning status (nani.rs:340–405) |
| Web-mode `/nani/*` (sidecar) | ✅ TS NaniService with its own registry: `backend` + `telegram` (app.ts:614–640) — different API set from desktop |

## 4. Dead/orphaned components inventory

| Component | File | Status |
|---|---|---|
| `features/nani-reports/` | web | unrouted, unimported (dead UI for reports that don't exist) |
| `features/nani-memory` hook | web | unreferenced (NANI action-history hook, never wired) |
| `features/copilot/CopilotPage.tsx` header comment | web | claims cloud `/api/v1/ai/*` connectivity the code does not perform |
| `packages/shared/src/nani` | shared | web-mode brain only; not used by desktop path |
| `naniDiagnosticAdapter`/`naniProbeAdapter` | api | web-mode only |
| Sequential IG/stopping | Rust | implemented, tested, not called by the loop (prior finding stands) |
| `metrics.ts` reliability diagrams | shared | web display only |
| 13 `nani_math_*` commands | Rust | all reachable from UI; several feed displays, none feed the investigation loop |

## 5. Conclusion of Mission A

NANI's *reachable* product surface today is: one monitored API (the cloud worker), health checks, monitor events, a deterministic explainer, and mathematical display commands. The *investigation* feature — the part the product is named for — executes but is structurally disconnected from probes, events, the mathematical engine, persistence, and the UI.
