# FINAL_UI_FINDINGS_REGISTRY — NetPulse/NANI

**Reviewer / registry owner:** Kim — Independent Code Review Expert
**Baseline:** `main` @ `2a9f825`, captured 2026-11-20 07:42 GMT+3:30
**Concurrent implementer:** Will (user-confirmed 2026-11-20; see `FINAL_UI_BASELINE.md` §4)
**Status values:** `OPEN` · `fixing (Will)` · `fixed (unverified)` · `verified` · `deferred` · `blocked`

Severity per mission: **P0** data loss/security/fundamentally wrong diagnosis · **P1** core functionality broken, misleading diagnosis, severe integration defect · **P2** significant usability/reliability/performance/maintainability · **P3** minor visual/interaction/code quality · **P4** informational.

Findings are deduplicated by root cause. Prefix cross-references (`FE-`, `NI-`, `BK-`) are the three independent review streams' original IDs.

---

## Summary

| ID | Sev | Component | Short title | Owner | Status |
|---|---|---|---|---|---|
| F-01 | P1 | Rust engine | Authoritative likelihood table changed under redesign freeze | blocked | OPEN — authorization required |
| F-02 | P1 | Rust engine / NANI UI | Self-derived "calibration" label presented as measured confidence | blocked | OPEN — authorization required |
| F-03 | P1 | NANI UI | Web health check reports attempt count as "N/N healthy" | Will | OPEN (uncontested file) |
| F-04 | P1 | connection module | Build-blocking TS2322 in `useDisconnect` | Will | **verified fixed** (08:23 typecheck + 08:26 build) |
| F-05 | P1 | Dashboard | Connection console components unreachable (dead code) | Will | OPEN — re-checked 08:23 |
| F-06 | P1 | Rust probes / NANI UI | NANI-021 proxy contamination now surfaced as a health verdict | blocked | OPEN — carried |
| F-07 | P2 | NANI events hook | Poll interval can leak after unmount; event gap ignored | Will | OPEN — re-checked 08:23 |
| F-08 | P2 | NANI event feed | Missing `verified` rendered as "passed" | Will | OPEN |
| F-09 | P2 | NANI event feed | `HealthCheckCompleted` treated as resume for every verdict | Will | OPEN |
| F-10 | P2 | UI type scale | Sub-12px text introduced by redesign | Will | **verified fixed**; guard strengthened 08:21 (13/13 pass) |
| F-11 | P2 | Rust evaluation/validation | Regression bars relaxed; calibration algorithm changed | blocked | OPEN — authorization required |
| F-12 | P2 | Backend DTO | `ProbeSelection` fields removed without compatibility | blocked | OPEN |
| F-13 | P2 | Events / persistence | Health-event flood can evict lifecycle events; write errors suppressed | blocked | OPEN |
| F-14 | P2 | Tauri command | K-1 ms-feeder fix only in working tree | blocked | OPEN — carried |
| F-15 | P2 | Test reliability | N1.1 oracle + perf smoke flaky/failing at baseline | blocked | OPEN — load sensitivity **proven**; posterior mismatch undemonstrated |
| F-16 | P3 | Shell / a11y | Theme toggle non-reactive, discards "system" preference | Will | OPEN |
| F-17 | P3 | Shell / a11y | Mobile drawer lacks Escape-to-close and focus management | Will | OPEN |
| F-18 | P3 | Connection dial | Dial centre tone colour overridden by CSS specificity | Will | OPEN |
| F-19 | P3 | Design system | Semantic tokens declared outside `tokens.css` | Will | OPEN |
| F-20 | P3 | NANI events | Event timestamps always 0; no-op `gapCount`; duplicated ms→s conversion | blocked | OPEN |
| F-21 | P3 | Rust probes | NANI-011 unbounded DNS; registry mutex held across probe | blocked | OPEN — carried |
| F-22 | P3 | Tauri command | Serialization errors masked as `Value::Null`; TLS verdict coarse | blocked | OPEN |
| F-23 | P3 | NANI UI | Calibrated/raw confidence shown unreconciled | Will | OPEN |
| F-24 | P3 | Tests | Calibration test does not cover the render contract | Will | OPEN |
| F-25 | P3 | Motion a11y | Reduced-motion rule misses spinners | Will | PARTIAL — `animate-ping` still at `AgentPathTrace.tsx:78` with `motion-reduce:animate-none`; global claim false |
| F-26 | P4 | Shell | Hard-coded version string in rail | Will | OPEN |
| F-27 | P1 | Settings | Settings tabs inert — 6 of 7 sections unreachable by click | Will | OPEN — independently verified 08:28 |
| F-28 | P1 | Startup health | `runtime_status` never resolves in packaged Tauri v2 | Will | OPEN — independently verified 08:28 |
| F-29 | P2 | WS client | Socket subscription leaks on fast unmount | Will | OPEN |
| F-30 | P2 | Copilot | "Stop" does not abort in-flight explanation | Will | OPEN |
| F-31 | P2 | Copilot | Availability badge inverted / misleading | Will | OPEN |
| F-32 | P2 | Update history | Transport failure rendered as empty history | Will | OPEN |
| F-33 | P3 | Adaptive recovery | Destructive actions without confirmation | Will | OPEN |
| F-34 | P3 | Settings | Draft never re-syncs after save | Will | OPEN |
| F-35 | P2 | Report integrity | Nine new UI_MASTER reports contain false/overstated claims | Will | OPEN — documented below |
| F-36 | P3 | Copilot UX | Two different empty-state prompts on one screen (V-01) | Will | OPEN — visually confirmed 08:30 |

