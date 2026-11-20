# UI_MASTER_11 — FRONTEND PERFORMANCE

## 1. Measured baseline

Production build (`vite build`, Vite 6 / Rollup), measured on the workstation used
for this pass:

| Metric | Value |
|---|---|
| Build time | **12.3s** |
| Total `dist/` | **3.8 MB** (includes fonts and sourcemaps) |
| CSS bundle | **123.71 kB → 23.07 kB gzip** |
| Entry chunk (`index`) | **569 kB → 183.9 kB gzip** |
| Route chunks | 26, all lazy |
| Largest route chunk | `LiveMapPage` 1,236 kB → 377.6 kB gzip |
| Second largest | `LatencyChart` 342 kB → 104.2 kB gzip |
| Third | `three.module` 545 kB → 142.0 kB gzip |
| Test suite | 54 files / 506 tests in **17.9s** |

---

## 2. Code splitting

All 26 routes are `React.lazy`:

```tsx
const DashboardPage = lazy(() => import('@/features/dashboard/DashboardPage'));
const LiveMapPage   = lazy(() => import('@/features/map/LiveMapPage'));
// … 24 more
```

### 2.1 Route chunk sizes (representative)

| Route | Size | Gzip |
|---|---|---|
| Dashboard | 27 kB | 8.7 kB |
| Settings | 26 kB | 8.5 kB |
| NaniPage | 53 kB | 15.2 kB |
| DnsPage | 20 kB | 6.4 kB |
| NodeDetailPage | 23 kB | 8.3 kB |
| IranConnectivityPage | 26 kB | 7.0 kB |
| VpnPage | 151 kB | 44.4 kB |
| LatencyChart | 342 kB | 104.2 kB |
| LiveMapPage | 1,236 kB | 377.6 kB |

A first visit to the Dashboard transfers the entry chunk plus one 27 kB route
chunk. The 1.2 MB map bundle is never paid for unless the user opens the map.

### 2.2 Icon-level splitting

Lucide icons are emitted as individual 0.15–0.5 kB chunks (`shield-check`,
`trash-2`, `network`, `sparkles`, …). This is Rollup's tree-shaking of the icon
package combined with the lazy route boundaries — an icon used on one route is
not in the entry chunk.

### 2.3 Shared chunk

`three.module` (545 kB / 142 kB gzip) is split out because two routes need it
(the map and the Aether VPN surface). Rollup hoisted it into a shared chunk so it
is fetched once, not twice, and only when one of those two routes loads.

---

## 3. CSS budget

The entire design system — 1,021 lines of tokens plus 682 lines of identity —
compiles to **123.71 kB / 23.07 kB gzip**. That is the whole product's styling,
because:

- Tailwind v4 emits only the utilities actually used.
- There is no CSS-in-JS runtime.
- `@source not '../../test'` excludes the test directory, so test files that
  quote broken class names (`text-[var(--text-muted)]`) cannot inject dead rules
  into the production stylesheet. This is documented in `tokens.css` because it
  actually happened once.

---

## 4. Polling discipline

45 `refetchInterval` declarations across the app. Every one is either bounded or
conditional:

| Interval | Used by | Rationale |
|---|---|---|
| 4–5s | Dashboard status, diagnostics, events, Cloudflare | Live-ish state the user is watching |
| 6–8s | Connection card, tunnel status | Connection state |
| 10–15s | Live map, history | Slower-moving aggregates |
| 20–30s | Needs-attention, Iran widget, learning | Background signals |
| `false` | Quick Connect overlay (closed), map connections (hidden) | **Not polled at all when invisible** |

### 4.1 Adaptive tunnel polling

```ts
refetchInterval: (q) => {
  const s = q.state.data?.tunnel.state;
  return s === 'starting' || s === 'stopping' || s === 'down' ? 1_500 : 5_000;
}
```

A tunnel in a transition state polls at 1.5s; a settled tunnel polls at 5s. The
expensive interval is used only while something is actually changing.

### 4.2 Visibility gating

The Quick Connect overlay polls at 5s **only while open** (`open ? 5_000 : false`),
and the map polls connections at 10s only when the connections layer is shown. A
closed overlay costs zero requests.

---

## 5. Render cost

| Mechanism | Effect |
|---|---|
| `stagger` runs on creation only | A 5s poll updates values in place; it never replays a 280ms card animation |
| `page-enter` keyed on `pathname` | Re-runs only on navigation, not on data change |
| `TabPanel` has no entry animation | Switching tabs does not re-animate content under `page-enter` |
| `useMemo` on derived collections | `toRows`, `deriveEvidence`, `seen` event sets memoised on the event array |
| `DisclosureScope` folds secondary content | Dense pages mount far fewer nodes in the default state |
| `font-variant-numeric: tabular-nums` | Numeric columns do not reflow when a digit changes width |

### 5.1 Why the motion rules are a performance rule

`animation-fill-mode: backwards` instead of `both` is documented as a correctness
fix (containing-block for fixed descendants), but it is also a performance one: a
retained transform on a page-sized element forces the compositor to keep a layer
alive for the lifetime of the page. `backwards` hands the element back to its
ordinary styles as soon as the animation ends.

