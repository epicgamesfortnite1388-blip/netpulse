# 07 — FRONTEND AND UX AUDIT

**Scope:** `apps/web/src/features/*` (27 feature directories), `apps/web/src/app/router.tsx`, `apps/web/src/components/`, `apps/web/src/lib/`, `apps/web/src/styles/`, `apps/web/test/`.
**Method:** Line-by-line specialist audit + personal verification and repair of every P2/P3 functional finding. Prior UI remediation operations (`UI_REMEDIATION_*`, `FINAL_UI_*`, `UI_MASTER_*`, `UI_DESIGN_2_*`) are present at this HEAD and were treated as baseline, not re-reported as open.
**Environment note:** IDE theme is light; all token/contrast reasoning below is source-level (`identity.css`, `tokens.css`) and computed-style test output, not a fresh browser session (no built installer in this run).

## Confirmed correct (with evidence)

- **Design tokens** — `apps/web/src/styles/identity.css:57,128,180` and `tokens.css:55,317,371` define light/dark palettes; the `test:ui-contract` and `test:ui-colour` gates assert no raw palette leakage and light-theme overrides. CI runs both (`.github/workflows/ci.yml:97-101`, concurrent-session addition).
- **External navigation** — `apps/web/src/lib/externalNavigation.ts` installs one capture-phase document guard covering clicks, middle clicks, drops and keyboard activation; `tests/externalNavigation.test.ts` and `externalUrlLink.test.tsx` verify it.
- **Progressive disclosure** — four-level model in `apps/web/src/lib/detailLevel.ts`; 29 routes now carry `DetailLevelControl`/`DetailGate` (verified by `test/detailLevel.test.ts` 16 tests and the route-coverage test). "Raising detail never removes content" is a monotonicity property with a dedicated test.
- **Honest connection truth** — `ConnectionHero`, `GlobalConnectionChip` and the VPN pages render unproven/proxy-only states distinctly; `test/tunnelExitHint.test.ts`, `test/tunStatus.test.ts` (13), `test/geoStatus.test.ts` (5) cover the distinctions.
- **Error states** — `ErrorState`/`EmptyState`/`LoadingState` primitives are used consistently; `test/errorStateRetry.test.tsx` verifies retry affordances.
- **Accessibility primitives** — `test/headingLevel.test.ts` (4), `disclosure.test.ts` (6), `detailLevelComponent.test.tsx`, `test/confidenceRingGlyph.test.ts` (6) pin semantics and glyph accessibility. `scripts/ui-a11y-check.mjs` / `ui-a11y-advanced.mjs` exist as opt-in gates.

## Repairs made in this pass

### DD-035 (P2) — repeat background tests displayed the previous run's result

`useBackgroundTest` (`apps/web/src/lib/useBackgroundTest.ts`) kept React state across `testId` transitions. Ten call sites reuse one mounted component (SpeedTest, Diagnostics ×3, Dns ×2, Gaming, Optimizer, Routes ×2); `DiagnosticsPage.tsx:129-158` and `RoutesPage.tsx:135-152` explicitly clear the id (`setDiagId(null)`) before POSTing the next run. Consequently a fresh test rendered the OLD numbers, and a failed POST left a result on screen with no error.

**Fix:** reset state on every id transition (`useBackgroundTest.ts:52`). **Regression:** `apps/web/test/backgroundTestState.test.tsx` drives the real hook through a real React 19 root, with only WS/REST mocked; 3 cases cover new-id, clear-id, and same-id. **Mutation:** removing the reset fails 2/3 cases (`expected { v: 'A' } to be null`). Result: **3 passed / 0 failed**.

### FE-DD-02 (P3) — leak-test button swallowed failures

`DnsPage.tsx:765` used `onClick={() => api.post(...).then(...)}` with no rejection handler: a failed POST produced an unhandled promise rejection and no visible error. **Fix:** added `leakSubmitError` state, an `async runLeakTest()` with try/catch, and an `<ErrorState error={leakSubmitError} retry={...} />` branch (`:158-174`, `:775-779`). Web typecheck PASS.

### FE-DD-03 (P3) — five internal anchors bypassed the SPA router

The app uses `createBrowserRouter` (`app/router.tsx:50`), but `ConnectionCard.tsx:101,113,118,127` and `DashboardPage.tsx:418` used plain `<a href="/ip|/vpn|/routes|/events">`, forcing a full document reload (re-running boot, discarding in-memory state) instead of client-side navigation. **Fix:** converted all five to react-router `<Link to>`; zero raw internal anchors remain in `apps/web/src/features/**/*.tsx`. Web typecheck PASS.

## Findings reviewed but not changed

- **FE-DD-04 (P3, dark-theme danger contrast).** `--color-danger` is `#ee7a70` in dark mode (`identity.css:57`) over `bg-danger/15`; a source-level calculation yields ~2.74:1 for text on the tinted surface, below WCAG AA for small text. However `identity.css` is concurrently modified by another session and the UI contract gate currently passes. Recorded as an open P3 item (FE-DD-04) rather than risking an overlapping edit during this run.
- **FE-DD-05 (P3, command palette dialog semantics).** `CommandPalette.tsx` uses `useNavigate` but was not verified to expose `role="dialog"`/`aria-modal`. Unverified without a browser run; recorded as such, not asserted as a defect.
- **FE-DD-06/07/08 (P4).** Light-accent hue coupling, dangling `aria-controls` on folded cards, and a weak source-string test. Low impact, no behavioral risk; left open with evidence in the findings register.

## Unverified

- No real WebView2/browser interaction in this pass: focus management, screen-reader output, reduced-motion behavior and computed contrast were checked from source/tests only.
- No screenshot-driven visual regression comparison; `scripts/ui-visual-regression.mjs` exists but was not executed (no running app).
- Responsive breakpoints were inspected in CSS but not at multiple viewport widths.

**Verdict:** frontend correctness improved materially (one P2 state-truth defect, two P3 interaction defects fixed). Remaining items are P3/P4 and require a live browser to confirm.
