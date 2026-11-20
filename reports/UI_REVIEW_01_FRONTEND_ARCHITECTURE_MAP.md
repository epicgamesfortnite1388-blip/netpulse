# UI_REVIEW_01 — Frontend Architecture Map

**Read-only.** Evidence from source at `005de03`. Symbol names, not line numbers.

---

## 1. Entry points and boot

- `apps/web/src/main.tsx` — installs `installExternalNavigationGuard()` **before** first render; `initTransport()` resolves the transport (desktop Tauri `bootstrap` → loopback URL + bearer token, or web same-origin `/api/v1`) **before** mounting; then `QueryClientProvider` (staleTime 3 s, retry 1, no focus refetch) → `TooltipProvider` → `AppErrorBoundary` → `RouterProvider`.
- `apps/web/src/app/router.tsx` — `createBrowserRouter`, `AppShell` as the single layout route, **26 lazy page chunks** + eager `NotFoundPage` catch-all.
- `apps/web/src/app/AppShell.tsx` — owns sidebar (`NAV`/`NAV_SECTIONS`), travelling nav pill (`ResizeObserver`+`MutationObserver`), Ctrl/Cmd+K palette, Ctrl+Shift+K quick-connect, global banners (safe-mode / recovery / degraded), `useStartupHealth`, `useThemeApplier`, `useTypeScaleApplier`, cloud session init + sync loop, `<Suspense fallback={PageSkeleton}>` around `<Outlet/>`.

## 2. Route → entry symbol (26)

Dashboard→`DashboardPage`; mission→`MissionControlPage`; overdrive→`OverdrivePage`; map→`LiveMapPage`; diagnostics→`DiagnosticsPage`; speed-test→`SpeedTestPage`; dns→`DnsPage`; gaming→`GamingPage`; iran→`IranConnectivityPage`; ip→`IpPage`; routes→`RoutesPage`; cloudflare→`CloudflarePage`; nodes→`NodeExplorerPage`; nodes/:id→`NodeDetailPage`; nodes-sources→`NodeSourcesPage`; servers→`ServersPage`; vpn→`VpnPage`; optimizer→`OptimizerPage`; history→`HistoryPage`; events→`EventsPage`; account→`AccountPage`; engines→`EngineManagerPage`; settings→`SettingsPage`; health→`SystemHealthPage`; copilot→`CopilotPage`; nani→`NaniPage`; `*`→`NotFoundPage`.

## 3. State topology (verified)

- **react-query** — every server surface except `NodeDetailPage`, `IranConnectivityPage`, `NaniPage`, `CopilotPage`, `AccountPage`, which use `useState` + manual fetch (no cache/invalidation).
- **zustand** — only three stores: `Toaster` (`useToastStore`), `cloud/sessionStore` (`useSessionStore`), `cloud/useCloudSession`.
- **React context** — `CardFoldContext`/`CardChildLevelContext` (Card), `ScopeContext` (Disclosure), `HeadingLevelContext`, Radix `TooltipProvider`. No app-level data context.
- **Persistence** — `lib/usePersistentState.ts` → `sessionStorage` under `np.ui.*` (~55 keys across 20 files); `naniStore` → `localStorage` `np.nani.*`; `map` page uses raw `localStorage` (`map-privacy`, `map-presentation`) and `np.ui.map-min-confidence` (inconsistent); cloud tokens via `cloud/sessionStore` + `cloud/secureStore` (DPAPI desktop / plaintext web).

## 4. Shared component layer