Counts after the 08:22–08:35 continuation: **P0 0 · P1 8 · P2 14 · P3 12 · P4 1 = 36 findings.**
Derived from prior baseline: carried `NANI-011`, `NANI-020`, `NANI-021`, `NANI-022`, K-1; no new P0.
Verified fixed: F-04, F-10. Partially fixed: F-25.

---

## P1 findings

### F-01 — Authoritative likelihood table changed under the redesign freeze
- **Component / location:** `src-tauri/src/network_intelligence/diagnosis.rs`, `LikelihoodTable::signature` — working-tree lines 265–406 (`git diff` hunks at 292, 309, 319, 340, 355, 370, 382, 403).
- **Description:** The `Unknown` hypothesis failure likelihood is lowered from `0.20/0.25/0.30` to `0.02` across DnsResolve, TcpConnect, TlsHandshake and HttpGet, with new explicit `Unknown => 0.02` arms for InterfaceCheck, MtuProbe and Traceroute. Because each success likelihood is `rest * 0.98`, all-success evidence now concentrates posterior on `unknown` instead of promoting a fault.
- **Evidence:** `git diff -- src-tauri/src/network_intelligence/diagnosis.rs` shows the table edits and the added test `a_healthy_probe_round_does_not_raise_failure_hypotheses`. Comment in `evaluation.rs` explicitly says "the engine's success likelihood changed". `reports/UI_REVIEW_07` §3 line 39: "Must NOT change … NANI mathematical algorithms and Rust investigation logic".
- **Root cause:** The NANI-020 healthy-posterior fix was implemented in the working tree as part of/adjacent to the UI redesign, without a contract amendment or independent math review.
- **User impact:** Every posterior and ranking the redesigned UI displays comes from a model that has not passed the prior N1.1/N1.2 engine gates. The history of "Bayesian authority verified" no longer describes what builds.
- **Proposed fix:** **Do not revert** — that would destroy Will's work. Either (a) obtain explicit authorization and review the change as N1.3 math work with oracle/parity tests, or (b) land it in its own commit with an amended contract and a fresh independent review before the UI redesign is signed off.
- **Regression test:** Pin HEAD likelihood-signature snapshots + posterior values for the N1.1 evidence fixture; assert all-success evidence ranks `unknown` first and no fault hypothesis above it.
- **Owner / status:** blocked / **OPEN — authorization required**. Kim cannot approve or reject the math within this mission.

