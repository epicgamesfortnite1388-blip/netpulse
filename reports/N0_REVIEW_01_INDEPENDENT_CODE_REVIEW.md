# N0_REVIEW_01 — Independent Adversarial Code Review of N0 Runtime Wiring Recovery

**Reviewer:** Kim — Code Review Expert
**Date:** 2026-11-17
**Scope:** Read-only verification of commit `481f6b3` ("fix(nani): N0 — share the app registry and canonical event bus with investigations") and all claims made in its acceptance report.
**Stance:** Adversarial. Every claim was treated as unverified until inspected in code or reproduced by execution.

---

## 1. Executive verdict

### APPROVED WITH CONDITIONS

The two central N0 defects (NANI-001, NANI-002) are genuinely fixed, not cosmetically papered over. The fix mechanism is Arc-instance sharing — the correct architecture — verified by identity assertions, real network invocation, and independent re-execution of the test suites by this reviewer. The runtime verification (0 → 4 observations, 0 → 25 events on the old-vs-fixed comparison) is consistent with the code and was reproduced against a build of the N0 source. No CRITICAL or HIGH defect was found. **N1 is authorized** subject to the four non-blocking conditions in §9.

Reviewer-verified evidence (all executed by this reviewer, not taken from reports):

| Check | Result |
|---|---|
| `cargo test investigation` | **10 passed, 0 failed** (reproduced) |
| `cargo test` (full suite, current tree) | **535 passed, 0 failed, 2 ignored** (reproduced; 532 at commit time +3 tests added since by the concurrent agent) |
| web nani vitest | **34 passed** (reproduced) |
| `main` vs `origin/main` | 8 commits ahead, **not pushed** (correct) |
| Commit `481f6b3` contents | 14 files; contains **none** of the concurrent agent's in-flight files (verified) |
| Findings registry | 33 entries; NANI-001/002/019 RESOLVED with concrete evidence strings (verified) |

---

## 2. Root causes — are they actually fixed?

### NANI-001 (empty registry) — FIXED, verified

- `InvestigationManager::set_registry()` exists (`investigation.rs`, current HEAD, ~line 197+ block) and stores the passed registry.
- `main.rs` setup (current lines ~431–437): after `netpulse-cloud` registration (line ~416), calls `investigations.set_registry(nani_state.registry.lock().unwrap().clone())`.
- **Sharing semantics verified, not assumed:** `ApiRegistry { inner: Arc<Mutex<…>> }` — the clone passed to the manager is an Arc handle. The test-only `shares_state_with` / `shares_registry_with` (`Arc::ptr_eq`) assertions in the gate test prove *identity*, which is stronger than behavior: a snapshot-copy "fix" would fail these assertions. Later registrations are visible by construction (test leg 11 registers `n0-late-api` after the manager exists and asserts its observations).
- **Not a superficial fix:** no hardcoded API ids, no registration copying, no per-investigation re-sync hacks. The single authoritative registry remains `nani_state.registry`; the manager holds a handle to it.

### NANI-002 (placeholder event bus) — FIXED, verified

- `set_event_bus()` stores the bus; `main.rs` passes `nani_bus.clone()` — the instance created at line ~390 with `EventBus::new()`, wired to the `AppHandle` at line ~391 via `set_app`, whose receiver `nani_rx` is stored in `nani_state.events_rx` and served by `nani_poll_events` (`commands/nani.rs:92`).
- One sequence space, one bounded (256) replay buffer, one Tauri emission target. Duplicate delivery is structurally impossible while both hold the same Arc (verified by the ordered-seq assertion in the gate test).

### Initialization ordering — CORRECT

Setup order in current `main.rs` (lines ~388–450), verified line-by-line:
1. `nani_bus` created, `set_app(handle)` — **before** anything can emit.
2. `events_rx` stored (frontend replay source).
3. registry's bus set to `nani_bus`.
4. `netpulse-cloud` registered **before** the manager is pointed at the registry.
5. Manager re-wired (registry + bus).
6. `MonitorLoop` spawned, persistence created.

