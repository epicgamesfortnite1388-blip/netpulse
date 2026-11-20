# UI_REVIEW_05 — Frontend Performance Audit

**Read-only.** Measured = read from source/byte counts. Plausible = code-path evidence, not runtime-measured. No fabricated numbers (no Lighthouse/trace/gzip available).

---

## 0. Measured baseline

| Chunk | Bytes |
|---|---|
| `LiveMapPage` | 1,265,832 |
| `index` (entry) | 574,723 |
| `three.module` | 558,222 |
| `LatencyChart` (recharts) | 350,448 |
| `VpnPage` | 155,219 |
| `index.css` | 110,666 |
| `NaniPage` | 54,053 |
| All JS | **3,354,242** |

`React.memo` appears **0 times** in `apps/web/src`; `LatencyChart` has 0 `useMemo`/`useCallback`. `chunkSizeWarningLimit` = 900 kB; the map chunk is 1.4× over.

## 1. Subscription / listener defects (highest value)

- **F1 — `subscribeTest` leaks a WebSocket on unmount mid-handshake — MEASURED · HIGH · fix BEFORE.** `lib/ws.ts`: `cancelled` is checked after `await initTransport()` but **not** after `await api.post('/ws/ticket')`; teardown closes `ws` which is still `null`. An authenticated socket stays open forever. Rapid navigation accumulates them until the sidecar's socket cap.
- **F2 — `ServersPage.RecommendationCard` re-subscribes the WS on every render — MEASURED · HIGH · fix BEFORE.** The message handler is an inline arrow → new identity each render → `useWsTestProgress`'s effect (dep `onMessage`) tears down/reconnects per progress frame → **one ticket POST + connect + close per frame**, losing frames.
- **F3 — `useNaniEvents` leaves a 5 s poll running after unmount — MEASURED · MEDIUM-HIGH · fix BEFORE (desktop).** Cleanup empties `timersRef` but `attach()` continues after `await poll()` and pushes a new interval that is never cleared.
- **F4 — one socket + one ticket per subscription — MEASURED · MEDIUM · design fix AFTER.** No multiplexing; `useVpnSelfTest` (Health + Dashboard `NeedsAttentionCard`) and `ScheduleChip` each open their own.

**Cleanup verified correct:** `AppShell` scroll/keydown, `CommandPalette`, `QuickConnectOverlay`, `externalNavigation`, `useTheme` matchMedia, `GlobeCanvas` observers + `dispose()`, `AetherCore` visibility/contextloss, `UpdateHistoryCard`/`UpdateBanner`, `syncEngine`, `useStartupHealth`, `NodeDetailPage`, `ServersPage` health poll, `useBackgroundTest`. **Not** cleared: `LiveMapPage` sweep poll (only on completion/error).

## 2. Polling fan-out

- **F5 — Dashboard runs ~13 interval pollers at once — MEASURED · MEDIUM.** `/network/status` 5 s, `/events` 8 s, `/history` speed/dns 30 s each, `/vpn/status` 6 s, `/events?level=warn|error` (limit 100 each) 30 s each, `/vpn/selftest` 60 s, Iran 30 s, `/map/local`+`/map/observations` 20 s each, `/settings` 30 s, `/meta/health` 30 s (3 s reconnecting), `runtime_status` IPC 10 s. Every `/network/status` response re-renders the landing page and the recharts latency chart every 5 s; `NeedsAttentionCard` parses 2×100 rows every 30 s.
- **F6 — shell re-renders 1×/s while reconnecting — MEASURED · LOW-MEDIUM.** `AppShell` consumes all of `useStartupHealth`; the 1 s countdown re-renders `SidebarContent` (~30 `NavLink`s) + header. Outlet subtree does not re-render. `runtime_status` invoked twice per phase change.

## 3. Re-render / memoization