- `components/ui/*` (18): `Card`(+Header/Body), `Disclosure`(Scope/Toolbar), `PageHeader`, `Badge`, `Button`, `Field`(Input/Select), `Metric`, `Progress`, `Segmented`, `States`(Empty/Error/PageSkeleton/Loading), `StatusDot`, `Surface`(13 primitives: Section/Panel/Notice/DataList/DataRow/MetricStrip/StatTile/MiniMetric/EngineHero/EngineGlyph/CapabilityMatrix/FieldPill/Chip/Skeleton), `Tabs`, `Switch`, `Tooltip`, `IconButton`, `HeadingLevel`, `ExternalUrlLink`.
- `components/charts/*`: `Gauge` (SVG dial), `LatencyChart` (recharts area; **hardcodes** `#22d3ee`/`#121b29` and `"ms"/"Latency"` formatter).
- `components/*`: `AppErrorBoundary`, `BrandMark` (new), `CommandPalette`, `EngineBadge`, `QuickConnectOverlay`, `ScheduleChip`, `Toaster`.
- `lib/*`: `api`/`ApiError`, `transport` (`tauriInvoke`,`initTransport`,`resetTransport`), `ws` (`subscribeTest`,`useWsTestProgress`), `useStartupHealth`, `usePersistentState`, `useBackgroundTest`, `useVpnSelfTest`, `useScheduleStatus`, `admin`, `elevationBroker`, `updater`, `format`/`transfer`, `failureIntelligence`, `geoStatus`, `disclosure`, `startupPhase`, `quickConnect`, `openExternal`/`externalNavigation`, `cloud/*`.

## 5. Tauri command surface used by the frontend (verified)

`bootstrap`, `runtime_status`, `reset_app_state`, `read_log_tail`, `save_diagnostic_report`, `data_paths`, `reveal_path`, `restart_backend`, `netpulse_safe_mode`, `open_external`, `secret_protect`, `secret_unprotect`, `admin_status`, `relaunch_as_admin`, `vpn_elevation_bridge`, `feed_check`, `feed_install`, plus 17 `nani_*` commands (`nani_explain`, `nani_ai_status`, `nani_status`, `nani_learning_status`, `nani_learning_drift`, `nani_health_check_all`, `nani_poll_events`, `nani_start/cancel_investigation`, `nani_investigation_status`, `nani_investigations`, `nani_math_hypothesis_view`, `nani_personalization_status`, `nani_learning_reset`, …). All routed through `transport.tauriInvoke`.

## 6. Dangerous-to-replace shared components (migration plan required)

Counted by importing files:

| Symbol | Importers | Why dangerous |
|---|---|---|
| `Badge` | 49 | tone vocabulary on every status surface |
| `Button` | 47 | variant/size/`loading` contract |
| `Card`/`CardHeader`/`CardBody` | 37/36/35 | `fold` prop + heading-level context; changing DOM shape breaks the outline and disclosure storage keys |
| `PageHeader` | 27 | every page's `h1` |
| `DisclosureScope`/`Toolbar` | 24/23 | 24 pages wrap their tree; storage keys depend on `name` |
| `ErrorState` | 24 | only retry affordance on 24 screens; coupled to `isRetryableError` |
| `EmptyState` | 21 | heading-rank source |
| `Field` | 19 | label semantics for every form |
| `LoadingState` | 18 | page-level loading |
| `Surface` primitives | 10–17 | VPN/nodes/mission layout language |
| `usePersistentState` | 20 files / ~55 keys | format change orphans every stored filter |
| `LatencyChart` | 7 | generic series chart (incl. Mbps) |
| `lib/api.ts` | all requests | error envelope + retry semantics |
| `lib/transport.ts` | all IPC | desktop/web branch + token |
| `lib/ws.ts` | 9 screens | per-topic ticket + `test:progress/done/error` frames |
| `useVpnData` (useVpnStatus/…) | VPN surfaces + dashboard | status source |

**Coupling warning:** `Card` + `Disclosure` + `HeadingLevel` form one unit — `Card` derives its heading rank from context and stores fold state under `disclosure:<scope>:<id>`; replacing one without the others changes both the DOM outline and the persisted keys. `ErrorState` is coupled to `isRetryableError`. `subscribeTest` is coupled to the `/ws/ticket` contract and frame shapes consumed by `useBackgroundTest`, `ServersPage`, `IranConnectivityPage`, `SpeedTestPage`.
