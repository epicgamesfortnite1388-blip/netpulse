# UI_REVIEW_09 — Risk Register

Consolidated, de-duplicated risks. IDs are stable for tracking. **Blocks redesign** = must be resolved (or explicitly accepted) before/with the relevant stage.

---

## CRITICAL

| ID | File · Symbol | Evidence | Impact | Remediation | Blocks |
|---|---|---|---|---|---|
| R-C1 | `apps/api/src/vpn/vpnService.ts` · `verifyConnect` + all provider `status()` | verification returned only from `connect()`, never stored; `status()` hardcodes `not_verified` | "Connected" shown without any persisted proof of routing; verified badge unreachable after first poll | Persist `verification`/`verifiedPublicIp` on the provider; `status()` returns it | **YES** |
| R-C2 | `apps/api/src/routes/vpn.ts` · `runElevatedWireGuardConnect` | accepts interface appearance as connected; no IP probe | Primary Windows path reports connected without routing proof | Call `verifyConnect` after elevation; store result | **YES** |

## HIGH

| ID | File · Symbol | Evidence | Impact | Remediation | Blocks |
|---|---|---|---|---|---|
| R-H1 | `vpnService.ts` · `OpenVpnProvider.connect/status` | 3 s child-survival heuristic | Daemonised-but-unauthenticated OpenVPN reads connected | Parse management interface / verify routes | **YES** |
| R-H2 | `apps/api/src/services/proxyTunnel.ts` · `start()` | `state:'active'` set before exit-IP trace | ~12 s false "active" window | Enter `active` only after trace succeeds | **YES** |
| R-H3 | `apps/web/src/features/vpn/VpnPage.tsx` · error banner + `SystemBar` | react-query keeps `data` on refetch error; bar unconditional | "Tunnel up" shown while status unreadable | Add `dataUpdatedAt`/staleness; render unknown on error | **YES** |
| R-H4 | `VpnPage.tsx`/`ProviderSurface.tsx`/`AetherSurface.tsx` · disconnect `onSuccess` | invalidates `['vpn']` only, not `['tunnel',*]` | Stale "Proxy tunnel active"/exit IP up to 5 s after Disconnect | Invalidate tunnel + history on disconnect/reconnect | **YES** |
| R-H5 | `apps/web/src/lib/ws.ts` · `subscribeTest` | `cancelled` not re-checked after ticket await | Leaked authenticated socket per mid-handshake unmount | Re-check `cancelled`; close in `finally`; `onclose` resets | **YES** (cheap) |
| R-H6 | `apps/web/src/features/servers/ServersPage.tsx` · `RecommendationCard` | inline WS handler identity changes per render | Reconnect + ticket POST per progress frame; lost frames | `useCallback` handler / ref-based latest | **YES** (cheap) |
| R-H7 | `apps/web/src/lib/cloud/secureStore.ts` · `secret_unprotect` | DPAPI decrypt reachable from webview JS | Credential dump if any XSS primitive appears | Preserve CSP + zero-HTML-sink; or gate the command | No (invariant) |
| R-H8 | `apps/web/src/features/map/LiveMapPage.tsx` · zoom→`setGlobeZoom` | page re-render + cluster rebuild per camera frame over 1500 pins | Jank while zooming the map | Quantize/rAF-throttle zoom; cluster inside `GlobeCanvas` | **YES** |

## MEDIUM