- **F7 — Globe zoom drives a full page re-render + cluster rebuild per camera frame — MEASURED · HIGH on `/map` · fix BEFORE.** `globe.gl` calls `onZoom` inside OrbitControls `'change'`; `LiveMapPage` forwards it to `setGlobeZoom`; `nodes` is memoized on `globeZoom` and runs `clusterNodes` over up to 1500 pins → new `pointsData` → layer rebuild inside the moving frame.
- **F8 — `pointsMerge={false}` with up to 1500 pins; 95 hex land polygons — MEASURED · MEDIUM-HIGH · fix BEFORE.**
- **F9 — no `React.memo`; `LatencyChart` rebuilds `points` + inline style/label/formatter per render — MEASURED · MEDIUM · cheap fix BEFORE.**
- **F10 — `ServersPage` renders N recharts instances, rebuilt every 12–15 s poll — MEASURED · MEDIUM-HIGH at scale · BEFORE.** 20 servers → 20 `ResponsiveContainer`s + 20 `ResizeObserver`s reconciling every 12 s.
- **F11 — memo dependency bug: live latency graph never updates — MEASURED (correctness) · LOW for perf · fix BEFORE.** `historySamples` memoized on `[selectedTargetId, timeWindow]` but reads `historyRef.current` (replaced array) → chart freezes until target/window changes.
- **F12/F13 — context providers and `Gauge` verified clean.**

## 4. Expensive graphics / continuous loops

- **F14 — globe animates 60 fps even when idle — MEASURED · MEDIUM · AFTER (design decision).** `autoRotate` + damping keep WebGL rendering while `/map` is visible (only `prefers-reduced-motion` stops it).
- **F15 — `AetherCore` rAF loop always running on the VPN page — MEASURED · MEDIUM · AFTER.** Correctly stopped on hidden/unmount; DPR capped; but renders every frame on the default VPN surface.
- **F16 — `backdrop-filter` stacked over the animating canvas — MEASURED · MEDIUM.** `.surface-glass` = `blur(16px)` (used on the new Dashboard hero), shell sidebar/header blur, and **four blurred overlays inside the WebGL container** on `/map`; every canvas frame forces a re-blur. Cheap fix: drop blur where the background is already 85 % opaque.

## 5. Large lists without virtualization — MEASURED · MEDIUM · AFTER

`EventsPage` (200 rows, 5 s refetch, `timeAgo` per row per render), `HistoryPage` (200 rows, 15 s, `summarize` per row not memoized), `LiveMapPage` connections table (unbounded OS socket count, 10 s), target/sweep tables re-filtered inline per render. `NodeExplorerPage` bounded at 50/page (fine).

## 6. Synchronous main-thread work

- **F17 — search fires a request + a storage write per keystroke — MEASURED · MEDIUM · cheap fix BEFORE.** `NodeExplorerPage` `setSearch` is `usePersistentState` (synchronous `JSON.stringify`+`sessionStorage.setItem`) and part of the query key → new query per keystroke, no debounce.
- **F18 — NANI workspace parses localStorage twice on mount, rewrites per message — MEASURED · MEDIUM · AFTER.** Two `JSON.parse` of up to 50×200 messages; `persist()` re-stringifies everything per send/receive.
- **F19 — positive: `CardBody` unmounts folded content**, so charts/pollers in folded cards stop. **Preserve this** — it is why VpnPage's ~11 pollers are tolerable.

## 7. Bundle

- **F20 — recharts on the landing route; map route 1.82 MB — MEASURED · HIGH for first paint · fix BEFORE.** `LatencyChart` (350 kB) is statically imported by `DashboardPage` (index route). Fix: lazy-mount the chart behind `latencyHistory.length>1`, lazy-mount `GlobeCanvas` behind `IntersectionObserver`, or replace the 150 px sparkline with hand-rolled SVG to drop recharts from the critical path.

## 8. Plausible (not runtime-measured)

P1 `SidebarContent` `measure()` always `setPill` with a new object (bounded). P2 `ServersPage` health effect depends on `servers` array → interval recreated each refetch. P3 `useNodeActions` returns a fresh object each render → `selectPickedLocation` identity churn. P4 `filteredOutCountRef` read during render can lag one frame. P5 variable fonts ≈312 kB; only latin subset should load (confirm in trace).

## 9. Fix ordering

**BEFORE redesign (cheap, no visual change):** F1 (one guard), F2 (`useCallback`), F3 (post-await guard), F7 (quantize zoom / move clustering into `GlobeCanvas`), F8 (`pointsMerge`+cap), F9/F10 (`memo`+memoized chart data), F11 (pair with F9), F16 (drop opaque-overlay blur), F17 (debounce), F20 (lazy chart), F5 (throttle dashboard pollers ≥10 s interim).
**AFTER redesign (architecture):** F4 multiplexed socket, F5 push-based status, F6 shell render isolation, F14/F15 idle animation, F18 NANI persistence, keep F19 fold-unmount.

**Not measured (no fabrication):** no runtime profile, Lighthouse, gzip sizes, frame timings, or memory snapshots. Impact statements derive from control flow, prop identity, and byte counts.
