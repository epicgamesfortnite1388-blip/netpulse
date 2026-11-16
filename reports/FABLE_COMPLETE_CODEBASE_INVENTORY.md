# FABLE — Complete Codebase Inventory

Date: 2026-11-16 (evening). Baseline: working tree of `E:\Code\Project\Vpn_app` at HEAD `b0311fb` **plus 36 modified files with +2,656/−493 lines of uncommitted in-flight work** (NANI diagnosis/validation expansion, copilot rework, engine-manager UI). All measurements below include that in-flight state.

## 1. Top-level structure

| Path | Role | Size (source LOC) | State |
|---|---|---|---|
| `src-tauri/` | Tauri v2 Rust shell + NANI Rust engine | 26,474 (`src/`) + 678 (`tests/`) | Builds clean; 529/531 tests pass (2 ignored) |
| `src-tauri/backend/` | **Bundled** Node sidecar: `netpulse-backend.js` (157,289 lines, esbuild output), bundled `node.exe`, 13 drizzle SQLite migrations | fresh build of `apps/api` (0 source files newer than bundle) | Current |
| `apps/api/` | Fastify + better-sqlite3 backend (source of truth for the sidecar) | 270 TS files, 115 test files, 1,264 tests | All green |
| `apps/web/` | React 19 + Vite + react-router frontend, 27 routed pages | 41,373 LOC, 50 test files (502 tests) | All green; builds in ~10.5 s |
| `packages/shared/` | Pure TS core (incl. `src/nani` — 2,419 LOC NANI core), types | 11,908 LOC, 212 tests | All green |
| `cloud/worker/` | Cloudflare Worker + D1 (`netpulse-cloud`), 13 TS files | 22,869 LOC incl. tests | Deployed per git history |
| `scripts/` | e2e, benchmarks, release, verification harnesses | ~16,330 LOC (mjs/ts/ps1) | Mixed; many artifact-producing |
| `cores/` | Installed proxy cores drop-in (`xray.exe` present, 34.5 MB) | binary | Runtime artifact |
| `aether/` | Aether engine install dir (exe + 2 toml + run logs) | binary | Runtime artifact |
| Root | 40+ markdown reports (ARCHITECTURE, NANI_* phase reports, FEATURE_GAPS, CONNECTION_BENCHMARKS…) | — | Mix of accurate and stale |

## 2. Rust crate (`src-tauri`)

- Single crate, no workspace fragmentation. Deps: `tauri 2` (tray-icon), single-instance/dialog/process/updater plugins, serde, url, rand 0.8, sha2, reqwest (rustls).
- Release profile: `codegen-units=1, lto, opt-level="s", panic=abort, strip` — deliberate small-binary posture.
- Modules (top level): `sidecar` (Node supervision), `elevation` (UAC broker), `dpapi` (DPAPI secret bridge), `logging`, `paths`, `ports`, `safe_mode`, `status`, `tray`, `window`, `webview_gc`, `navigation`, `diagnostics`, `os_open`, `updater_feed`, `commands/{mod,nani}`.
- `network_intelligence/` (NANI Rust, 19,315 LOC, 34 modules, 364 `#[test]`): `foundation` (NaniMathEngine — composition root), `bayesian`, `math`, `robust_stats`, `probability` (Beta/Gamma/Normal samplers + Wilson), `diagnosis` (12-hypothesis engine + EIG), `information_theory`, `sequential` (VOI/early-stop), `bandit`, `causal` (ATE from controlled interventions), `changepoint` (BOCPD/CUSUM/Page-Hinkley), `hierarchical`, `learning`, `episodes`, `drift`, `evaluation` (Brier/ECE), `timeseries`, `graph`, `route`, `recovery`, `recovery_memory`, `api_model`, `api_intelligence/{registry,monitor,failure_classifier,monitor_loop}`, `context`, `config_intelligence`, `validation`, `investigation`, `persistence`, `events`, `evidence`, `hardware`, `simulation` (deterministic 15-condition simulator), `ai` (local llama.cpp layer, opt-in).

## 3. Node backend (`apps/api/src`)

