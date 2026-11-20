# FINAL_UI_RECOVERY_02_P1_ROOT_CAUSE_ANALYSIS

## Summary

The actionable P1 findings were caused by four distinct class of defect: fabricated verdicts, unreachable UI, URL-controlled components with no state setter, and an IPC detector that did not understand packaged Tauri v2.

## F-03 — attempt count presented as health verdict

**File:** `apps/web/src/features/nani/NaniPage.tsx`

`parseHealthCheckResult` returned `healthy: webChecked, total: webChecked` when no aggregate backend verdict was present. In web mode, a check attempt per registered API was therefore rendered as a successful health verdict, even when the underlying `/nani/check` calls failed.

**Root cause:** Count of attempted operations was substituted for a measured outcome.

**Correction:** `healthy` is now `number | null`; the web path returns `null`; the render path says “Checks attempted; verdict unavailable”.

## F-05 — connection console was dead code

**File:** `apps/web/src/features/dashboard/DashboardPage.tsx`

`ConnectionHero` and its truth module existed but no route imported or mounted them. The dashboard still rendered only the legacy `ConnectionCard`.

**Root cause:** New redesign components were added without route wiring.

**Correction:** `useConnection()` is called unconditionally and `<ConnectionHero state={connection} />` is mounted above the legacy card. Mounting exposed a latent crash in `connectionState.ts` (`q.state.data?.tunnel.state`), which was corrected with `q.state.data?.tunnel?.state`.

## F-27 — Settings tabs were inert

**File:** `apps/web/src/features/settings/SettingsPage.tsx`

The component consumed `useSearchParams()` but discarded the setter. `<Tabs value={tab}>` was controlled, but no `onValueChange` handler existed, so clicks could not change the tab. Six of seven sections were unreachable without hand-editing the URL.

**Root cause:** Controlled component with read-only URL state.

**Correction:** Added `selectTab`, wired `onValueChange`, preserved unrelated query parameters, validated against `VALID_TABS`, and used `{ replace: true }` to avoid history pollution.

## F-28 — packaged Tauri v2 health status never loaded

**File:** `apps/web/src/lib/useStartupHealth.ts`

The hook checked only `window.__TAURI__?.invoke`. The canonical transport already documents and handles the packaged v2 shape through `__TAURI_INTERNALS__.invoke` / `__TAURI__.core.invoke`. Runtime status was therefore silently absent in the packaged desktop app.

**Root cause:** Local IPC detection duplicated and contradicted the canonical transport abstraction.

**Correction:** All `runtime_status` calls now go through `tauriInvoke()`. Added `runtimeError`, a mounted guard, and a visible `role="alert"` message in `SystemHealthPage.tsx` when the command fails.

## Rust test instability (F-15)

Two independent causes were proven:

1. Several test fixtures used `ApiEntry::new`’s default `timeout_ms = 10_000` while `wait_terminal` allows only 6 s. The N0 failing and late-registration legs were the last fixtures still using the default.
2. The N1 oracle compared the preliminary `AnalysisCompleted` label with the final post-verification status label. Production intentionally recomputes the leader after verification (N1.1), so the assertion encoded a stale contract.

Neither cause justified changing engine math. Both were corrected in test code only.