### F-02 — Self-derived "calibration" label presented as measured confidence
- **Component / location:** `diagnosis.rs::observe_recording_confirmation` (working-tree line 695); `commands/nani.rs` line 329; `persistence.rs::record_calibration_sample` line 256; `apps/web/src/features/nani/hypothesisView.ts` line 74; `NaniPage.tsx` calibration note ~line 1001.
- **Description:** A calibration sample is labelled `1` when the leading hypothesis' log-likelihood under the *same likelihood table* is at least the posterior-weighted mean under that same table, `0` otherwise. No external outcome is used. After 30 samples the UI shows a "Calibrated confidence" different from the raw posterior with a note claiming calibration "on N recorded probe outcomes".
- **Evidence:** Source of `observe_recording_confirmation` reads `self.likelihood.log_likelihood(...)` on both sides of the comparison; samples are recorded only from manual health checks (mostly successes, hence mostly label 1). `hypothesisView.ts:60–82` selects the calibrated number for display.
- **Root cause:** Self-agreement of an engine with its own prior was treated as ground truth for calibration.
- **User impact:** A number presented as empirically calibrated confidence may be a monotone transform of the uncalibrated posterior, with no measured truth behind it. This is a misleading diagnostic state (mission §4.D).
- **Proposed fix:** Require a genuinely observed external outcome, or relabel as "self-consistency index" and remove calibrated-probability language. Do not silently change the engine in this mission — authorize first.
- **Regression test:** A case with an external outcome contradicting the leader must not raise the displayed confidence; a 0-sample state must not claim calibration.
- **Owner / status:** blocked / **OPEN — authorization required**.

### F-03 — Web health check reports attempt count as "N/N healthy"
- **Component / location:** `apps/web/src/features/nani/NaniPage.tsx`, `parseHealthCheckResult` lines 1104–1121; rendered ~1155 and 1183–1187.
- **Description:** When the raw result has no `N/N healthy` string, the function returns `healthy: webChecked, total: webChecked`. In web mode one check is attempted per registered API and no aggregate verdict exists, so every attempted check is counted as healthy even when the underlying `/nani/check` call errored.
- **Evidence:** `return { at: Date.now(), healthy: webChecked, total: webChecked, raw };` — verified verbatim at 07:51. The function's own doc comment says "the count of checks is used rather than claiming a health value nobody measured", which contradicts what the UI then renders.
- **Root cause:** Count of attempts substituted for a measurement outcome.
- **User impact:** Missing measurements become successful ones — explicitly prohibited by mission §4.D and §4.E. A user can be told "1/1 healthy" after a failed check.
- **Proposed fix:** Return `healthy: null` for the web path; render "checks attempted — verdict unavailable" in the health/empty state.
- **Regression test:** Web path with all `/nani/check` calls failing must never render a `healthy` count or the word "healthy" as a verdict.
- **Owner / status:** Will / **OPEN** (file not contested since 07:48; no fix observed as of 07:59).

### F-04 — Build-blocking TS2322 in `useDisconnect`
- **Component / location:** `apps/web/src/features/connection/connectionState.ts:369`.
- **Description:** `useMutation` is inferred from the first branch to return `Promise<{tunnel: ProxyTunnelStatus}>`, but the second branch returns `Promise<{status: VpnStatus}>`.
- **Evidence:** `npm run typecheck -w @netpulse/web` run twice (07:44 and 07:59) — identical failure both times:
  `src/features/connection/connectionState.ts(369,5): error TS2322: Type '(source: ConnectionSource) => Promise<{ tunnel: ProxyTunnelStatus; }> | Promise<{ status: VpnStatus; }>' is not assignable to type 'MutationFunction<{ tunnel: ProxyTunnelStatus }, ConnectionSource>'`.
