# UI_REVIEW_02 — Screen and Feature Inventory (functionality preservation contract)

**Read-only.** For every feature: current implementation location · behaviour · backend contract · frontend dependencies · test coverage · preservation requirement · redesign risk.

---

## A. VPN connection

| Field | Detail |
|---|---|
| Location | `features/vpn/VpnPage.tsx` + surfaces `SystemBar`, `OverviewSurface`, `AetherSurface`, `TunnelSurface`, `CoreSurface` (xray/sing-box/hysteria/v2ray), `ProviderSurface` (singbox/wireguard/openvpn), `WhitednsSurface`, `EngineIntakeCard`, `ProvisionedRepairCard`, `AdaptiveRecoveryCard`; data via `useVpnData` (`useVpnStatus`/`useVpnProfiles`/`useVpnProviders`/`useKillSwitch`/`useProxyEngines`/`useAetherEngine`) |
| Behaviour | Connect / disconnect / reconnect per provider; engine selection; tunnel lifecycle (start/stop/status); kill switch; Aether (MASQUE/SOCKS5); whitedns; smart-connect; discovery; import/repair |
| Backend contract | `POST /vpn/connect|reconnect|disconnect|verify`; `GET /vpn/status|health|profiles|providers|tunnel/status|killswitch|history`; `/vpn/aether/*`, `/vpn/tunnel/*`, `/vpn/smart-connect*`, `/vpn/discover`, `/vpn/selftest*`; `vpn_elevation_bridge` IPC |
| Frontend deps | `useVpnData`, `lib/ws` (`quick-connect:*`, `vpn-selftest`), `lib/elevationBroker`, `lib/admin` |
| Tests | Strong logic coverage: `tunStatus`, `tunnelExitHint`, `agentPath`, `discoveryReport`, `provisionedRepair`, `vpnDecisionCards`; **no** test for status polling / verification truth |
| Preserve | All provider surfaces, elevation flow, kill switch, honest verification states (see UI_REVIEW_04) |
| Redesign risk | **HIGH** — collapsing "connected" vs "verified" is the single most dangerous visual shortcut; the status payload cannot express `verified` after connect (F1). |

## B. Servers & configurations

| Field | Detail |
|---|---|
| Location | `features/servers/ServersPage.tsx`, `features/nodes/*` (`NodeExplorerPage`, `NodeDetailPage`, `NodeSourcesPage`), `features/optimizer/OptimizerPage.tsx`, `features/engines/EngineManagerPage.tsx` |
| Behaviour | Import configs (text/URL/scan), discovery, validation, testing, sorting/filtering/paging, selection, favourite/tag, geo-recheck, delete/edit, engine compatibility + install |
| Backend contract | `GET /nodes` (16 query params), `/nodes/:id`, `/nodes/:id/test`, `/nodes/test-batch`, `/nodes/import|export`, `/nodes/:id/favorite|tags|geo-recheck`, `/nodes/engines|engines/releases|engines/install`; `/sources*`, `/scanner/*`, `/test-endpoints`; `/servers*`, `/health-monitor/*`; `/optimizer/run` |
| Frontend deps | `useNodeActions` (Explorer/Detail/Map), `EngineBadge`, `NodesNav`, `usePersistentState` (10 `nodes.*` keys) |
| Tests | `nodeActionPolicy`, `nodeHealthDisplay` (logic); **no** page tests for Explorer/Sources/Servers/Optimizer |
| Preserve | Every action + its toast wording (`nodeActionPolicy` pins them), pagination, selection semantics |
| Redesign risk | **MEDIUM-HIGH** — sorting must preserve selection; `ServersPage` renders N recharts instances; hardcoded weight string will drift from settings. |

## C. NANI

| Field | Detail |
|---|---|
| Location | `features/nani/NaniPage.tsx` (1316 lines) + `OverviewTab`/`LiveTab`/`WorkspaceTab`/`HypothesesTab`/`EvidenceTab`/`NetworkTab`/`LearningTab`/`HistoryTab`/`SettingsTab`/`RecoveryControls`; `useNaniEvents`, `naniStore`, `naniApi`, `hypothesisView`, `naniEvents` |
| Behaviour | Investigation lifecycle (start/cancel/status/history), evidence retrieval, hypothesis presentation, health checks, confidence, learning/calibration/drift, AI workspace (local LLM explain), recovery planner |
| Backend contract | Tauri `nani_*` (17 commands) on desktop; REST `/nani/status|apis|check|diagnose|recovery/*|health/shadow` in web mode |
| Frontend deps | `naniStore` (localStorage `np.nani.*`), `naniEvents` reducer, `useNaniEvents` (Tauri `nani:event` + 5 s `nani_poll_events`) |
| Tests | `naniEvents` (reducer dedupe/gap/bound), `hypothesisView` (rows); **no** test for `naniStore` or `useNaniEvents` cleanup |
| Preserve | Uncertainty must stay visible (`unknown`/`—`), never collapse to 0% or success; event ordering/gap handling |
| Redesign risk | **HIGH** — hypothesis/confidence display is where a "prettier" UI most easily fabricates certainty. |

