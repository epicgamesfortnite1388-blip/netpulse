# FINAL_UI_RECOVERY_03_P1_FIX_REPORT

## Frontend fixes

| Finding | File | Change |
|---|---|---|
| F-03 | `apps/web/src/features/nani/NaniPage.tsx` | Nullable health verdict; honest “checks attempted” empty state |
| F-05 | `apps/web/src/features/dashboard/DashboardPage.tsx` | Mounted `ConnectionHero` with unconditional `useConnection()` |
| F-05 latent crash | `apps/web/src/features/connection/connectionState.ts` | Optional chain on `tunnel` in `refetchInterval` |
| F-27 | `apps/web/src/features/settings/SettingsPage.tsx` | Functional URL setter + `onValueChange` + param preservation |
| F-28 | `apps/web/src/lib/useStartupHealth.ts` | Canonical `tauriInvoke()`; mounted guard; `runtimeError` |
| F-28 UI | `apps/web/src/features/health/SystemHealthPage.tsx` | Visible runtime-status failure alert |
| F-07 | `apps/web/src/features/nani/useNaniEvents.ts` | Cancellation guard after async poll; replay gap surfaced |
| F-08/F-09 | `apps/web/src/features/nani/naniEvents.ts` | “unavailable” for missing `verified`; unhealthy checks no longer mask older failures |
| F-29 | `apps/web/src/lib/ws.ts` | Recheck cancellation after ticket await; close late socket |
| F-30 | `apps/web/src/features/copilot/aiApi.ts` | Recheck `signal.aborted` after `askAi` resolves |
| F-30/F-31/F-36 | `apps/web/src/features/copilot/CopilotPage.tsx` | Mid-flight abort cleanup; honest badge; one empty-state prompt |
| F-32 | `apps/web/src/lib/updater.ts` | Update-history transport failure now throws |

## Representative code

```tsx
const [searchParams, setSearchParams] = useSearchParams();
const selectTab = (value: string) => {
  if (!(VALID_TABS as readonly string[]).includes(value)) return;
  setSearchParams(
    (prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', value);
      return next;
    },
    { replace: true },
  );
};
```

```ts
const pollRuntime = useCallback(() => {
  const call = tauriInvoke<RuntimeStatus>('runtime_status');
  if (!call) return;
  void call
    .then((s) => {
      if (!mounted.current) return;
      setRuntime(s as RuntimeStatus);
      setRuntimeError(null);
    })
    .catch((err: unknown) => {
      if (!mounted.current) return;
      setRuntimeError(err instanceof Error ? err.message : String(err));
    });
}, []);
```

```ts
refetchInterval: (q) => {
  const s = q.state.data?.tunnel?.state;
  return s === 'starting' || s === 'stopping' || s === 'down' ? 1_500 : 5_000;
},
```

## Rust test-only fixes

**File:** `src-tauri/src/network_intelligence/investigation.rs`

- Shortened `timeout_ms` on closed/late localhost fixtures from the 10 s default to 50 ms.
- Added diagnostic detail to `wait_terminal` timeout messages.
- Corrected the N1 oracle so `AnalysisCompleted` is compared to the preliminary posterior, while the final status remains compared to the post-verification reference posterior.

No engine math, likelihood table, likelihood calibration, probe transport, or production assertion was changed.

## Verification

- Frontend typecheck: PASS.
- Web tests: 55 files / 523 tests PASS.
- UI contract: 47/47 PASS.
- Rust suite: 552 passed / 0 failed / 2 ignored.
- Fresh Vite build: PASS (`✓ built in 1m 6s`).