- **Root cause:** Missing explicit generic parameter / unified result type on the mutation.
- **User impact:** Frontend typecheck and `vite build` (`tsc --noEmit && vite build`) fail; the application cannot be built from the current tree. Acceptance criterion "application builds successfully" is not met.
- **Proposed fix:** Give `useMutation` an explicit result type that models both carriers, e.g. `useMutation<{ tunnel?: ProxyTunnelStatus; status?: VpnStatus }, Error, ConnectionSource>`, or return a single discriminated result from both branches.
- **Regression test:** `npm run typecheck -w @netpulse/web` must exit 0; add a unit test asserting both disconnect carriers invalidate `['tunnel']` and `['vpn']`.
- **Owner / status:** Will / **OPEN — build blocker, re-verified 07:59**.

### F-05 — Connection console components unreachable
- **Component / location:** `apps/web/src/features/connection/{ConnectionHero.tsx:34,ConnectionDial.tsx:52}`; `apps/web/src/features/dashboard/DashboardPage.tsx` still renders `ConnectionCard` at ~line 279.
- **Description:** The new three-ring connection instrument and its honest verification/exit-IP panel are defined but never imported by any route. Only `GlobalConnectionChip` consumes the `useConnection()` truth module.
- **Evidence:** `grep -rn "ConnectionHero\|ConnectionDial" apps/web/src` returns only their own definitions and the internal import in `ConnectionHero.tsx`. Verified again at 07:51 after Will's DashboardPage edit.
- **Root cause:** Components were added to the tree without wiring them into a page.
- **User impact:** The centerpiece of the redesign is dead code; the honest `unverified` state and `verification`/`verifiedPublicIp` detail panel cannot be seen by users. Contract §5.6 (visual verification of the running app) cannot be satisfied for this surface.
- **Proposed fix:** Mount `<ConnectionHero state={useConnection()} />` on the dashboard (additive above/next to `ConnectionCard`, preserving the legacy card until design sign-off), then visually verify at 1280×720 and narrow width.
- **Regression test:** Render test asserting `role="img"` dial label and "traffic unverified" when `/vpn/status` returns `verification: 'not_verified'`.
- **Owner / status:** Will / **OPEN**.

### F-06 — NANI-021 proxy contamination surfaced as a health verdict (carried)
- **Component / location:** `src-tauri/src/network_intelligence/api_intelligence/monitor.rs::probe_http` line 94 (`reqwest::blocking::Client::builder()...build()` — no `.no_proxy()`), record at line 219 (`route: RouteKind::Direct`); `registry.rs::health_check_event` lines 92–105 (`health: "Healthy"`); `naniEvents.ts:204–205`.
- **Description:** reqwest inherits the Windows system proxy. The HTTP layer can therefore report success from a proxy while the target is unreachable, yet the probe record asserts `Direct` and the new event emits a `Healthy` verdict with no direct-path qualifier.
- **Evidence:** Prior independent reviews `N1_REVIEW_01` §7 and `N1_2_REVIEW_FINAL` item 4 establish the root cause; current source confirms no `.no_proxy()` and no consistency gate anywhere in the working tree.
- **Root cause:** NANI-021 (HIGH, OPEN) remains unfixed; the redesign adds a UI surface that presents its output more prominently.
- **User impact:** A proxy-derived "Healthy" can be read as proof the intended target was reached — prohibited by mission §4.E ("Do not claim direct-path measurements unless the measurement actually bypasses the system proxy").
- **Proposed fix:** Authorized N1.3 work: `.no_proxy()` on the probe client, a TCP/HTTP route consistency gate, and an honest `route`/qualifier in the event. Until then, keep the limitation visible in UI/docs.
- **Regression test:** With `HTTPS_PROXY` pointing at a responder that returns 200 while the target refuses connections, assert health is not `Healthy` and route is not `Direct`.
- **Owner / status:** blocked / **OPEN — carried HIGH**. Must remain visible.

---

## P2 findings

