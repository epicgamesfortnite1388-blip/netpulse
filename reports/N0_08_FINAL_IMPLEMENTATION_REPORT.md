# N0_08 — Final Implementation Report

## A. Executive result

**PASS** — both N0 wiring defects fixed, a genuine end-to-end regression test added that fails against the original wiring, zero regressions across the 532-test Rust suite, and one additional production probe defect (NANI-019, DNS layer) discovered and minimally fixed by the acceptance gate itself.

## B. Root causes addressed

| Root cause | Original | Exact change | Why it fixes |
|---|---|---|---|
| NANI-001 (empty registry) | `InvestigationManager::new` received its own `ApiRegistry::new()` (main.rs manage block); only `state.registry` got `netpulse-cloud` | `set_registry()` + setup call passing `state.registry…clone()` (Arc-shared) | one authoritative registry instance; manager observes every registered API incl. later registrations |
| NANI-002 (placeholder bus) | manager held `EventBus::default()` (no AppHandle, private replay) | `set_event_bus()` + setup call passing `nani_bus` (Arc-shared) | one canonical bus: Tauri emission + replay buffer + frontend subscribers all see investigation events |
| NANI-019 (DNS probe always Failed — discovered during N0) | `probe_dns(host)` called `str::to_socket_addrs()` on a bare host → **always** `Err("invalid socket address")` (proven with a standalone rustc snippet) → every probe recorded a false DNS failure, `dns_ok:false` into the classifier, and post-N0 a false 100%-confidence "dns" hypothesis on healthy networks | `probe_dns(host, port, timeout)` using `(host, port).to_socket_addrs()` — resolution without connect; same form the TCP probe uses | the DNS layer now measures what it claims to measure; healthy networks produce no invented fault |

## C. Architecture after repair

```
main.rs setup
  ├─ registry.register(netpulse-cloud) ──► state.registry (Arc) ◄── health_check_all, MonitorLoop
  │                                              │ Arc-shared handle
  │                                              ▼
  └─ investigations.set_registry(…) ──► InvestigationManager ──► probe_api(entry)  REAL I/O
                                                        │
nani_bus (Arc, AppHandle, replay) ◄── set_event_bus ────┘
  ├─ Tauri emit("nani:event") ──► useNaniEvents ──► reducer ──► live pipeline / evidence / feed
  └─ replay_since(seq) ──► nani_poll_events ──► web-mode polling fallback
```

## D. End-to-end evidence

`N0_05` — the integration test exercised the production wiring against a real local HTTP endpoint: full lifecycle event set on the canonical bus, Arc-identity sharing proof, late-registration visibility, unregistered-API absence, healthy-leg (no fabricated verification) + failing-leg (verify runs, `verify` evidence) honesty, ordered replay. Guard test pins the original defect.

## E. Regression results

See `N0_07`: 532/532 Rust (was 530 +2 new), web nani 34, shared/api tsc clean. Web `tsc` fails in an **untracked concurrent-agent file** (`features/connection/connectionState.ts`) — documented, not mine, not staged.

## F. Remaining work (unchanged priorities)

- N1.1: route investigation analysis through the Bayesian engine (NANI-003 — **still OPEN**; the events now carry frequency-based hypotheses until then).
- N1.2 configurable registry; N1.3 bounded DNS timeout; N1.4 adaptive stopping; N1.5 CVaR port + oracle fixture.
- N2 persistence + reports (NANI-004/005 — the PersistenceStore is still never written).
- N3/N4 Copilot; N5 advanced intelligence.

## G. Git state

- Branch `main`, HEAD at mission start `005de03`.
- My changed files (all Rust, reviewed hunk-by-hunk): `src-tauri/src/main.rs` (+15), `network_intelligence/investigation.rs` (+305 incl. tests), `api_intelligence/registry.rs` (+7 test accessor), `api_intelligence/monitor.rs` (+14/−3 probe_dns fix), `events/mod.rs` (+6 test accessor).
- **Not staged**: the concurrent agent's in-flight work (`diagnosis.rs`, `evaluation.rs`, `persistence.rs`, `validation.rs`, web files, new `features/connection/*`, untracked reports) — preserved untouched.
- Commit: `fix(nani): N0 — share the app registry and canonical event bus with investigations` — staged files only, no push.
- Registry: NANI-001, NANI-002, NANI-019 → RESOLVED with test evidence; NANI-003–005 etc. remain OPEN.

## H. Honest limitations

1. **Desktop runtime not launched.** The integration test replicates the production wiring in-process (same bus internals as `nani_poll_events`, same registry instance), but the Tauri AppHandle emission and WebView2 listener were verified by code trace + reducer tests only. A packaged-app launch with the live pipeline on screen remains the final human verification step.
2. The web `tsc` failure is concurrent user work (untracked file created during the mission) — flagged, not fixed, not blocking N0.
3. `InvestigationFailed` path has no new live fixture (unit-covered pre-existing); the failing-endpoint leg covers `Completed`-with-failure instead.
4. The manager's unused duplicate `history` field (investigation.rs:174) was observed and left untouched (out of scope).
