# UI_REVIEW_10 — Final Readiness Report

**Reviewer:** independent Principal Code Reviewer / Frontend Architecture Auditor. **Read-only mission.**
**Baseline:** HEAD `005de03`, branch `main`, web 54 files / 502 tests green, typecheck clean, build clean. **Note:** the brief's `cc1ee99` is two UI commits stale — the repo has moved (see UI_REVIEW_00).

---

## Answers to the ten required questions

### 1. Is the frontend ready for a full redesign?
**Conditionally yes.** The visual/structural layer is ready: a mature token-based design system (themes, motion, type scale, a11y guards), lazy routes, and a coherent shared component layer. But the **truth layer is not ready**: the VPN status payload cannot express "verified" after connect (R-C1/R-C2/R-H1), the proxy tunnel is `active` before its own verification (R-H2), and the frontend renders stale status on error (R-H3) and fails to clear the tunnel on disconnect (R-H4). A redesign that visually promises "connected = proven" would be dishonest until those are fixed. **Proceed with the redesign; gate the connection-truth surfaces on the backend remediation task.**

### 2. Which areas can be redesigned immediately (safely)?
Dashboard, Diagnostics, Speed test, DNS, Gaming, Iran, IP, Routes, Cloudflare, History, Events, Servers, Optimizer, Nodes Sources, Mission, Overdrive, Copilot, Account (presentation), Settings (presentation), Engines — following the shared-component migration rules in UI_REVIEW_07.

### 3. Which areas require additional caution?
**VPN** (connection truth + many pollers), **NANI** (uncertainty display must not fabricate certainty; event ordering), **System Health** (self-test replay, busy state), **Account/auth** (DPAPI, token storage), **Map** (WebGL perf, zoom re-render), and any screen touching `Card`/`Disclosure`/`HeadingLevel`.

### 4. Which existing features are most likely to be accidentally broken?
1. VPN status truth (verified/failed/unverified collapse).
2. NANI hypothesis confidence / unknown states.
3. Node & server actions and their exact toast wording (`nodeActionPolicy`).
4. Disclosure/fold persistence keys (`np.disclosure:<scope>:<id>`).
5. Theme/type-scale contrast in light mode.
6. WS-driven test progress (`test:progress|done|error` frame contract).

### 5. Five highest-risk **frontend** defects
1. **R-H3** — stale `SystemBar` shows "Tunnel up" while status is unreadable.
2. **R-H4** — Disconnect doesn't invalidate `['tunnel',*]`; stale "active" + old exit IP.
3. **R-H5** — `ws.ts` leaks an authenticated socket on mid-handshake unmount.
4. **R-H6** — `ServersPage` reconnects the WS every progress frame.
5. **R-H8** — map zoom triggers a full page re-render + 1500-pin cluster rebuild per frame.
*(Backend CRITICAL/HIGH: R-C1, R-C2, R-H1, R-H2 — separate remediation task.)*

### 6. Five highest-impact performance improvements
1. Lazy-mount the dashboard chart and `GlobeCanvas` (drops 350 kB + 1.8 MB from first paint) — R-M13.
2. Fix the WS leaks/storm (`ws.ts` guard, `ServersPage` `useCallback`) — R-H5/R-H6.
3. Quantize/rAF-throttle map zoom + cluster inside `GlobeCanvas` — R-H8.
4. `memo` charts + memoized data; SVG sparkline for server rows — R-M12/R-M9.
5. Multiplex one socket / throttle the ~13 dashboard pollers — R-M14.

### 7. Backend contracts that must remain unchanged
`VpnStatus` (incl. `verification`, `verifiedPublicIp`, `verificationNote`), `ProxyTunnelStatus`, `/nodes` query contract (16 params), `/settings` (SettingsPatchSchema), NANI DTOs + event envelope `{seq,event:{kind,payload}}`, `/ws/ticket` + `test:progress|done|error` frames, and the server-enforced entitlement/provisioning flow.

### 8. Tests that must pass after every implementation stage
All **54 files / 502 tests** (assert the exact count — see the worker-drop risk), the CSS-contract guards (`tokenRefs`, `typeScale`, `cardStagger`), the DOM-shape tests (`vpnDecisionCards`, `nodeHealthDisplay`), plus the **10 new tests** in UI_REVIEW_08; and typecheck + production build.

### 9. What must be visually verified in the running desktop app
Dashboard hero; each VPN surface in **connected / verified / failed / unverified / unknown**; NANI hypotheses + uncertainty; node & server lists at scale; disclosure/fold persistence across navigation; **light and dark** contrast; type-scale `large`/`xl`; responsive mobile drawer; command palette; degraded/recovery banners; no overflow/clipping/misalignment at 1024/1440/430 px.

### 10. What the UI Expert should do first
1. **Prep commit (cheap, no visual change):** `ws.ts` cancellation guard, `ServersPage` `useCallback`, `useNaniEvents` post-await guard, disconnect/reconnect invalidation of `['tunnel',*]`, debounce node search, lazy dashboard chart. These de-risk the redesign without touching visuals.
2. **File the backend verification remediation** (R-C1/C2/H1/H2) — the redesign's honesty depends on it; do not modify backend in the redesign.
3. **Then** redesign the shell + Dashboard (already begun), then pages in ascending risk order.

---

## Readiness score — **71 / 100** (transparent methodology)

| Dimension | Weight | Score | Basis |
|---|---:|---:|---|
| Architecture & maintainability | 15 | 12 | clear separation, lazy routes, mature shared layer; but some pages bypass react-query, dead code, dual tab systems |
| Test safety net | 15 | 11 | 502 green tests, strong service/logic coverage; but 16 routes zero coverage, hooks untested, collection nondeterministic |
| Functional preservation clarity | 15 | 13 | inventory + contracts documented; some silent-failure paths remain |
| **Connection-state truth** | 20 | **8** | 2 backend CRITICAL + 2 HIGH block honest status; 2 frontend HIGH (stale/disconnect) |
| Performance readiness | 15 | 10 | measured defects (WS leaks, map zoom, bundle) but all fixable |
| Security & reliability | 10 | 8 | strong invariants; DPAPI oracle, no zod at seam, plaintext web tokens |
| Design-system maturity | 10 | 9 | tokens/motion/themes/a11y guards are production-grade |
| **Total** | **100** | **71** | |

**Not inflated:** the score is dragged down by the connection-truth dimension (8/20), which is the single most important promise of a network product and the one the redesign most risks faking. The visual layer alone would score ~85; the truth layer is what holds the total at 71.

**Confirmed vs unverified:** all findings above are verified from source (file + symbol). Runtime behaviour (actual VPN connect, live WebGL frame cost) was not exercised; those are flagged as inference where relevant (UI_REVIEW_04 F5, UI_REVIEW_05 P1–P5).

---

## Bottom line for the transformation

The transformation is **safe to begin** and the visual system is strong. The one non-negotiable is that the redesign must **not visually upgrade the connection status into something the backend cannot prove**. Fix the five cheap frontend defects first, file the backend verification remediation, and gate every stage on the full test count + visual inspection in the running app. With those conditions, the UI Expert can deliver a genuinely better product rather than a prettier one that lies about connectivity.