### F-07 — Poll interval leak after unmount; event gap ignored
- **Location:** `apps/web/src/features/nani/useNaniEvents.ts:82–104`; `naniApi.ts:176` (`slice.gap`).
- **Evidence:** `attach()` does `await poll()` then unconditionally `setInterval(...)` and pushes the timer; cleanup clears only timers already in `timersRef`. If unmount happens while `poll()` is in flight, `cancelled = true` is set but the timer is registered afterwards. `slice.gap` is never read.
- **Root cause:** No cancellation check after the await; dropped gap signal.
- **Impact:** Leaked 5s poll loop and stale state updates after unmount; backend restart/eviction is not honestly reported.
- **Fix / test:** Add `if (cancelled) return;` immediately after `await poll()`; surface `gap` into state. Test: unmount during in-flight poll → zero active intervals, no state update.
- **Owner / status:** Will / **OPEN**.

### F-08 — Missing `verified` mapped to "passed"
- **Location:** `apps/web/src/features/nani/naniEvents.ts:250–251`.
- **Evidence:** `` `Verification ${payload.verified === false ? 'failed' : 'passed'}` `` — absent field defaults to success.
- **Root cause:** Default-to-success instead of default-to-unknown.
- **Impact:** An unavailable verification is presented as a pass in the event feed (the authoritative `result` string remains correct).
- **Fix / test:** `verified === true ? 'passed' : verified === false ? 'failed' : 'unavailable'`. Test with missing field.
- **Owner / status:** Will / **OPEN**.

### F-09 — `HealthCheckCompleted` treated as resume for every verdict
- **Location:** `naniEvents.ts:115–123`; test at `naniEvents.test.ts:282–291` covers only `health:'Healthy'`.
- **Evidence:** Every completed check returns `null` (meaning "resume"), so an `Unhealthy` check suppresses an older failure reason in the empty-measurement fallback.
- **Impact:** A genuine failure reason can be hidden.
- **Fix / test:** Resume only for healthy/degraded verdicts; add `Unhealthy`/`Unknown` cases.
- **Owner / status:** Will / **OPEN**.

### F-10 — Sub-12px text introduced by the redesign
- **Location:** baseline offenders `AppShell.tsx` (`text-[11px]`, `text-[10px]`), `ConnectionHero.tsx:118,151` (`text-[11px]`), `identity.css:307,379,497,653` (9–10px).
- **Evidence:** Baseline `npm run test -w @netpulse/web`: 2 failures in `test/typeScale.test.ts`, 4 offenders. Post-Will rerun: **54/54 files, 506/506 tests passing**. Verified the test file itself was **not** modified (mtime 2026-10-02) and the offender classes are gone from TSX and CSS — the fix is real, not a weakened guard.
- **Root cause:** New identity layer wrote its own micro scale instead of the documented 12px floor.
- **Impact (at baseline):** legibility/accessibility regression; definition-of-done violation.
- **Fix / regression protection:** Offending classes replaced with scale tokens; the unchanged `typeScale.test.ts` guard protects recurrence.
- **Owner / status:** Will / **verified fixed** by Kim at 07:59.

### F-11 — Evaluation bars relaxed and calibration algorithm changed
- **Location:** `evaluation.rs::evaluate_calibrated` line 283 + tests ~483/572; `validation.rs::pool_adjacent_violators` line 222, `fit` ~255; `TemperatureScaling` removed.
- **Evidence:** Absolute ECE bound `<0.146` replaced by relative `<raw` / `<0.75*raw`; Beta smoothing moved before pooling; knot values for identical samples differ from HEAD.
- **Root cause:** Thresholds and algorithm adjusted to accommodate F-01/F-02.
- **Impact:** Regression protections weakened under the engine freeze; a 2× ECE inflation would still pass relative assertions.
- **Fix / test:** Restore an absolute bound or a documented derived limit; pin knot values for fixed samples.
- **Owner / status:** blocked / **OPEN — authorization required**.