| ID | File · Symbol | Evidence | Impact | Remediation | Blocks |
|---|---|---|---|---|---|
| R-M1 | `VpnPage.tsx` · reconnect `onSuccess` | invalidates only `['vpn']` | Bar shows two owners for ≤5 s | Invalidate tunnel on reconnect | Yes |
| R-M2 | `routes/vpn.ts` · `statuses.find` + `/vpn/connect` | two engines can connect; one reported | Ghost connection with no UI | Disconnect existing on connect (or reconcile) | Yes |
| R-M3 | `lib/useNaniEvents.ts` · `attach()` | interval created after cleanup ran | 5 s poll forever after leaving `/nani` | Guard after `await`; clear in `finally` | Yes |
| R-M4 | `lib/useVpnSelfTest.ts` + `realtime/bus.ts` | replay overwrites newer GET result | Stale self-test result | Apply by timestamp/seq | No |
| R-M5 | `features/vpn/SmartConnectCard.tsx` | `plan ?? planQuery.data` never cleared | 60 s refetch permanently ignored | Clear local snapshot on new data | No |
| R-M6 | `VpnPage.tsx` · disconnect affordance | `connected || killSwitch` only | No stop control when only tunnel is up | Show Disconnect on `tunnel.active` too | No |
| R-M7 | `ProviderSurface.tsx` · `useVpnHealth` | cached `data` persists across sessions | Previous session counters shown | Reset key on connect/disconnect | No |
| R-M8 | `VpnPage.tsx` · SystemBar first render | no `isPending` branch | "No tunnel is up" before first response | Add loading branch | No |
| R-M9 | `apps/web/src/lib/externalNavigation.ts` / `openExternal.ts` | non-http(s) not neutralised; `ExternalUrlLink` no scheme check | Web/dev scheme abuse via backend-supplied hrefs | Scheme allowlist in `openExternalUrl` | No |
| R-M10 | `lib/cloud/sessionStore.ts` / `secureStore.ts` | access token plaintext; secureStore plaintext fallback (web) | Token exposure in web mode | Accept (documented) or harden | No |
| R-M11 | `transport.ts`/`ws.ts`/`naniApi.ts` | no zod validation | Malformed payloads mis-rendered | Validate with shared zod schemas | No |
| R-M12 | `ServersPage.tsx` · per-row `LatencyChart` | N recharts instances per 12–15 s poll | Scale cost | `memo` rows; SVG sparkline | Yes |
| R-M13 | `LatencyChart.tsx` | static import on index route (350 kB) | First-paint cost | Lazy chart / hand-rolled sparkline | Yes |
| R-M14 | Dashboard pollers (~13 intervals) | 5/6/8 s cadences | Constant churn on landing | Push channel or ≥10 s + structural sharing | Yes |
| R-M15 | `NodeExplorerPage` search | storage write + query per keystroke | Typing jank | Debounce 250 ms | Yes |
| R-M16 | Map overlays `backdrop-blur` over WebGL | 4 blurred overlays inside canvas | Per-frame re-blur | Drop blur where ≥85 % opaque | Yes |
| R-M17 | `test` infra (Vitest workers) | 52–54 files / 497–502 across runs, all "passed" | Silent coverage drop under load | Pin workers; assert exact count in CI | No |

## LOW

| ID | Finding | Remediation |
|---|---|---|
| R-L1 | `ws.ts` no reconnect | add `onclose`/backoff |
| R-L2 | `SmartConnectCard` etc. minor | as above |
| R-L3 | Dashboard raw `<a href>` full reloads; `ConnectionCard` hardcoded "not measured yet" | use `NavLink`; wire real DNS status |
| R-L4 | Diagnostics/Routes/Cloudflare `catch {}` silent failures | surface errors |
| R-L5 | Speed test `LatencyChart` labelled "ms" for Mbps | pass a formatter/unit |
| R-L6 | History detail error never rendered; range filters fetched rows only | render error; server-side range |
| R-L7 | Settings `draft` never re-synced after external PUT; `Language` one option | re-sync on `dataUpdatedAt`; remove or wire |
| R-L8 | Health busy state unread; Repair/Restart same command; `useStartupHealth` duplicated | read busy; distinguish commands; single instance |
| R-L9 | Copilot docblock lies (cloud vs local); `canRetry` always true; hardcoded colors | correct copy; honest retry; tokens |
| R-L10 | Nodes `pageSize` hardcoded; `NodeDetailPage` bypasses react-query | expose setter; adopt query |
| R-L11 | Servers hardcoded weight string; hand-rolled progress | read settings; use `Progress` |
| R-L12 | VPN uses Radix `RTabs` vs shared `Tabs` | unify |
| R-L13 | Orphans: `nani-reports` page unrouted; `nani-memory` extensionless unparsable; `PhaseBadge` unused | remove or wire (separate task) |
| R-L14 | `AppErrorBoundary` reset with no confirmation | add confirm |
| R-L15 | `openExternalUrl` reports success early | return real outcome |
| R-L16 | `bootstrap` origin trusted | validate against expected loopback |

## Informational (positive invariants to preserve)
- Memory-only sidecar token; server-enforced entitlement; Rust URL/path allowlists; redacted logs; zero HTML sinks; `CardBody` unmounts folded content (stops pollers).
