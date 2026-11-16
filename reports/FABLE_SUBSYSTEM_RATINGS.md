# FABLE — Subsystem Ratings (repo split into parts)

Method: every part was either (a) read end-to-end at key files, (b) covered by live test/build runs, or (c) compiler/CI-checked. Ratings are 1–10 on five axes; the overall is a weighted mean (correctness ×2, security ×1.5, tests ×1.5, architecture ×1.5, hygiene ×0.5 → normalized). "Rate" is the overall per part. Evidence anchors are file:line or executed commands. Date: 2026-11-16.

---

## PART 1 — Rust shell core (`src-tauri/src` minus `network_intelligence`)
~7.2k LOC: `main.rs`, `sidecar.rs` (807), `elevation.rs` (700), `dpapi.rs`, `updater_feed.rs`, `paths.rs` (435), `logging.rs` (596), `window.rs`, `tray.rs`, `safe_mode.rs`, `status.rs` (416), `diagnostics.rs`, `os_open.rs` (425+918 tests), `navigation.rs`, `ports.rs`, `webview_gc.rs`.

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 9.5 | Sidecar restart budget + cooldown + re-arm unit-tested; exit-code table (78 = handshake); updater file-lock race fixed deterministically (`FILE_FREE_TIMEOUT` with honest failure) |
| Security | 9.5 | Single elevation path w/ SHA-256 descriptor integrity; DPAPI bridge with honest scope statement; no generic shell/fs IPC (main.rs header + invoke_handler verified) |
| Tests | 9.0 | All listed modules have targeted unit tests in the 529 green |
| Architecture | 9.5 | "WHAT vs HOW" split documented and followed; single path resolver (`paths.rs`) |
| Hygiene | 9.0 | Doc comments explain *why* on every non-obvious decision |

**Rate: 9.4/10 (A)** — Exemplary. Do not touch except by escalation rule.

## PART 2 — NANI Rust math core (`network_intelligence` math half)
`math.rs` (469), `bayesian.rs` (435), `probability.rs` (658), `robust_stats.rs` (409), `diagnosis.rs` (1,350), `causal.rs`, `changepoint.rs`, `hierarchical.rs`, `timeseries.rs`, `evaluation.rs`, `validation.rs`.

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 9.0 | Log-space everywhere; -inf/NaN semantics exact; `expected_information_gain` has a cloning reference implementation as test oracle; softmax-underflow adversarial fix landed (`b0311fb`) |
| Security | 9.5 | Pure functions, no I/O, no secrets |
| Tests | 9.5 | 364 tests incl. adversarial numerics; all green (1.9 s) |
| Architecture | 7.5 | Dead sequential layer (VOI/`should_stop`) + shelf modules (compiler-verified) inflate the surface |
| Hygiene | 8.0 | Assumptions documented; confidence-heuristic not yet documented as heuristic |

**Rate: 8.7/10 (A−)** — Correct and tested; prune the shelf (T-03), wire the sequential layer (T-02).

## PART 3 — NANI Rust engine: engine half
`foundation.rs` (1,407), `investigation.rs` (967), `api_intelligence/*` (registry 415 + monitor + monitor_loop + failure_classifier), `learning.rs` (754), `episodes.rs`, `drift.rs`, `recovery.rs` (493), `recovery_memory.rs`, `bandit.rs`, `events/` (632), `evidence/`, `context/` (528), `persistence.rs`, `config_intelligence.rs` (505).

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 8.5 | Real probes (`TcpStream::connect_timeout`, `to_socket_addrs`), per-layer classification so 401 ≠ outage; cooperative cancellation; verified-only learning |
| Security | 9.0 | No secrets in events/persisted records (header contract, verified) |
| Tests | 9.0 | Lifecycle, events, cancellation covered in the green suite |
| Architecture | 7.0 | Observe loop not IG-driven (FABLE-RUST-001); dual persistence + dual engines in desktop (FABLE-ARCH-001/PERSIST-001) |
| Hygiene | 8.5 | |

**Rate: 8.2/10 (A−)** — The integration of the math into the loop is the weak seam, not the math.

## PART 4 — apps/api VPN stack
`vpn/vpnService.ts` (1,700), `vpn/aetherProvider.ts` (976), `services/proxyCores.ts` (1,346), `proxyTunnel.ts` (1,057), `engineManager.ts` (739), `tunClaim.ts` (340), `killSwitch.ts`, `vpnWatchdog.ts` (145), `elevationBroker.ts` (249), `keychain.ts` (362), `networkOwnership.ts`.

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 9.5 | `active` only after exit-IP proof; nested-mode dual-hop verification; port-clash retry-once with documented dead-code fix; multi-core batching refuses hysteria honestly (`startCore`/`startMultiCore` read) |
| Security | 9.5 | Pinned digests + sidecar digests + host allowlist + size/time caps + `version` self-check; kill-switch pre-arm→arm crash-safe ordering |
| Tests | 9.0 | Substantial share of the 1,264 green; engine pipeline branches tested offline via pure functions (`verifyPinnedDigest`) |
| Architecture | 8.5 | Two VPN stacks (profile vs node) with union status — works but doubles surface (V-01) |
| Hygiene | 9.0 | |