### F-12 — Backend DTO shape broken
- **Location:** `foundation.rs::ProbeSelection` line 125 (`test_id`, `efficiency`, `reasoning` removed); `HypothesisView` line 153 (two fields added).
- **Evidence:** `git diff` shows fields removed; frontend `naniApi.ts` changed in lockstep.
- **Impact:** Any pre-change client reading `selected_probe.reasoning` gets `undefined`; violates contract §3 "backend contract shapes must not change".
- **Fix / test:** Keep legacy fields (mark new ones `serde(default)`), add a JSON snapshot test asserting legacy keys.
- **Owner / status:** blocked / **OPEN**.

### F-13 — Event flood / suppressed persistence errors
- **Location:** `registry.rs::health_check_event` line 92; `events/mod.rs:221` (bounded replay 256, unbounded internal mpsc); `persistence.rs:270` (`let _ = persist_model_state()`).
- **Impact:** One event per API per health check can evict lifecycle events from replay; silent durability loss.
- **Fix / test:** Emit an aggregate event; surface write errors; test 300 health events do not evict `AnalysisCompleted`.
- **Owner / status:** blocked / **OPEN**.

### F-14 — K-1 ms-feeder fixed only in working tree (carried)
- **Location:** `commands/nani.rs:326` (`probe.timestamp /= 1000`) present in working tree; absent at HEAD (`git show HEAD:...` lines 296–302).
- **Impact:** If the committed tree ships, each manual health check over-mixes the posterior ~1000×. Prior Kim verdict C-N1.2-1 remains unclosed.
- **Fix / test:** Land the author's hunk with their go-ahead (never rewrite their WIP); add a seconds-contract pin.
- **Owner / status:** blocked / **OPEN — carried**.

### F-15 — N1.1 engine tests flaky/failing at baseline
- **Location:** `src-tauri/src/network_intelligence/investigation.rs:1356,1745,1888`.
- **Evidence:** Baseline full suite 550 passed / **2 failed** / 2 ignored; `n1_analysis_latency_smoke` at 8.8075s and oracle mismatch `ipv4` vs `quic_udp_failure`. Fresh isolated oracle run failed differently: 6s terminal-state timeout. Two different failure modes for one test.
- **Root cause:** Not demonstrated. Load sensitivity and environment (proxy, port-1 probe path) are plausible; correlation with F-01 is **not proven** and must not be asserted.
- **Impact:** The authoritative "engine drives the analysis" gate is not reliably green; no release claim can rest on it.
- **Fix / test:** Diagnose with repeated controlled runs; do not weaken timeouts. Record exact environment.
- **Owner / status:** blocked / **OPEN — root cause undemonstrated**.

---

## P3 / P4 findings (condensed; all evidence is in the review streams)

