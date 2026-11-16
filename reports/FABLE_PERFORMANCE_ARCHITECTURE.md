# FABLE — Performance Architecture

Separates measured facts (this session) from theoretical concerns. Rule applied: no optimization without a measured reason.

## 1. Measured this session

| Item | Measurement | Assessment |
|---|---|---|
| Web production build | 10.55 s | Fine |
| Entry chunk (`index-*.js`) | 574 KB / 181 KB gzip | Acceptable for a desktop webview; already mitigated by lazy routes (router.tsx documents the earlier 3.1 MB single-chunk problem and its fix) |
| `LiveMapPage` chunk | **1,265 KB / 377 KB gzip** (three.js globe) | Only loads when map opens; still the heaviest page. Split three.js into a manualChunk or dynamic-import the globe. LOW priority (desktop, local assets) |
| `LatencyChart` chunk | 350 KB / 104 KB gzip | Chart library; candidate for manualChunk sharing across pages |
| `VpnPage` chunk | 155 KB / 44 KB gzip | Fine |
| API vitest suite | **360 s** for 1,264 tests (isolate:115 workers, ~277 ms each) | Biggest measured cost in the repo. Vitest itself reports ~31.6 s savings from `isolate:false`; larger gains from unit/integration split. |
| Web vitest suite | 90.35 s jsdom creation (54 files, 58% of tracked time) | `pool: 'vmThreads'` per Vitest's own advice |
| Rust test suite | 1.90 s for 529 tests | Excellent — no action |
| Rust release profile | lto + opt-level=s + panic=abort + strip | Good for size; math core must stay panic-free (tests cover it) |
| Sidecar bundle | 157,289-line single file | Parse cost on boot is one-time; measured boot path exists (health wait). No runtime concern; packaging freshness is the actual risk (see A-5). |

## 2. Runtime hot paths (traced, not benchmarked — flagged as "measure before touching")

1. **`MonitorLoop` (Rust) + `NaniShadowHealthLoop` (Node) both polling** in desktop mode — the dual-NANI defect (C-05/A-1) is *also* the top runtime-cost defect: duplicated probes, timers, and event traffic. Fixing A-1 is the performance fix.
2. `installedEngineVersions()` spawns one process per installed core per 30 s TTL — correctly cached; only poll surfaces that need it.
3. `engineManager` caches releases 10 min — correct given GitHub's 60 req/h budget. Do not "optimize" by removing the cache.
4. Stability sampling (`stabilityService`) publishes one event per tick — bounded; prune is probabilistic (1/50). Fine.
5. NANI persistence is JSON files — fine at current scale; revisit only if episode counts reach 10⁵.

## 3. Memory

- Rust: bounded buffers everywhere found (startup stderr buffer, event replay 256, activity buffer 200). No unbounded growth pattern found.
- Node: temp dirs cleaned in `finally` (engine installs); reconnect bound 3; test records retained by `retention.sweep()`.

## 4. UI

- React 19 + lazy routes + `page-enter` keyed remount per route (documented rationale in AppShell) — no rerender-storm pattern found in the audited paths; React Query used for status polling with query keys per page.

## 5. Priority list (measured → proposed → expected → risk)

| # | Item | Expected | Correctness risk |
|---|---|---|---|
| P1 | Desktop gate for Node NANI loops (A-1) | ~halves background probing CPU/network | none (verified UI routes to Rust in desktop) |
| P2 | Test suite split (`isolate:false` unit pool / keep isolation for integration) | API suite −90 s or more; web −90 s jsdom | low — keep isolation for DB/e2e tests |
| P3 | three.js manualChunk + dynamic globe import | map-open memory/CPU smoothing | low |
| P4 | Chart chunk sharing | one-time parse cost ↓ | low |
| P5 | Packaging fingerprint freshness check | prevents stale-bundle field bugs | none |

## 6. Not worth doing (recorded to prevent future effort)

- Rewriting the sidecar bundle as many files (no measured runtime gain; single-file is a deliberate ship shape).
- Switching SQLite to another store (no measured bottleneck).
- Further Rust micro-opts (1.9 s test suite, lto already on).
- Any optimization of the 30 s version cache (correctly sized).
