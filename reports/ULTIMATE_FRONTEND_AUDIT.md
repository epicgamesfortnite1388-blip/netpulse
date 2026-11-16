# ULTIMATE FRONTEND AUDIT

**Audit date:** 2026-11-16 · Scope: `apps/web/src/**`, `packages/shared/src/**`, `apps/api/src/{routes,services}/**`, `src-tauri/src/commands/**`, `tauri.conf.json`. **[V]** verified · **[A]** analysis.

---

## 1. Routes → real vs placeholder

All 26 route targets in `app/router.tsx:55-84` are substantial implementations (106–1,396 lines) with real backend calls. **No placeholder pages found.**

| Route | Verdict | Evidence |
|---|---|---|
| `/` Dashboard | Real | `dashboard/DashboardPage.tsx:56-100` (`/network/status`, `/history`, `/events`) |
| `/mission`, `/overdrive` | Real (read-only reports) | `mission/MissionControlPage.tsx`, `OverdrivePage.tsx` |
| `/map` | Real (has leak D4) | `map/LiveMapPage.tsx:150-163,603-609` |
| `/diagnostics`,`/speed-test`,`/dns`,`/ip`,`/routes`,`/cloudflare` | Real | respective pages |
| `/gaming`,`/iran` | Real | `gaming/GamingPage.tsx`, `iran/IranConnectivityPage.tsx` |
| `/servers`,`/vpn`,`/optimizer` | Real | `servers/ServersPage.tsx:196-229` etc. |
| `/nodes`,`/nodes/:id`,`/nodes-sources`,`/engines` | Real | node explorer/detail/sources, `EngineManagerPage.tsx` |
| `/history`,`/events` | Real | `HistoryPage.tsx:106-118`, `EventsPage.tsx:39-43` |
| `/account` | Real | `AccountPage.tsx:793-803`, `TelegramIntegrationCard.tsx` |
| `/settings` | Real | `SettingsPage.tsx:388-493` |
| `/copilot` | Real UI, **nonfunctional in web mode** (D9) | `CopilotPage.tsx`, `aiApi.ts:59-64` |
| `/nani` | Real (1,316 lines) | `NaniPage.tsx`, `naniApi.ts:94-229` |
| `*` | Real 404 | `app/NotFoundPage.tsx` |

**Dead (unrouted) page:** `features/nani-reports/nani-reports-page.tsx` (202 lines) — built, imported nowhere (D3).

## 2. Tauri commands: registered vs invoked

41 commands registered (`main.rs:257-299`); all 24 `#[tauri::command]` functions registered. **No invoked-but-missing; no defined-but-unregistered.** 10 registered commands are **never invoked** (D1): `nani_personalization_transitions`, `nani_context_observe`, `nani_personalization_delete`, `nani_math_entropy`, `nani_math_rank_hypotheses`, `nani_math_select_probe`, `nani_math_should_stop`, `nani_math_drift_analysis`, `nani_math_changepoint_analysis`, `nani_math_mutual_information`. Dead IPC surface, not a correctness failure.

## 3. Event contracts

- WS test stream consistent (ticket `POST /ws/ticket`, `GET /ws` single-use ticket; frontend matches).
- NANI desktop event channel matches: Rust emits `nani:event` `{seq,event:{kind,payload}}`; frontend normalizes exactly that; poll fallback shape consistent.
- **Contract drift (D2) [V] [HIGH]:** `packages/shared/src/nani/events.ts` declares event types/envelope `{seq,at,type,payload,version}` — imported by **nobody**, contradicts emitted events (`ApiHealthChanged`, `FailureDetected`, …), and is **not a zod schema**. Frontend uses hand-written unvalidated casts. Zero runtime validation of event payloads.

## 4. Subscription / entitlement / Telegram / payment

**Verified real** *provided the external bot is deployed*: signed inbound inbox, signed outbound client, link/claim/unlink, entitlement pull/upsert with ordering guards, safe-model projection; field names line up across worker → `client.ts` → `SubscriptionCard`. Provisioning checks entitlement expiry.