| ID | Location | Defect | Fix | Status |
|---|---|---|---|---|
| F-16 | `AppShell.tsx:191–218` `useThemeToggle` | Reads `dataset.theme` during render; OS theme flip goes stale; toggle always writes explicit light/dark, losing "system" | Subscribe to media query; preserve/restore `system` | Will / OPEN |
| F-17 | `AppShell.tsx:139–187` `MobileNav` | No Escape-to-close, no focus trap/return; backdrop not keyboard focusable | Focus close button on open, trap, Escape, restore focus | Will / OPEN |
| F-18 | `ConnectionDial.tsx:98–104` vs `identity.css:644–649` | CSS `fill` beats SVG presentation attribute — dial centre never shows state tone | Drive fill via CSS custom property | Will / OPEN |
| F-19 | `identity.css:36–57,74–103,109–162` | Semantic tokens re-declared outside `tokens.css` (two sources of truth) | Move aliases into `tokens.css` | Will / OPEN |
| F-20 | `naniEvents.ts:285`; `applyNaniEvent:327–331`; `commands/nani.rs:326` | Rust envelope has no `at`, so all event times are 0; no-op `gapCount`; duplicated ms→s conversion | Add `at` to envelope; remove no-op; share one conversion helper | blocked / OPEN |
| F-21 | `monitor.rs::probe_dns` line 54; `nani.rs::nani_health_check_all` | `_timeout` ignored (`to_socket_addrs` unbounded); registry mutex held across probe | Bounded resolver; drop lock before probe | blocked / OPEN — carried NANI-011 |
| F-22 | `commands/nani.rs:151,161`; `monitor.rs:111–115` | Serde failures coerced to `Value::Null`; TLS marked `Ok` for any response on http/https | Propagate errors; derive TLS from scheme | blocked / OPEN |
| F-23 | `NaniPage.tsx:999–1007,1012–1029`; `hypothesisView.ts:60–82` | Header shows calibrated confidence while top row shows raw posterior for same MAP, with no reconciliation | Note must state raw value and N outcomes | Will / OPEN |
| F-24 | `hypothesisView.test.ts:39–76` | Pure helper tested; render label switch/clamping not tested | Add render/integration test + 0-sample case | Will / OPEN |
| F-25 | `identity.css` reduced-motion block | `.animate-spin` not covered | Add static fallback under reduced motion | Will / **verified fixed** |
| F-26 | `AppShell.tsx:93` rail | Hard-coded `3.2` drifts from `package.json` | Import version constant | Will / OPEN |

---

## Continuation findings (08:22–08:35, second review pass)

### F-27 — P1 — Settings tabs are inert
- **Location:** `apps/web/src/features/settings/SettingsPage.tsx:79` (`const [searchParams] = useSearchParams()` — setter discarded) and `:148–158` (`<Tabs value={tab} items={…}>` with no `onValueChange`); `components/ui/Tabs.tsx:20` forwards `onValueChange` to `RTabs.Root`.
- **Evidence:** Kim verified the source directly. With a controlled Radix root and `onValueChange === undefined`, clicking Network/VPN/Platform invokes a no-op; only `?tab=network` deep links change the panel.
- **Impact:** six of seven settings sections are unreachable by normal navigation. Newly discovered, pre-existing in origin.
- **Fix / test:** pass `onValueChange` that writes `?tab=` with `replace: true`. Render test: click "Network" → network fields visible.
- **Owner / status:** Will / **OPEN**.

### F-28 — P1 — Runtime status never loads in packaged desktop
- **Location:** `apps/web/src/lib/useStartupHealth.ts:61–64` `invokeFn()`; correct resolution already exists at `lib/transport.ts:52`.
- **Evidence:** `w.__TAURI__?.invoke ?? null` misses Tauri v2's `__TAURI_INTERNALS__.invoke` and `__TAURI__.core.invoke`; every `runtime_status` call is swallowed by `.catch(() => undefined)`. `transport.ts` contains an explicit comment documenting this exact bug.
- **Impact:** System Health shows no sidecar port, restart count, last-restart reason or data/log dirs in packaged builds — fabricated absence of data.
- **Fix / test:** reuse `resolveInvokeFn()` from `transport.ts`. Test with only `__TAURI__.core.invoke` stubbed.
- **Owner / status:** Will / **OPEN**.

### F-29 — P2 — WS subscription leak on fast unmount
- **Location:** `lib/ws.ts:43–85`. Cancellation is checked once at line 49; cleanup closes a still-null `ws`, then the in-flight `/ws/ticket` promise continues.
- **Impact:** orphan sockets, stale progress callbacks. **Fix:** re-check `closed` after the ticket await; close immediately if cancelled.

### F-30 — P2 — Copilot Stop does not stop
- **Location:** `features/copilot/aiApi.ts:89–94`; `CopilotPage.tsx:178–182`.
- **Evidence:** `if (req.signal?.aborted) throw` runs *before* `await askAi(...)`; after the await, `onDelta(res.text)` is unconditional.
- **Impact:** clicking Stop while an explanation is pending still renders the answer. **Fix:** re-check `signal.aborted` after await.