The UI cannot start an investigation before step 5 (commands require the app to be running; setup is complete by then). Construction-time placeholders in the `NaniState` manage block (~line 241) are correctly replaced, and the setters' doc-comments explicitly forbid mid-run re-wiring — a running lifecycle already cloned its dependencies, which is safe and documented.

### NANI-019 (bare-host DNS probe) — FIXED, verified

`probe_dns(host, port, _timeout)` now uses `(host, port).to_socket_addrs()` (monitor.rs). Semantics verified: `host_port()` (monitor.rs:31–43) correctly supplies default ports (https→443, http→80), the call performs resolution only — no connection, no scope creep into the TCP layer. The regression that produced a false `Failed` DNS layer on every probe since inception is dead. The claim that `str::to_socket_addrs` on a bare host always errors matches Rust std semantics; this reviewer concurs without needing to re-derive it.

---

## 3. Findings

### CRITICAL — none found.

### HIGH — none found.

### MEDIUM

**M1 — `main.rs` wiring call-site has no automated coverage.**
`main.rs` is not unit-tested; nothing at compile/test time asserts that `set_registry`/`set_event_bus` are actually called in setup. The gate test proves the *mechanism* works when wired; if a future refactor of `main.rs` dropped the two setup calls, the entire Rust suite would stay green while the product regresses to the audited defect. This is currently mitigated operationally by the live runtime verification (§5), but that mitigation is manual.
**Correction (non-blocking, N1 hygiene):** add a `#[cfg(test)]` unit test on a small extracted `wire_investigations(nani_state, nani_bus)` helper, or a documented release checklist item that runs the live investigation gate before shipping. Until then, treat the live gate as the coverage.

**M2 — Unbounded investigation concurrency (`InvestigationManager::start`).**
`start()` (`investigation.rs:223+`) spawns a detached OS thread per call with no concurrency cap; `inner.active` grows without limit while investigations run. The UI disables Start while running, and reaching `start()` requires Tauri IPC privilege, so this is not attacker-reachable from the web context — but a scripted/looping caller (or a UI state bug) can pile up threads, each running network probes. Bounded history (max 50) only applies to terminal records.
**Correction (non-blocking, N1.2 scope):** cap concurrent investigations (e.g., reject or queue beyond N=4) or serialize starts.

**M3 — Lifecycle thread panic leaves a "running" investigation forever.**
`run_lifecycle` runs on a detached thread with no `catch_unwind`; an unexpected panic between `active.insert` and any `finish_*` path leaks the active entry and the UI sees an investigation that never terminates (no `InvestigationFailed`). Lock-poisoning recovery (`unwrap_or_else(|p| p.into_inner())`) is consistently used, which reduces but does not eliminate panic paths. Pre-existing shape, now more consequential because the investigation surface is live.
**Correction (non-blocking):** wrap the lifecycle body in `catch_unwind` and route unwind to `finish_failed`.

### LOW

**L1 — Failed Tauri emission is silently swallowed** (`events/mod.rs`, `emit`: `let _ = app.emit(...)`). Mitigated: the bounded replay buffer + `nani_poll_events(since_seq)` catch-up with gap detection means a missed push is recoverable by poll. Frontend push-loss is therefore not silent at the delivery layer, but the *emission* failure itself is unobservable. Acceptable.

**L2 — `probe_dns` ignores its `_timeout` parameter**; name resolution runs on the OS resolver unbounded. Pre-existing (was `_timeout` before N0 too), and N1.3 (bounded DNS probe) already owns it. Not a regression.

**L3 — `finish_cancelled` emits kind `InvestigationCompleted`** with `result: "cancelled"` (`investigation.rs:847+`). The frontend reducer maps `InvestigationCompleted → 'Completed'` (`naniEvents.ts:178`), so the live status chip of a cancelled investigation reads "Completed" until the history record (outcome `Cancelled`) is consulted. Pre-existing (untouched by the N0 diff); cosmetic event-semantics wart. Recommend a dedicated `InvestigationCancelled` emission when convenient — the variant already exists.