**Caveats (D9–D13):** no payment/checkout UI (purchases live in the external bot); link confirm-code is pre-filled with the worker-minted token so "Confirm" is clickable without Telegram (security rests wholly on the bot's claim semantics); subscription card collapsed by default (entitlement state hidden two clicks deep); bot integration needs secrets not in `wrangler.toml` (503 if unset).

## 5. Top defects

| # | Sev | Location | Defect | Impact |
|---|---|---|---|---|
| D1 | Med | `main.rs:278-298` | 10 `nani_*` commands never invoked | dead IPC surface |
| D2 | **High** | `shared/src/nani/events.ts:17-53`; `events/mod.rs`; `naniEvents.ts:266-307` | shared event contract imported by nobody, contradicts emitted events, no zod validation | malformed payloads silently mis-rendered |
| D3 | Med | `nani-reports/nani-reports-page.tsx:40` | fully-built page unrouted | dead code |
| D4 | Med | `map/LiveMapPage.tsx:347-362` | `setInterval` cleared only on completed/error, no unmount cleanup | leak + setState after unmount |
| D5 | Med | `lib/useNaniEvents.ts:82-94`; `useStartupHealth.ts:211-214` | async `listen()` unlisten resolves after cleanup | leaked listeners, stale setState |
| D6 | Low | `DashboardPage.tsx:117-131` | progress jumps 0→100 after POST; comment claims nonexistent WS polling | misleading progress |
| D7 | Low | `CopilotPage.tsx:16-20` | header claims cloud `/ai/ask`+`/ai/stream`; code uses local `nani_explain` | stale contract |
| D8 | Med | `cloud/worker/src/index.ts:1239,1281` | `/ai/ask` & `/ai/stream` uncalled and permanently 503 | dead backend surface |
| D9 | **High** | `copilot/aiApi.ts:60-64` | Copilot errors in web mode; page still navigable, advertises 8 questions | broken feature for web users |
| D10 | Med | `TelegramIntegrationCard.tsx:118-125` | confirm code pre-filled with worker token | client assurance illusory |
| D11 | Med | `TelegramIntegrationCard.tsx:189` | subscription card collapsed by default | entitlement hidden |
| D12 | Low | whole `apps/web/src` | no in-app payment/checkout | cannot renew in-app |
| D13 | Low | `api/routes/meta.ts:102-117` | `/meta` returns 10 hardcoded `true` capability flags; `/meta/capabilities` does real detection | two contradictory contracts |
| D14 | Low | `ConnectionCard.tsx`; `DashboardPage.tsx:267` | 5 `<a href>` in SPA cause full reloads | loses state, re-bootstrap |
| D15 | Low | `AccountPage.tsx:774` etc. | native blocking `window.confirm` for destructive actions | poor a11y |
| D16 | Low | `DashboardPage.tsx:122` | hardcoded test target `1.1.1.1` | not user-selectable |
| D17 | Low | `SettingsPage.tsx:388-410` | "not implemented yet" tier + `disabled` dead code (all toggles wired) | misleading comment |
| D18 | Low | `useStartupHealth.ts:193-214` vs `transport.ts:107-117` | two `sidecar-restarted` listeners; `resetTransport()` twice | duplicate work |
| D19 | Low | `AccountPage.tsx:330-340,424-431` | backup/profile loads set `null` on error, no retry | no error recovery |
| D20 | Low | `EventsPage.tsx:42` | 5s unconditional polling | avoidable load |
| D21 | Med | `naniStore.ts:100` vs `useNaniEvents.ts` | two parallel NANI states with separate cursors | divergence risk |
| D22 | Low | `LiveMapPage.tsx:370-373` | unguarded un-namespaced `localStorage.setItem` | quota/private-mode crash |
| D23 | Low | `AppShell.tsx:155-166` | `useMeta()` fetch no abort guard | setState after unmount |
| D24 | Low | `naniApi.ts:148` vs `aiApi.ts:59` | `nani_explain` via two wrappers | divergent handling |
| D25 | Low | `cloud/worker/src/index.ts:958-995` | duplicated entitlement field mapping | drift risk |

**Fixed this audit:** the type-scale violations (arbitrary `text-[10px]`/`text-[11px]` below the 12px floor) in `CopilotPage.tsx:58` and `NaniPage.tsx:879,900` — replaced with `text-micro`/`text-mini`. This was the cause of 2 failing web tests; web suite now 502/502.

## 6. Positive findings
No fake charts or synthetic metric generators (`Math.random()` only for IDs and WebGL particles). All dashboard values from real API queries. `react-query` supplies loading/empty/error states uniformly. CSP and Tauri command registration narrowly scoped. `useTheme.ts` and all `AppShell` listeners clean up correctly.

## 7. Priority
Fix D4/D5 (lifecycle leaks), reconcile D2 (single validated event contract) + D1, correct the Copilot story (D7–D10), then D21 (consolidate NANI state).
