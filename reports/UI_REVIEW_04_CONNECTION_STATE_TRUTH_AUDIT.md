# UI_REVIEW_04 — Connection State Truth Audit

**Read-only.** Traces `UI action → api → route → vpnService → engine → verification → status → UI`. No VPN was started. **Frontend bugs are fixable by the UI Expert; BACKEND bugs are reported for a separate remediation task and must NOT be modified during the redesign.**

---

## 0. How "connected" actually reaches the UI (verified)

There is **no VPN state WebSocket**. `lib/ws.ts` is a generic test-progress subscriber; the backend publishes kill-switch transitions on topic `vpn`, but **no component subscribes to `vpn`**. Connection state is 100% polled:
- `GET /vpn/status` every 4 s (`useVpnData`), also 6 s in `ConnectionCard` (same query key).
- `GET /vpn/tunnel/status` every 5 s (1.5 s while starting/stopping/down).
- Two independent sources of truth — **engine status** (`VpnStatus`) and **proxy tunnel status** (`ProxyTunnelStatus`) — are never reconciled.

Consumers of `connected`: `VpnPage.SystemBar`, `VpnPage` rail/disconnect, `ConnectionCard`, `OverviewSurface`, `ProviderSurface.providerIsActive`, `AetherSurface`.

---

## 1. Can a process/engine start show "connected" without traffic verification? — **YES (backend)**

### F1 — CRITICAL (BACKEND) — verification is discarded after the connect response
`vpnService.ts` `verifyConnect` + every provider `status()` (`WireguardProvider`, `OpenVpnProvider`, `SingboxProvider`, `aetherProvider`).
`verifyConnect` returns a new object with `verification`/`verifiedPublicIp`, but callers return it **only from `connect()`**. No provider stores it. Every `status()` hardcodes `verification:'not_verified'`, `verificationNote:null`. Since the UI polls `status()` 4 s later, **the verification is visible for one render, then replaced by `not_verified`.**
Impact: "Tunnel up, but not routing" (`ProviderSurface`) disappears after the first poll; `VpnPage`'s routing segment is unreachable; `AetherSurface` shows "verified" then "unverified" forever; `ConnectionCard`'s verified badge can never appear after the first poll. **Blocks redesign: YES** — a "connected means proven" design cannot be built on a payload that is always `not_verified`.

### F2 — CRITICAL (BACKEND) — elevated WireGuard path never verifies
`routes/vpn.ts` `runElevatedWireGuardConnect`: after the elevation broker, it accepts `provider.status().connected` (i.e. a `netpulse-wg-*` interface appeared). No public-IP probe, no `verifyConnect`. This is the **primary Windows desktop path** (`ProviderSurface` always arms the elevation bridge for WireGuard). **Blocks redesign: YES.**

### F3 — HIGH (BACKEND) — OpenVPN "connected" is a 3 s survival heuristic
`OpenVpnProvider.connect`: `setTimeout(3000)`; success = `child.exitCode==null && !child.killed`; `status()` = `child!=null && connectedAt!=null`. A daemonised OpenVPN that hasn't completed TLS/auth can satisfy this. **Blocks redesign: YES.**

### F4 — HIGH (BACKEND) — proxy tunnel publishes `active` before the exit-IP trace
`proxyTunnel.start()` sets `state:'active'` **before** `fetchThroughPort(EXIT_TRACE_URL)` runs; on failure it corrects to `down`. The UI polls at 1.5 s while `starting`, so it reliably observes `active` first → `VpnPage` renders tone `ok` + "Proxy tunnel active", `ProxyTunnelCard` prints "Exit IP: unverified". False-active window up to ~12 s. **Blocks redesign: YES.**

## 2. Can stale state overwrite newer state? — **No event overwrite; yes cache races (frontend)**

### F5 — HIGH (FRONTEND) — error path renders stale status as current
`VpnPage` error banner + `useVpnData`. The banner claims "surfaces below show nothing rather than stale state", but react-query retains `data` on a failed background refetch, and `SystemBar` renders unconditionally from `statusQuery.data`. After a sidecar restart/timeout the bar keeps saying "Tunnel up via …" (tone `ok`) **while** the error banner says status could not be read. `ConnectionCard` has no error branch at all. **Blocks redesign: YES** — any new status surface inherits this unless a staleness policy (`dataUpdatedAt`) is added.

### F6 — MEDIUM (FRONTEND) — self-test WS replay can overwrite a newer result
`useVpnSelfTest` + `realtime/bus.ts` (replays last cached message per topic). Both `NeedsAttentionCard` and `SystemHealthPage` mount the hook, so a remount receives the cached `vpn-selftest:done` and unconditionally `setQueryData(...)`, replacing a newer GET result. This is the exact "stale event overwrites newer state" pattern.

### F7 — MEDIUM (FRONTEND) — verify result shadows the refetched plan
`SmartConnectCard`: `const shown = plan ?? planQuery.data`; `plan` is set once and never cleared, so the 60 s refetch is permanently ignored.

### F8 — LOW (FRONTEND) — WS never reconnects (`ws.ts` no `onclose`)

## 3. Does disconnect clear the correct state? — **Not fully (frontend)**