### F-31 — P2 — Copilot availability badge inverted
- **Location:** `CopilotPage.tsx:64–74,192–199`; `local_runtime.rs:137–141`.
- **Evidence:** `healthy = status?.available === true` ties the badge to the *optional local LLM*, while the Rust engine explicitly works with it disabled.
- **Impact:** a working assistant is labelled "Offline"; an "Online" label overstates deterministic rewrites as model answers. **Fix:** badge on status presence with honest labels.

### F-32 — P2 — Update-history failure shown as empty history
- **Location:** `lib/updater.ts:95–102` (`catch { return []; }`); `UpdateHistoryCard.tsx:67–76,175–180`.
- **Impact:** sidecar failure renders "No update activity recorded yet" and makes the existing Retry branch dead code. **Fix:** propagate a discriminated failure.

### F-33 — P3 — Destructive adaptive actions without confirmation
- **Location:** `features/vpn/AdaptiveRecoveryCard.tsx:316–323` — `reset.mutate()` / `rollback.mutate()` fire on one click, unlike `UpdateHistoryCard.tsx:60–63,137–162`.

### F-34 — P3 — Settings draft never re-syncs
- **Location:** `SettingsPage.tsx:98–100,116–127`: `if (query.data?.settings && draft === null)` latches forever on the first snapshot.

### F-35 — P2 — False/overstated claims in nine new UI_MASTER reports
- **Evidence (independent source verification stream):**
  - `UI_MASTER_02 §1`, `UI_MASTER_10 §2`: the "single source of truth" palette and all "measured" contrast ratios were computed from `tokens.css` base values (`#05080d/#0d131d/#22d3ee/…`), but `identity.css:37–57,103–130` is imported last (`main.tsx:19`) and overrides them. Actual shipped faint/surface ratio is **4.62:1**, not the claimed 5.06:1; on-accent **9.74:1**, not 10.21:1; warn **9.27:1**, not 11.15:1. All still pass AA, but the numbers are not measurements of what renders.
  - `UI_MASTER_02/09/10`: claim "seven `prefers-reduced-motion` blocks"; there are **five** (`identity.css:672`, `tokens.css:685,745,937,1018`).
  - `UI_MASTER_02/05/09/11`: claim `animate-ping` removed; it still ships at `features/vpn/AgentPathTrace.tsx:78` (`motion-safe:animate-ping`). The narrower NANI-AiCore claim is true.
  - `UI_MASTER_11 §3`: "682 lines" of `identity.css` — actual 691. `UI_MASTER_02 §9`: "509/509 tests" — the verified sequential count at that time was 506/506 (509/509 was reached only after three new guard tests).
- **Impact:** evidence quality defect — future reviewers would trust numbers that do not describe the shipped theme.
- **Fix:** recompute contrast from `identity.css` values; correct counts; qualify removed-animation claims. **Owner / status:** Will / **OPEN**.

### F-36 — P3 — Two prompts for one Copilot empty state
- **Evidence:** screenshot `reports/FINAL_UI_visual/final-09-copilot-1280.png` shows both `Ask Copilot anything` (empty state) and `What would you like to investigate today?` (seeded assistant message). Carried `UI_MASTER_01` C-7. **Status:** OPEN — visually confirmed.

---

## Disposition notes

- **No P0 was found.** No data loss, no security compromise, and no proof that the UI fabricates a posterior from nothing.
- **Six P1s:** two are blocked math/governance items (F-01, F-02), one carried network-honesty item (F-06), and three are actionable in the redesign (F-03, F-04, F-05).
- **No finding was downgraded.** Severity reflects user impact, not ease of fix.
- **"Carried"** means the root cause predates this mission and is documented in prior reports; it is listed because the redesign touches its observable surface.
- **Will's concurrent fixes** are verified independently in `FINAL_UI_INDEPENDENT_REVIEW.md`; this registry records the state at verification time, not at first discovery.
