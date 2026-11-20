# UI_REVIEW_08 — Regression Test Plan

**Read-only.** 54 test files on disk (50 in `apps/web/test` + 4 colocated); stable run **54 files / 502 tests, 0 failed**. Runner: Vitest 5, jsdom, no testing-library. No test spawns processes or real network (all transport mocked).

---

## 1. Test map by category

| Category | Count | Representative files (what they protect) |
|---|---|---|
| Unit (pure logic) | 27 | `agentPath` (hop state machine), `tunStatus` (TUN tone/label), `nodeActionPolicy` (toast wording; failed probe never shows duration), `needsAttention`, `mapGlobeAccuracy`, `quickConnect`, `updater` (never "up to date" on failure), `headingLevel`, `disclosure`, `failureIntelligence`, `startupPhase`, `tunnelExitHint`, `discoveryReport`, `geoStatus`, `mapClusterPerf` |
| Component (renders JSX) | 7 | `vpnDecisionCards` (verified 580 ms only where a probe carried traffic), `nodeHealthDisplay` (unprobed = `—` not `0.0%`), `errorStateRetry` (no retry on 400/404), `subscriptionView`, `agentPathRender`, `forgotPasswordCountdown`, `externalUrlLink` |
| Service (api/transport/cloud) | 13 | `cloudSync`, `cloudRefreshRace` (single-flight refresh), `cloudTimeouts`, `provisionProfiles` (no secrets rendered), `transport` (web vs Tauri, bearer, memoization), `tauriInvoke`, `secureStore` (encrypt/decrypt, corrupted blob dropped), `openExternal`, `externalNavigation` |
| State management | 3 | `naniEvents` (dedupe by eventId, gap counting, bounded 256 buffer), `cloudSync`/`cloudSyncCompletion` |
| Visual / CSS contract | 3 | `tokenRefs`, `typeScale`, `cardStagger` (see §3) |
| Static policy scan | 1 | `noRawConfigSurface` (no raw config/secret surfaces) |

## 2. Route coverage

**Strong:** `/vpn` (logic + decision cards), `/map` (logic), `/account` (subscription + forgot-password).
**Logic-only (page never rendered):** `/`, `/nodes`, `/nodes/:id`, `/settings` (indirect), `/engines` (indirect), `/health` (string scan), `/nani` (partial).
**Zero page coverage (16):** mission, overdrive, diagnostics, speed-test, dns, gaming, iran, ip, routes, cloudflare, nodes-sources, servers, optimizer, history, events, copilot.
**Untested hooks/modules with no reference anywhere:** `lib/ws.ts`, `features/nani/naniStore.ts`, `features/vpn/useVpnData.ts`, `lib/usePersistentState.ts`, `lib/useBackgroundTest.ts`, `lib/useStartupHealth.ts`, `lib/useVpnSelfTest.ts`, `features/copilot/aiApi.ts`.

## 3. Tests that pin contracts (most fragile under redesign)

1. **`typeScale.test.ts`** — highest risk: any `text-[11px]`, one-off `text-[13px]`, or a ramp token written as `0.875rem` instead of `calc(0.875rem * var(--type-scale))` fails; a new `TypeScaleSetting` without a CSS rule fails.
2. **`tokenRefs.test.ts`** — renaming/removing a token, or referencing a token before it is declared, fails with a per-line offender list; forbids `text-[var(--…)]`, `--border`, `--bg-inset`, `--accent`, `--foreground`, `--card`, `--primary` bracket forms.
3. **`cardStagger.test.ts`** — pinned to `.stagger > *`, `@keyframes card-in`, `--stagger-*`, `nth-child(1..8)`, `backwards` (not `both`), and the literal class `stagger` in **ten named files**; `AppShell` must never combine `stagger` + `page-enter`.
4. **`vpnDecisionCards.test.tsx` / `nodeHealthDisplay.test.tsx`** — the `tile()` regex depends on the exact `Metric`/`MetricStrip` DOM (`<p>Label</p><p>Value</p>`); changing `<p>`→`<span>` or adding a wrapper breaks every tile assertion.
5. **`confidenceRingGlyph.test.ts`** — asserts React element internals (`g.props.children.type === 'circle'`, `strokeDasharray`, `opacity`, `currentColor`).
6. **`mapGlobeAccuracy.test.ts`** — hard-coded continent boxes, arc lift, latency ramp.
7. **`mapClusterPerf.test.ts`** — wall-clock budgets (5k nodes <100 ms) — flaky on slow CI.
8. **`noRawConfigSurface.test.ts`** — textual scan; new copy containing "Export JSON"/`vless://` fails.
9. **`quickConnect`/`tunStatus`/`nodeActionPolicy`** — exact copy strings; copy rewrites fail dozens of assertions.
10. **Path-coupled tests** — `readFileSync` joins on `DashboardPage.tsx`/`tokens.css`; moving files breaks them even when content is correct.

## 4. Ten new tests required for the redesign

1. **`vpnConnectedRequiresVerification.test.tsx`** — feed `core-start`/`core-ready`/`dns-policy-active`/`route-active` without `exitIp`, then `connected ok:true`; assert the UI never shows "Route verified"/connected until a `connected`/`complete` event with `ok:true` that carries verification.
2. **`staleEventOrdering.test.ts`** — `applyNaniEvents` seq 10 (`analyze`) then late seq 4 (`observe`); assert stage stays `analyze`, `lastSeq` stays 10, a replayed seq 5 `InvestigationCompleted` does not clear the newer stage.
3. **`disconnectClearsState.test.ts`** — `{connected:true, exitIp, tunnel:'active', health}` then `disconnect {connected:false}`; assert `providerIsActive` false, exit/tunnel/health cleared, kill-switch still reported, no stale cached `connected:true`.
4. **`naniUncertaintyDisplay.test.tsx`** — hypothesis rows with `confidence: null/NaN/-1/2` render `unknown`/`—`, clamp 0–100, never render `0%` as certainty; `joinedLate`/`gapCount` produce an explicit "missed events" note.
5. **`diagnosticsFailureTone.test.ts`** — failed run `{status:'failed', latencyMs:85, error:'ENOTFOUND'}` → tone warn/error, body = error text, latency never shown; `skipped`/`unavailable` ≠ ok.
6. **`serversSortSelection.test.ts`** — comparator keeps the selected server id after re-sort, stable ties, selection cleared (not reassigned) when the server disappears.
7. **`navigationPreservesState.test.tsx`** — `MemoryRouter` + `usePersistentState`: filter/sort/selected id survive `/servers`→`/vpn`→back; route change does not remount the persisted key.
8. **`themeContrast.test.ts`** — parse `tokens.css` for light + dark; assert WCAG ≥4.5 body text and ≥3.0 large text/UI borders against surface tokens in **both** themes.
9. **`serversPerf.test.ts`** — 5,000 servers filter+sort+group under a fixed budget and memo-stable for identical input (mirror `mapClusterPerf`).
10. **`useNaniEventsCleanup.test.tsx`** — mount `useNaniEvents` with stubbed `listen` returning a spy `unlisten` + fake timers; unmount; assert `unlisten` called once, all intervals cleared, no `setState` after unmount; also cover `subscribeTest` closer calling `ws.close()`.

## 5. Gate policy

- Every implementation stage must run **all 54 files / 502 tests** (assert exact count to catch the transient worker-drop; see UI_REVIEW_00) + the new tests.
- Do **not** weaken, skip, or delete a test to make a redesign pass. If a test encodes obsolete behaviour, replace it with a test of the intended behaviour and record why.
- Typecheck + production build are part of the gate, not optional.