### F9 — HIGH (FRONTEND) — disconnect doesn't invalidate the tunnel cache
`VpnPage`/`ProviderSurface`/`AetherSurface` disconnect `onSuccess: qc.invalidateQueries({queryKey:['vpn']})` — covers `['vpn',*]` but **not** `['tunnel','status']`/`['tunnel','gateways']`/`['vpn','history']`. Backend stops the tunnel, but the UI keeps rendering `tunnel.state==='active'` + old `exitIp` for up to 5 s after Disconnect. This is the "disconnect leaves stale connected UI" failure.

### F10 — MEDIUM (FRONTEND) — no Disconnect when only the proxy tunnel is up
`VpnPage`: `connected || killSwitch?.blocking ? <Disconnect/> : null`. When `status.connected===false` but `tunnel.state==='active'`, the only global stop control is absent.

### F11 — MEDIUM (FRONTEND) — health metrics survive across sessions
`useVpnHealth` keyed `['vpn','health']`, disabled when inactive, so cached `data` persists; `StatTile` prefers `healthQuery.data.rxBytes` over `status.rxBytes` → previous session's counters show until the new 5 s fetch. Backend clearing is correct.

### F12 — LOW (BACKEND) — throwing provider disconnect skips tunnel stop (`routes/vpn.ts`)

## 4. Can reconnection produce contradictory status? — **Yes**

### F13 — MEDIUM (FRONTEND) — reconnect invalidates only `['vpn']`
`/vpn/reconnect` stops the tunnel first (backend consistent), but the frontend refetches `VpnStatus` and leaves `['tunnel','status']` stale → for ≤5 s `SystemBar` renders **both** "Tunnel up via wireguard" and "Proxy tunnel active / old exit IP"; `OverviewSurface` prefers `status`, so bar and overview can name different owners.

### F14 — MEDIUM (BACKEND) — two engines can be connected at once; `/vpn/status` shows one
`routes/vpn.ts` `statuses.find(s=>s.connected)`; `/vpn/connect` never disconnects an existing provider (only `/reconnect` does). UI normally prevents it, but that guard derives from the same polled status F5 can make stale.

## 5. Are UNKNOWN / unverified states representable? — **In the type: yes. In the UI: effectively no**

`VpnVerification` has `not_verified|verified|failed|unavailable|skipped` and `verificationNote`. But:
- `SystemBar` uses `connected===true` alone → tone `ok`; only `verification==='failed'` adds a Routing segment.
- `ConnectionCard` shows a badge only when `verified`; unverified and failed look "fine".
- `OverviewSurface` admits "exit not verified" only as secondary text.
- `AetherSurface.VerificationBadge` renders all five states — but per F1 it says "unverified" forever while the connect toast said "verified".
- `skipped` is declared but never produced.
**Blocks redesign: YES** — the redesign's core promise ("we tell you what is proven") needs F1/F2/F3/F4 fixed first.

## 6. Do loading states match real operations? — **Mostly yes; two false negatives**

Honest: `DiscoveryCard` (indeterminate until real `discovery:progress`), `AetherSurface.running`, `ProviderSurface` button `loading=mutation.isPending`, `useStartupHealth` phase from a real probe.
### F15 — MEDIUM (FRONTEND) — SystemBar asserts "No tunnel is up" before the first response
`status` is `undefined` during the first fetch → bar renders "No tunnel is up / nothing carrying traffic" with no `isPending` branch. `ConnectionCard` does it correctly ("checking…").
### F16 — LOW — failed quick-connect reads as neutral ("Agent run finished").
### F17 — LOW — duplicate `['vpn','status']` query definitions (4 s vs 6 s) can drift.
### F18 — LOW (BACKEND, UX) — `WireguardProvider.status()` runs `wg show all dump` + up to 3 ICMP pings (≤4.5 s) per call, so a 4 s poll can lag reality by >1 interval; no focus refetch.

---

## Summary

| # | Class | Sev | Blocks redesign |
|---|---|---|---|
| F1 verifyConnect discarded | BACKEND | CRITICAL | Yes |
| F2 elevated WG unverified | BACKEND | CRITICAL | Yes |
| F3 OpenVPN heuristic | BACKEND | HIGH | Yes |
| F4 tunnel active-before-trace | BACKEND | HIGH | Yes |
| F5 stale status on error | FRONTEND | HIGH | Yes |
| F9 disconnect doesn't clear tunnel | FRONTEND | HIGH | Yes |
| F13 reconnect contradicts | FRONTEND | MEDIUM | Yes |
| F14 dual-connect one-status | BACKEND | MEDIUM | Yes |
| F6 self-test replay | FRONTEND | MEDIUM | No |
| F7 smart-connect stale plan | FRONTEND | MEDIUM | No |
| F10 no tunnel-only disconnect | FRONTEND | MEDIUM | No |
| F11 stale health counters | FRONTEND | MEDIUM | No |
| F15 false "no tunnel" on load | FRONTEND | MEDIUM | No |
| F12/F16/F17/F18/F8 | mixed | LOW | No |

**Bottom line:** the frontend is structurally sound (single status query, no optimistic writes, honest progress) but displays a payload that **cannot express "verified" after connect** (F1/F2/F3) and a tunnel that is `active` before its own verification (F4). A redesign promising "connected = proven" is **blocked until those backend defects are fixed in a separate remediation task**; the frontend-side prerequisites are F5, F9, F13, F15.