**Rate: 9.3/10 (A)** — Best part of the repo. The property "process launch ≠ connected" is enforced structurally.

## PART 5 — apps/api NANI/adaptive services
`naniService.ts` (668+329 in-flight), `naniShadowHealthLoop.ts`, `naniProbeAdapter.ts` (172), `naniDiagnosticAdapter.ts` (243), `adaptiveEngine.ts`, `adaptiveManifestTrust.ts`, `ai-agent/`, plus TS NANI core in `packages/shared/src/nani` (2,419).

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 8.0 | TS core is a faithful dynamic Bayesian filter (transition kernel verified in both languages — no lost feature, pure subset) |
| Security | 8.5 | Probe adapter is the only socket owner; sanitized errors |
| Tests | 8.5 | nani* tests green; shadow loop tested |
| Architecture | 5.0 | **Duplication is rooted here** (FABLE-ARCH-001/002): second engine + second classifier maintained for a mode that also runs the Rust engine |
| Hygiene | 8.0 | |

**Rate: 6.8/10 (C+)** — Well-built redundant machinery; its own quality can't offset the structural duplication. Action: T-01/T-06.

## PART 6 — apps/api measurement services
`dnsService.ts`, `dnsResolverCatalog.ts`, `dnsRecommendation.ts`, `speedService.ts` + `providers/speed/cloudflare.ts`, `pingService.ts`, `stabilityService.ts`, `iranService.ts`, `iranClassifier.ts`, `nodeScoring.ts`, `nodeTestProbes.ts`, `nodeTestScheduler.ts`, `nodeDiscovery.ts`, `nodeGeoService.ts`, `geoGuard.ts`, `mapService.ts`, `ipInfoService.ts`, `endpointService.ts`, `endpointScrub.ts`, `whitednsService.ts`, `optimizerService.ts`, `routeService.ts`, `gamingService.ts`, `smartConnect.ts`, `autoConnect.ts`, `selectionService.ts`, `healthMonitor.ts` (~45 files).

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 8.5 | Spot-reads: no fake latency ("measured only when traffic provably traversed", nodeTestProbes:255), cert failures reported not faked (iranService:488), real-bytes speed, honest anycast scrub (`scrubAnycastGeo`) |
| Security | 8.5 | Endpoint scrubbing, geo guard, private-address guards referenced in engineManager |
| Tests | 8.5 | Covered in the green suite (adaptive, dns, speed, iran, nodes tests present) |
| Architecture | 7.5 | ~45 services is sprawl; several Tier-2 (gaming/optimizer/adaptive) ride along without production validation data |
| Hygiene | 8.0 | |

**Rate: 8.2/10 (A−)** — Honest measurement layer; breadth dilutes review bandwidth (A-4 critique).

## PART 7 — apps/api infrastructure
`app.ts` (975), `index.ts`/`desktop-index.ts`, `db/` + drizzle migrations, `realtime/bus.ts` (76) + `wsRoute.ts` (106), `plugins/errorHandler.ts`, `auth.ts`, `util/`, `config.ts`, `logger.ts`.

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 8.5 | Boot ordering documented; retention sweep; crash-safe quit disconnect (`app.ts:946`) |
| Security | 8.5 | helmet + cors (documented method allowlist) + global rate-limit 600/min + per-route tighter; desktop-mode auth disable; error envelope |
| Tests | 8.0 | Integration-heavy suite green |
| Architecture | 8.0 | Clean plugin wiring; deduction: unconditional `naniShadowHealth.start()` (the ARCH-001 root lives here) |
| Hygiene | 8.5 | |

**Rate: 8.4/10 (A−)** — One-line fix (T-01) buys a full point.

## PART 8 — packages/shared
`models/` (23 files), `nani/` (11), `net/stats.ts`, `adaptive/`, `geo/`, `score/`, `schemas/`, `cloud/`.

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 8.5 | Pure functions with explicit model documentation (diagnosis.ts header states the full filter model); `stats.ts` percentile interpolation correct |
| Security | 9.0 | No I/O by design |
| Tests | 8.5 | 212 tests green incl. `nani.simulation.test.ts` |
| Architecture | 7.0 | NANI math duplicated here vs Rust — should become data (taxonomy) + types only |
| Hygiene | 8.5 | |

