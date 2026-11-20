# FINAL_UI_PERFORMANCE_REPORT — measured vs. claimed

**Reviewer:** Kim · **Date:** 2026-11-20 · **Policy followed:** measure where possible; otherwise state the source and label it as inspection or prior evidence.

## 1. Measurements executed this mission

| Metric | Result | Method / command | Caveat |
|---|---|---|---|
| Web unit suite (baseline) | **102.40 s**, 54 files, 506 tests, 2 failures | `npm run test -w @netpulse/web` at 07:44 | Cold run; environment creation 91% of tracked time (jsdom created 54×) |
| Web unit suite (post-Will) | **31.72 s**, 54 files, 506 tests, 0 failures | `npm run test -w @netpulse/web` at 07:59 | Warm cache; **not** a code-perf improvement — do not claim one |
| Frontend typecheck | 103 s / 37 s (two runs) | `npm run typecheck -w @netpulse/web` | Failed both times (F-04) |
| Frontend production build | 19 s, failed before Vite | `npm run build -w @netpulse/web` | `tsc --noEmit` gate fails; no bundle produced |
| Full Rust suite | **60.52 s**, 550 passed / 2 failed / 2 ignored | `cargo test --manifest-path src-tauri/Cargo.toml` | Includes 8.81 s failed perf assertion |
| Isolated N1.1 oracle | 6.51 s, failed on 6 s terminal-state timeout | `cargo test … n1_bayesian_engine_drives_the_real_analysis -- --nocapture` | Different failure mode from full run |
| N1 perf smoke assertion | **8.8075112 s** for 80 probes across 20 APIs | `n1_analysis_latency_smoke` failure output | Exceeds test bound; see F-15 |

## 2. Prior evidence (not re-measured by Kim; explicitly labelled)

`reports/N1_2_06_PERFORMANCE_RESULTS.md` (executed in the N1.2 mission, commits `c7fe33b`/`d46ece9`):
- 100-thread barrier-synchronized admission cycle ≈ 10–30 ms (≈100–300 µs/decision).
- Max concurrent investigations 4 across 4 stress runs.
- Investigation analysis 80 probes × 4 layers / 20 APIs in **2.47 s**, probe-dominated.
- Bounded replay 256, history 50, active 4, correlation window 32.

`reports/N1_2_REVIEW_09_PERFORMANCE_AUDIT.md` independently reviewed those claims.

**Comparison:** the current working tree produced **8.81 s** for the same 80-probe smoke, versus 2.47 s in N1.2 — a ~3.6× difference. This is **not** attributed to the UI redesign: the run was concurrent with web/typecheck/Rust suites, with an active second agent editing files and a WebView2 process pool. Root cause is undemonstrated (F-15). No performance regression claim is made in either direction.

## 3. Static review of new performance-sensitive code

| Area | Finding |
|---|---|
| `useNaniEvents` | Polls every 5 s with incremental `since` cursor; bounded buffers. **Leak on unmount** (F-07) is a correctness defect that also retains a timer and its closures indefinitely. |
| `useConnection` | Two queries; tunnel refetch 1.5 s during transitions, 5 s otherwise. No polling on disconnected state noted. Reasonable. |
| `ConnectionHero`/`ConnectionDial` | SVG dial with three arcs, no per-frame animation in the new components. No expensive render work found. |
| Navigation pill (`AppShell.tsx`) | `useLayoutEffect` + `ResizeObserver`; listener cleanup present per review stream FE. No leak found. |
| Rust event bus | Bounded replay 256 but unbounded internal mpsc; one event per API per health check (F-13) — a plausible unbounded-memory path under repeated checks. |
| Rust persistence | Per-probe writes with errors suppressed (`let _ =`), so failure is silent rather than costly (F-13). |
| Bayesian engine | No new allocation in the observed diff; `observe_recording_confirmation` adds one likelihood pass per probe (O(hypotheses)) but only on the manual health-check path. |

## 4. Strict judgments

- **No claim of improved performance.** The 102 s → 32 s web-suite change is cache warmth.
- **No claim of no regression.** The 2.47 s → 8.81 s engine-smoke difference is unexplained and the gate is failing (F-15).
- **No benchmark was run on the redesigned UI in a browser** because the dev server was blocked (see `FINAL_UI_VISUAL_VERIFICATION.md`).
- **No optimization was applied**; none is recommended before F-04/F-15 are resolved.

## 5. Verdict

**PARTIAL.** Static review found no obvious new hot loop or unbounded UI structure, but the one executed engine latency gate fails and the root cause is unproven. Performance is **not** certified.