## D. Diagnostics

| Field | Detail |
|---|---|
| Location | `features/diagnostics/DiagnosticsPage.tsx`, `features/speed-test/SpeedTestPage.tsx`, `features/dns/DnsPage.tsx`, `features/gaming/GamingPage.tsx`, `features/iran/IranConnectivityPage.tsx`, `features/ip/IpPage.tsx`, `features/routes/RoutesPage.tsx`, `features/cloudflare/CloudflarePage.tsx`, `features/health/SystemHealthPage.tsx` |
| Behaviour | TCP/complete/bufferbloat/MTU/CGNAT tests, speed run, DNS test/leak/custom, gaming session/compare, Iran connectivity, IP/WebRTC leak, route trace/compare, Cloudflare scan/validate, system health + self-test + log tail + repair |
| Backend contract | `/diagnostics/*`, `/speed/*`, `/dns/*`, `/gaming/*`, `/iran/*`, `/ip`, `/webrtc-report`, `/route-test|route-compare*`, `/cloudflare/*`, `/meta/health`, `/vpn/selftest*`, `/stability/*`, `/ping-test` |
| Frontend deps | `lib/ws` (test progress), `useBackgroundTest`, `useScheduleStatus`, `ScheduleChip`, `LatencyChart` |
| Tests | Mostly none at page level; `failureIntelligence`, `startupPhase` logic only |
| Preserve | Real progress only (no fabricated %), failed runs not shown as success, live-log honesty |
| Redesign risk | **MEDIUM** — several pages `catch {}` silently (diagnostics/routes/cloudflare), so a redesign can hide failures further. |

## E. Account & settings

| Field | Detail |
|---|---|
| Location | `features/account/AccountPage.tsx` (`WelcomeGate`/`AccountDashboard`/`SessionRow`/`EncryptedBackupCard`/`VpnProfilesCard`/`TelegramIntegrationCard`/`SubscriptionCard`), `features/settings/SettingsPage.tsx` (+ `RecoveryCard`/`AutoTestPanel`/`SchedulePanel`/`UpdateChecker`/`UpdateHistoryCard`), `features/copilot/CopilotPage.tsx` |
| Behaviour | Cloud auth (signup/login/forgot/reset), session, subscription mirror, Telegram link/claim/unlink, encrypted profile vault, preferences (theme/type scale/engine/privacy), updater, safe mode |
| Backend contract | `/cloud/egress` → Worker (`/account/*`, `/integrations/*`, `/subscriptions`); `/settings`, `/settings/schedule*`, `/meta`, `/meta/capabilities`; IPC `reset_app_state`, `netpulse_safe_mode`, `secret_*` |
| Frontend deps | `useSessionStore`, `useCloudSession`, `syncEngine`, `secureStore` (DPAPI), `profileVaultCrypto`, `vaultKey`, `useTheme`, `useTypeScale` |
| Tests | `subscriptionView`, `forgotPasswordCountdown`, `cloudSync`, `cloudRefreshRace`, `secureStore`, `provisionProfiles`, `transport`, `tauriInvoke` — **good** for account; settings page itself untested |
| Preserve | Entitlement is **server-enforced** — frontend only mirrors; auth state; theme/type-scale persistence; DPAPI secret handling |
| Redesign risk | **MEDIUM** — auth/secret surfaces must not leak; theme changes must keep contrast in both themes. |

---

## Global verified page defects (all read from source)

- **Dashboard** — `<a href="/events">` and four raw anchors in `ConnectionCard` cause full SPA reloads; `runQuickTest` progress bar is decorative; `ConnectionCard` hardcodes `DNS status → "not measured yet"`.
- **Diagnostics/Routes/Cloudflare** — `catch {}` swallows start failures; `toolError` retry only dismisses; Cloudflare cancel has no try/catch.
- **Speed test** — `LatencyChart` fed Mbps but formatter says `"ms"/"Latency"`.
- **History** — `detailQuery.isError` never rendered; range filters only the already-fetched 200 rows client-side.
- **Settings** — `draft` initialised once, never re-synced after external `PUT /settings`; `Language` select has one hardcoded option.
- **Health** — busy state written but never read (buttons never show progress); `doRepair` and `doRestartBackend` both call `restart_backend`; `useStartupHealth` instantiated twice (shell + page).
- **Copilot** — docblock claims cloud `/ai/ask`; implementation is local `nani_explain`; `canRetry` always true; hardcoded `bg-background`/`text-green-500`.
- **Nodes** — `pageSize` hardcoded 50 with no setter; `NodeDetailPage` bypasses react-query.
- **Servers** — `RecommendationCard` hardcodes weight string; hand-rolled progress bar.
- **VPN** — uses Radix `RTabs` directly vs shared `Tabs` elsewhere.
- **Orphans** — `features/nani-reports/nani-reports-page.tsx` unrouted; `features/nani-memory` is an extensionless unimported file that would not parse; `PhaseBadge` unused.
- **Global** — `ws.ts` opens one socket per subscription; `AppErrorBoundary` "Reset app state…" runs with no confirmation.