**Rate: 8.3/10 (A−)** — As contracts/models: excellent. As a second NANI brain: retire the overlap.

## PART 9 — apps/web shell & lib
`app/` (router, AppShell, theme, type-scale), `lib/` (transport 185, ws 102, updater 322, api 172, elevationBroker, quickConnect, startupHealth, usePersistentState, failureIntelligence…).

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 9.0 | Lazy-route boot documented and measured; event reducer with dedupe/gap/late-join tested |
| Security | 9.0 | Capability detection (not mock branches); no credentials in logs; openExternal allowlist pattern |
| Tests | 8.5 | 502 green |
| Architecture | 9.0 | Pages present backend state; transport duality clean |
| Hygiene | 8.5 | |

**Rate: 8.9/10 (A)**

## PART 10 — apps/web features (27 pages)
vpn (7,080 LOC), map (2,600), nani (1,997), dashboard (1,104), iran (925), dns (794), + 21 more.

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 8.5 | Verified/unverified distinction surfaced (`VpnPage.tsx:115-117`); NaniPage 1,316 L with recovery controls |
| Security | 8.5 | |
| Tests | 7.5 | UI logic tested (54 files) but page-level coverage varies |
| Architecture | 7.5 | VPN feature is 26 files/7k LOC — sprawl; dead `nani-reports`; map chunk 1.27 MB |
| Hygiene | 7.5 | |

**Rate: 7.9/10 (B+)** — Good; needs pruning and chunk work, not redesign.

## PART 11 — cloud/worker
`index.ts` (1,415), `netpulse-integration.ts` (589), `ops-page.ts` (537), `auth.ts` (274), `crypto.ts`, `np-auth.ts`, `netpulse-sessions.ts`, `vpn-users.ts`, `vpn-config.ts`, `mail.ts`, `api.ts`, `ops-*`; migrations 0001–0005; D1 only.

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 9.0 | Bounded body → CORS → route; session-derived user_id on every user query (isolation rule stated and centralized); reset atomic migration |
| Security | 9.0 | Secrets via `wrangler secret put`; rate limits (reg: 5/h per IP); admin plan isolated (`adminAudit` to admin_events); AI proxy 503-when-unconfigured |
| Tests | 7.0 | Worker has tests but I did not run them this session (outside the workspace suites); no live D1 verification performed |
| Architecture | 9.0 | D1-only per infra preference; per-env EXPECTED_ORIGIN discipline |
| Hygiene | 7.5 | Duplicate `0005` migration numbering unresolved (FABLE-INFRA-001) |

**Rate: 8.5/10 (A−)** — Rate limited by unadjudicated migration numbering + unrun worker tests.

## PART 12 — scripts/ (58 files, ~16.3k LOC)
e2e (desktop/telegram/recovery/navigation), benchmarks (engine-start, bulk-probe, adaptive), field (iran ps1), release/sign/feed, audits (ipc/layout/contrast/webview/tabs), probes (free-config-*).

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 8.5 | Artifact-anchored outputs; CONNECTION_BENCHMARKS discipline traced back to `reports/accounting/` |
| Security | 8.0 | Sign/verify scripts present (`signature-trust.test.mjs`); no secrets in scripts observed |
| Tests | 8.0 | Test-scripts tested (`*.test.mjs` pattern) |
| Architecture | 7.0 | Sprawl; some one-off mission scripts accumulate; packaging freshness not enforced (T-08) |
| Hygiene | 6.5 | `__pycache__` committed |

**Rate: 7.8/10 (B+)**

## PART 13 — src-tauri/backend bundle + packaging pipeline
`netpulse-backend.js` (157,289-line esbuild bundle), bundled `node.exe`, drizzle migrations 0000–0013, `prepare-desktop.mjs`, `desktop-package.mjs`, `verify-desktop-pipeline.mjs`, `sign-release.mjs`.

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 8.5 | Bundle fresh (0 newer sources verified); verify pipeline exists |
| Security | 8.0 | Bundle is fingerprintable; no integrity manifest on the shipped bundle itself observed (S-02 related: no Node pin/CVE policy) |
| Tests | 7.5 | `desktop:verify` exists; freshness not automated (T-08) |
| Architecture | 8.0 | Single-file ship shape is a deliberate, defensible tradeoff |
| Hygiene | 7.0 | Stale dist variants committed alongside |

**Rate: 7.8/10 (B+)**