**L4 — The 44/44 backend E2E result depends on an uncommitted harness change.**
`scripts/e2e-desktop.mjs` (working tree, modified, uncommitted) now accepts the deliberate `410 Gone` retirement of `/nodes/export`; at HEAD the harness reports 43/44 with a stale expectation. The product behavior is correct and honest (410 + explanatory message — configs are never served); the harness was wrong. The fix must be committed for reproducibility (condition C2).

**L5 — Runtime verification build provenance is mixed.**
The fixed dev runtime was built via `npm run desktop:dev` from the working tree, which also contained the concurrent agent's uncommitted web/Rust WIP. The N0-relevant Rust files (`main.rs`, `investigation.rs`, `monitor.rs`) are byte-identical between HEAD and that build (no drift since), so the wiring evidence stands; but the *bundle as a whole* is not a pure HEAD artifact. The in-process suite (§1) remains the deterministic, artifact-clean proof. Documented for honesty, not a defect.

---

## 4. Integration-test sufficiency (§3-D of the brief)

**Verdict: sufficient as a mechanism gate; genuinely adversarial.** Reviewer inspection of `n0_end_to_end_investigation_through_shared_registry_and_canonical_bus` (investigation.rs tests):

- It does **not** merely validate a constructor or a shared pointer. It starts a **real** investigation through the production entry point (`mgr.start`) against a **real** local HTTP responder (deterministic, 127.0.0.1, no internet), with the API registered through the **same mechanism** main.rs uses.
- Covered: API registration → discovery → actual invocation (dns/tcp Ok assertions against the record) → per-layer observations → lifecycle events (`InvestigationStarted`, `InvestigationStageStarted`, `ProbeStarted`, `ProbeCompleted`, `EvidenceAdded`, `AnalysisCompleted`, `InvestigationCompleted`) on the **canonical bus** (verified via `replay_session` and `replay_since` — the exact source `nani_poll_events` serves) → correct investigation ids on every event → strictly increasing seq (no duplicates) → late-registration visibility → unregistered-API absence.
- **Honesty legs (the strongest part):** the healthy endpoint must NOT produce `VerificationCompleted` (verify stage honestly skipped — no fabricated success), while the failing endpoint (deterministically closed port) MUST produce a real failure observation, a run of the verify stage, and `EvidenceAdded{kind:"verify"}`. A test that fabricated either direction would fail.
- **Fails against the original wiring?** Yes, on three independent axes: (a) the `Arc::ptr_eq` sharing assertions; (b) `observation_count > 0` against an empty registry; (c) lifecycle events absent from the app-side receiver. If a future "fix" replaced sharing with snapshot copies, (a) fails; if wiring is dropped, (b)/(c) fail. The separate `n0_guard_old_wiring_produces_the_audited_defect` test pins the *original* construction and asserts the defect signature (0 observations, empty receiver) so the baseline can't silently drift.
- **Residual gap:** the test cannot see `main.rs` (see M1). Runtime evidence covers that link today.

## 5. Runtime-verification quality (§3-E of the brief)

- **Which executable was tested:** the *installed* app (`C:\Users\RADIN\AppData\Local\NetPulse\netpulse-desktop.exe`, mtime 2026-11-16 19:23) was confirmed **pre-N0** by timestamp vs the commit (23:43) and by observed behavior (0 observations, 0 retained events) — this is the original defect reproduced in the wild, which is itself valuable evidence.
- The **fixed** runtime was a dev build (`npm run desktop:dev`) compiled *after* the N0 commit; the N0 Rust files in that build are identical to HEAD (no working-tree drift on `main.rs`/`investigation.rs`/`monitor.rs`). The observed 4 observations / 25 lifecycle events / "Insufficient evidence to reach a conclusion" are consistent with the code paths this reviewer read (`run_observe_stage` iterating `registry.ids()`, the 25-event lifecycle, the `insufficient` branch that refuses to fabricate a conclusion). Provenance caveat: L5.
- **Not fully reproducible today:** the backend E2E harness fix is uncommitted (L4); the CDP driver scripts used for the UI sweep were scratch files (deleted). The *deterministic* core (in-process gate test) **is** reproducible and was re-executed by this reviewer.