---

## 6. Font loading

Two variable fonts, subset per script:

| Family | Latin | Latin-ext | Cyrillic | Greek | Vietnamese |
|---|---|---|---|---|---|
| Inter Variable | 48.26 kB | 85.07 kB | 18.75 / 25.96 kB | 19.00 / 11.23 kB | 10.25 kB |
| JetBrains Mono Variable | 40.40 kB | 15.20 kB | 12.11 kB | 9.00 kB | 7.50 kB |

Variable fonts (one file per weight axis instead of one file per weight) mean the
product ships 4 files instead of ~12 for the same weight coverage. Subsetting per
script means an English user downloads 88.7 kB of font, not 340 kB.

Fonts are `woff2` only. No `ttf`, no `eot`, no base64 inlining.

---

## 7. Known large chunks and the plan

| Chunk | Size | Status |
|---|---|---|
| `LiveMapPage` | 1,236 kB / 377.6 kB gzip | Accepted. It is a WebGL map with vector tiles and is only fetched on `/map`. Splitting it further would mean splitting the map library from its own renderer, which produces a waterfall instead of a saving. |
| `index` | 569 kB / 183.9 kB gzip | Accepted. React 19 + Router + TanStack Query + the shell. |
| `three.module` | 545 kB / 142.0 kB gzip | Accepted. Already a shared chunk; only loaded by two routes. |

The Vite warning (`chunks larger than 900 kB`) is expected and is not suppressed.
Suppressing it would hide the next chunk that grows past the line.

### 7.1 What would actually help, and is not done

| Opportunity | Saving | Not done because |
|---|---|---|
| `manualChunks` for React + Router + Query | Better caching across deploys, no size change | Would need a vendor-chunk policy the team has not agreed |
| Replace `three` with a lighter renderer on the Aether surface | ~140 kB gzip on `/vpn` | Would change a shipped visual effect |
| Dynamic-import `LatencyChart` inside the Dashboard | Moves 104 kB off the Dashboard's critical path | The chart is above the fold on that page |

These are recorded rather than silently applied because each changes a user-facing
behaviour or an architectural decision beyond the UI layer.

---

## 8. Test and build performance

| Operation | Time |
|---|---|
| `tsc --noEmit` | ~14s |
| `vitest run` (54 files, 506 tests) | **17.9s** |
| `vite build` | **12.3s** |
| ESLint (whole `apps/web/src`) | ~11s |

Vitest reports 80% of tracked time in jsdom environment creation (54 separate
environments). The suggested remedy — `pool: 'vmThreads'` or `isolate: false` —
is a test-infrastructure change with a real isolation trade-off, so it is noted
rather than applied.

---

## 9. Fixed performance-relevant defects

| # | Defect | Effect of fix |
|---|---|---|
| F-1 | `AiCore` used `animate-ping` (infinite) | Removed a permanently-running compositor animation on the NANI page |
| F-2 | `TabPanel` re-animated under `page-enter` | Removed a double animation on every tab switch |
| F-3 | `surface-glass` invoked `backdrop-filter` that `identity.css` then cancelled | Removed a no-op `backdrop-filter`, which is one of the most expensive properties to composite |
| F-4 | Topbar used `color-mix(... transparent)` | Opaque background removes per-frame blending during scroll |
| F-5 | Card entrance ran on every refetch | `stagger` is creation-only; polling no longer triggers 280ms of animation per card every 5s |

F-3 and F-4 are the two that matter most: `backdrop-filter` and translucent
scrolling surfaces are the classic causes of scroll jank in a dark-themed desktop
UI, and both were present in the shell before this pass.

---

## 10. Acceptance criteria

| Criterion | State |
|---|---|
| Every route is code-split | Pass — 26/26 |
| No route chunk loaded before navigation | Pass |
| First paint does not include the map or 3D bundle | Pass |
| CSS is a single static file, no runtime | Pass — 23.07 kB gzip |
| No infinite animation on an idle screen | Pass |
| Polling stops when the surface is hidden | Pass — 2 conditional intervals |
| Transition-state polling is faster than steady-state | Pass — 1.5s vs 5s |
| Card animation does not replay on refetch | Pass |
| Fonts are variable and subset | Pass — 88.7 kB for Latin |
| Build warning not suppressed | Pass |

---

## APPENDIX — Evidence correction (recovery mission, 2026-11-20)

Original text preserved above. Corrections:

- "682 lines of identity" → `apps/web/src/styles/identity.css` is **691 lines** (`tokens.css` is 1,021).
- Build time "12.3s" was a warm-cache measurement in the original authoring environment; in this recovery environment `vite build --outDir <fresh>` measured **11.36s** and `tsc --noEmit` passed. Neither figure is a controlled benchmark.
- The summary line "509/509 web tests pass" was accurate only after three new guard tests landed; the verified earlier count was 506/506. Current count after recovery regression tests: **520/520** (see FINAL_UI_RECOVERY_09_REGRESSION_TESTS.md).