- Entry: `index.ts` (server/web mode) and `desktop-index.ts` (sidecar mode; bundled to `src-tauri/backend/netpulse-backend.js` by `tsup` via `tsup.desktop.config.ts`).
- 34 route files under `routes/`, **all 34 registered** in `app.ts` (no orphan routes).
- ~70 services under `services/`: VPN stack (`vpn/vpnService.ts` 1,697 L, `vpn/aetherProvider.ts` 976 L, `engineManager.ts` 739 L, `proxyTunnel.ts` 1,057 L, `proxyCores.ts`, `tunClaim.ts`, `killSwitch.ts`, `vpnWatchdog.ts`, `elevationBroker.ts`, `keychain.ts`), NANI (`naniService.ts`, `naniProbeAdapter.ts`, `naniDiagnosticAdapter.ts`, `naniShadowHealthLoop.ts`), diagnostics/DNS/speed/map/iran/nodes/optimizer/mission/adaptive/ai-agent.
- DB: better-sqlite3 + drizzle (`src-tauri/backend/drizzle/0000–0013`), ~13 migrations.
- Realtime: `realtime/wsRoute` + `RealtimeBus` with typed `nani:*`, `vpn-*`, `stability:*` topics.

## 4. Frontend (`apps/web/src`)

- `app/router.tsx`: 27 lazy-loaded pages + NotFound. Shell boots small entry chunk (14 KB shell + 574 KB vendor entry measured).
- `features/`: dashboard, map, diagnostics, speed-test, dns, gaming, iran, ip, routes, cloudflare, nodes (explorer/detail/sources), servers, vpn, optimizer, history, events, account, engines, settings, health, mission (MissionControl + Overdrive), copilot, nani.
- `lib/`: transport (Tauri-vs-HTTP dual), ws, updater, elevation broker, quick connect, startup health.
- Dead surface found: `features/nani-reports/nani-reports-page.tsx` is **not routed and not imported anywhere**.

## 5. Cloud worker (`cloud/worker`)

- D1-only (no R2), migrations `0001–0005`, admin plan of record, ops pages, AI copilot proxy to the Abystral worker (`ABYSTRAL_AI_BASE_URL`, 503 without it — no fake responses), password reset flow, session crypto.

## 6. Sibling repositories (verified to exist)

| Repo | Content | Notes |
|---|---|---|
| `E:\Code\Project\Abystral` | Workers + SPA builders, 24,259 LOC of TS/JS in workers+scripts | Subscription/entitlement side |
| `E:\Code\Project\Abystral-ledger` | 92,284 LOC | Ledger/accounting |
| `E:\Code\Project\abystral-agent` | 13,239 LOC, wrangler + schema.sql + vitest | Agent service |
| `E:\Code\Project\Bot\Abystral` | Python (alembic, aiogram-style), ~5,919 LOC of src | **`pytest tests` fails at collection: error in `tests/test_resilience.py`** (verified by run; deeper inspection not authorized) |

## 7. Test & verification inventory (executed this session)

| Suite | Command | Result |
|---|---|---|
| API | `cd apps/api && npx vitest run` | 115 files, **1,264 passed** (360 s — slow) |
| Web | `cd apps/web && npx vitest run` | 54 files, **502 passed** |
| Shared | `cd packages/shared && npx vitest run` | 14 files, **212 passed** |
| Rust | `cd src-tauri && cargo test` | **529 passed, 0 failed, 2 ignored** |
| Web build | `npm run build -w @netpulse/web` | OK, 10.55 s |
| Rust check | `cargo check` | Clean errors; ~55 dead-code warnings (see corruption audit) |
| Bot/Abystral | `python -m pytest tests` | **Collection error in `tests/test_resilience.py`** |

## 8. Repository hygiene artifacts (committed garbage found)

- `aether-1793627158001.zip` (+4 more, 9–47 bytes) — contain the literal text `Not Found`: failed download stubs committed to the repo.
- `.tmp-desktop-dev.log` (144 KB), `.scratch-*` dirs, `dist-desktop/`, `.staging-dist/`, `apps/api/dist/` with many stale `aetherProvider-*.js` chunk variants, `tmp/` — mixed committed/ignored build residue.
- `src-tauri/backend/node.exe` — committed/bundled Node runtime (necessary for shipping, but present in the source tree).
- `evidence/leak-live-20261112/` — field evidence dir; check policy (data may be user-sensitive).

## 9. Roadmap/claims documents present

Root: `ARCHITECTURE.md`, `DESKTOP.md`, `VPN.md`, `NETWORKING.md`, `FEATURE_AUDIT.md`, `FEATURE_GAPS.md`, `SMART_CONNECT_DESIGN.md`, `AETHER_ARCHITECTURE.md`, `ADAPTIVE_AI_REPORT.md`, `NANI_*` (23 files), `NETPULSE_FINAL_GRADE.md`, `NETPULSE_NEW_ACCEPTANCE_MATRIX.md`, `API.md`. Plus `reports/` with 25 subdirectories of mission/phase/accounting artifacts. These are inputs to §12 of the mission (Previous Work Review), not evidence.