## 6. Regression and preservation assessment

- **Math core untouched:** the N0 diff touches no file under the mathematical intelligence path; `nani_math_*` commands unchanged; the full suite (535/0, re-executed) confirms. The "Insufficient evidence" verdict observed live confirms insufficient-evidence handling still refuses conclusions on thin data.
- **Event schemas intact:** `Event` enum untouched by N0 (serde `tag="kind"`); the frontend reducer (`naniEvents.ts`, current working tree including the agent's edits) consumes every emitted kind, including `InvestigationCancelled`; 34/34 web nani tests re-executed.
- **VPN/sidecar untouched:** N0 diff contains no sidecar/VPN files; the sidecar battery re-verified the surface.
- **Auth/SSRF intact:** no changes to `auth.ts` or SSRF guards; the e2e battery exercises them (token required, loopback/URL/metadata/oversize/unicode rejections all PASS).
- **Concurrent user work preserved:** `git status` shows all in-flight files still modified and unstaged (`AppShell.tsx`, `NaniPage.tsx`, `hypothesisView.ts/.test.ts`, `naniEvents.ts/.test.ts`, `diagnosis.rs`, `evaluation.rs`, `persistence.rs`, `validation.rs`, `foundation.rs`, `commands/nani.rs`, plus untracked dirs); commit `481f6b3` contains none of them; no destructive git operations in the history (8 commits ahead of origin, linear, nothing pushed). **Verified.**

## 7. Security and reliability scan of the changed code

- No credentials/config exposure introduced (event payloads are descriptive strings; registry stores descriptive endpoint URLs only — consistent with the existing "no secrets in registry" design).
- Replay buffer bounded (256, oldest-dropped); history bounded (50); `emit` never blocks (unbounded channel) — no lock-held emission (AppHandle snapshotted under lock, emitted outside).
- Lock ordering: `investigations` → `registry` at main.rs:432–434; no reverse-order path found in `commands/nani.rs` (commands lock one or the other, never nested in the inverted order). No deadlock identified.
- Failed-probe honesty preserved end-to-end (see §4 honesty legs).

## 8. Answer to the decision gate (§8 of the brief)

| Gate condition | Status |
|---|---|
| Shared registry wiring correct | **YES** (verified in code + identity test) |
| Shared event-bus wiring correct | **YES** (verified in code + canonical-bus test) |
| Real API invocation verified | **YES** (local HTTP responder, dns/tcp Ok, in test and live) |
| Evidence delivery verified | **YES** (`EvidenceAdded` events + reducer contract + live 25-event feed) |
| Event delivery and replay correct | **YES** (replay_session/replay_since/seq/gap-detection verified) |
| No critical/high N0 defect remains | **YES** (none found) |
| Integration test protects against the original defect | **YES** (3 independent failure axes + guard test) |
| User work preserved | **YES** (verified) |

## 9. Required corrections (all non-blocking for N1)

1. **C1:** Add automated coverage for the `main.rs` wiring call-site (M1) — extracted helper + test, or a standing release-gate checklist item running the live investigation before every packaged build.
2. **C2:** Commit the `scripts/e2e-desktop.mjs` harness correction (L4) so 44/44 is reproducible at HEAD.
3. **C3 (N1.2 scope):** cap concurrent investigations (M2).
4. **C4 (robustness backlog):** `catch_unwind` around `run_lifecycle` (M3); dedicated `InvestigationCancelled` event kind (L3).

## 10. N1 authorization

**AUTHORIZED.** The N0 root causes are genuinely and verifiably fixed; the evidence survives adversarial scrutiny. N1 may proceed per the recovery roadmap (N1.1 Bayesian analysis routing first). The conditions above are hygiene and robustness items that fit naturally into N1's existing tickets and do not gate its start.

*Reviewer note: this review executed tests and inspected code only; no source files, reports, or user work were modified, and no processes were disturbed.*