## PART 14 — Test infrastructure & CI
`vitest` suites (api 115 files, web 54, shared 14), `cargo test` (531), e2e harnesses, `.github/workflows/ci.yml` (all gates automated on Windows runners + real-webview navigation job via tauri-driver), `reconciler-verifiers.yml`, `audit-ci.sh` local gate.

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 9.0 | CI comment documents exactly why each gate exists and why audit:ci stays local (D1 defect history) |
| Security | 8.5 | |
| Tests | 9.5 | 2,507 tests green across stacks this session; CI runs them on the shipping platform |
| Architecture | 8.0 | Windows runner justified in-file; deduction: suite speed (360 s/90 s jsdom) |
| Hygiene | 8.5 | |

**Rate: 8.8/10 (A)**

## PART 15 — Documentation & prior reports (root .md + reports/ tree, ~65 docs)
ARCHITECTURE/VPN/DESKTOP/NETWORKING/API/SECURITY/RELEASING + 23 NANI_* + FEATURE_GAPS + grades + reports/* (25 subdirs).

| Axis | Rate | Evidence |
|---|---|---|
| Correctness | 7.0 | Spot-checked claims reproduced (test counts); stale grades (NETPULSE_FINAL_GRADE) predate current discoveries |
| Security | 8.0 | SECURITY.md reviewed claims held up |
| Tests | n/a | — |
| Architecture | 6.5 | No supersession index; report accumulation without curation |
| Hygiene | 6.0 | |

**Rate: 6.8/10 (C+)** — Rich but uncured; needs INDEX.md + staleness marks (T-10).

## PART 16 — Repository hygiene (whole-tree)
Committed: `aether-*.zip` stubs (9–47 B, "Not Found"), `.tmp-desktop-dev.log` (144 KB), `.scratch-*`, `dist-desktop/`, `.staging-dist/`, stale `apps/api/dist` chunks, `tmp/`, `__pycache__`, `evidence/leak-live-20261112/` (sensitivity unreviewed), CRLF churn.

| Axis | Rate | Overall |
|---|---|---|
| All | 5.0 | **Rate: 5.0/10 (C)** — the only weak part; trivially fixable (T-10) |

## PART 17 — Sibling repositories (ecosystem)

| Repo | Verified | Rate | Notes |
|---|---|---|---|
| `Abystral` (workers+SPA, 24k LOC) | structure only | 7.5/B+ | Build/check script discipline visible (`check-*.mjs` battery); not deep-audited this session |
| `Abystral-ledger` (92k LOC) | existence only | n/a | Not investigated — flag for a dedicated pass |
| `abystral-agent` (13k LOC) | structure only | 7.0/B | wrangler + schema.sql + vitest present |
| `Bot/Abystral` (5.9k LOC py) | pytest executed | **3.5/D** | **Test suite broken at collection** (`tests/test_resilience.py`) — the only verifiably broken artifact in the ecosystem (FABLE-ECO-001) |

---

# Scoreboard

| # | Part | Rate | Grade |
|---|---|---|---|
| 1 | Rust shell core | 9.4 | A |
| 4 | VPN stack (api) | 9.3 | A |
| 14 | Test infra & CI | 8.8 | A |
| 9 | Web shell & lib | 8.9 | A |
| 2 | NANI math core | 8.7 | A− |
| 11 | Cloud worker | 8.5 | A− |
| 7 | API infrastructure | 8.4 | A− |
| 8 | packages/shared | 8.3 | A− |
| 3 | NANI engine half | 8.2 | A− |
| 6 | Measurement services | 8.2 | A− |
| 10 | Web features | 7.9 | B+ |
| 12 | scripts/ | 7.8 | B+ |
| 13 | Bundle & packaging | 7.8 | B+ |
| 5 | NANI/adaptive TS services | 6.8 | C+ |
| 15 | Docs & reports | 6.8 | C+ |
| 16 | Repo hygiene | 5.0 | C |
| 17 | Ecosystem (Bot) | 3.5 | D |

**Weighted overall: 8.4/10 (A−).**

## Interpretation

- **Strengths concentrate where correctness matters most**: the Rust shell, the VPN lifecycle, and the test/CI system are the three best-rated parts — the parts that protect the user.
- **Weaknesses concentrate where ambition outran pruning**: the duplicated NANI services (6.8), uncured documentation (6.8), and hygiene (5.0). All three are cheap to fix relative to their weight (T-01, T-10, T-11).
- **The ecosystem is the only red flag**: Bot/Abystral's broken test suite means the Telegram integration currently has no working regression gate.
- New verification this pass: the TS NANI transition kernel is **not** a lost feature — Rust `diagnosis.rs` implements a time-scaled `TransitionModel` too. The TS core is a faithful subset; consolidation loses nothing.
