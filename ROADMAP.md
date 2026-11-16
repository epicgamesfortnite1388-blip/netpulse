# ROADMAP — NetPulse master execution plan (FABLE)

Source of truth: `reports/FABLE_MASTER_ROADMAP.md` (identical content, roadmap-oriented view). Baseline: working tree 2026-11-16. **Gate: FABLE-BUILD-001 (commit in-flight work) precedes everything.**

## Wave 0 — Stabilize baseline (parallelizable: no file overlap)

| ID | Objective | Files | Depends | Acceptance | Verify command | P | Cx | Status |
|---|---|---|---|---|---|---|---|---|
| W0-1 | Commit/branch the in-flight work | 36 modified files | — | working tree committed on a review branch or merged | `git status --short` empty | P0 | trivial | OPEN |
| W0-2 | Delete dead UI + repo junk | `apps/web/src/features/nani-reports/`, `aether-*.zip`, `.tmp-desktop-dev.log`, `.scratch-*`, stale `dist-desktop/`, `.staging-dist/`, stale `apps/api/dist/` chunks | W0-1 | all deleted; tests still green | `npm run test --workspaces --if-present` | P0 | trivial | OPEN |
| W0-3 | Desktop gate for Node NANI loops | `apps/api/src/app.ts` (1 line + test) | W0-1 | no Node NANI timers when `NETPULSE_DESKTOP=1` | new integration test + `cd apps/api && npx vitest run` | P0 | trivial | OPEN |
| W0-4 | D1 migration numbering check | `cloud/worker/migrations/` | — | adjudicated duplicate `0005` (renumber if needed) | `wrangler d1 migrations list netpulse-cloud` | P1 | trivial | OPEN |
| W0-5 | Packaging freshness gate | `scripts/desktop-package.mjs` | W0-1 | packaging fails when a source file is newer than the bundle | touch source → run packaging → expect failure | P1 | small | OPEN |

## Wave 1 — Wire the real intelligence loop

| ID | Objective | Files | Depends | Acceptance | Verify | P | Cx | Status |
|---|---|---|---|---|---|---|---|---|
| W1-1 | Adaptive stopping wired into investigation lifecycle | `src-tauri/src/network_intelligence/investigation.rs`, `sequential.rs` | W0-3 | observe loop uses `select_best_probe` + `should_stop` behind `NANI_ADAPTIVE_STOPPING=1`; simulator shows fewer mean probes-to-diagnosis than fixed plan | `cargo test network_intelligence::` + new simulator test | P0 | medium | OPEN |
| W1-2 | Delete shelf Rust exports | `hierarchical.rs`, `probability.rs`, `timeseries.rs` dead symbols per compiler list | W1-1 | zero dead-code warnings in `network_intelligence` | `cargo check 2>&1 | grep -c never` → 0 | P1 | small | OPEN |
| W1-3 | Proper likelihood noise model | `bayesian.rs` | W1-1 | confidence → mixture likelihood; property tests | `cargo test` | P1 | small | OPEN |
| W1-4 | Continuous calibration | `evaluation.rs`, `commands/nani.rs`, `persistence.rs` | W1-1 | rolling Brier/ECE persisted and exposed; UI shows scores-not-probabilities until ECE<0.10 | `cargo test` + manual command check | P1 | medium | OPEN |
| W1-5 | Classifier consolidation | `failure_classifier.rs`, `failureIntelligence.ts`, `naniDiagnosticAdapter.ts`, `packages/shared` taxonomy | W0-3 | single taxonomy data source; TS is display mapping | golden test set green | P2 | medium | OPEN |

## Wave 2 — Transparency, persistence, ecosystem

| ID | Objective | Files | Depends | Acceptance | Verify | P | Cx | Status |
|---|---|---|---|---|---|---|---|---|
| W2-1 | Engine update pin UX | `EngineManagerPage.tsx`, `engineManager.ts` | W0-2 | "new release unpinned" state visible and explained | component test | P1 | small | OPEN |
| W2-2 | Force version cache after install | `engineManager.ts` install path | W2-1 | post-install versions immediate | unit test | P2 | trivial | OPEN |
| W2-3 | SQLite corruption quarantine | `apps/api/src/db/*` | W0-1 | corrupt DB quarantined + honest `blocked` state, no crash | fault-injection test | P2 | medium | OPEN |
| W2-4 | Node runtime pin + CVE policy | `RELEASING.md`, `scripts/desktop-package.mjs` | — | documented pin + release checklist item | review | P1 | trivial | OPEN |
| W2-5 | Evidence dir sensitivity review | `evidence/` | — | redacted/ignored as needed | manual | P2 | trivial | OPEN |
| W2-6 | Fix Bot/Abystral pytest collection | Bot repo `tests/test_resilience.py` | — | pytest passes | `pytest tests` | P2 | small | OPEN |

## Wave 3 — Performance and ergonomics (measured-only)

| ID | Objective | Files | Depends | Acceptance | Verify | P | Cx | Status |
|---|---|---|---|---|---|---|---|---|
| W3-1 | Test-suite split (isolate:false unit pool) | `apps/api/vitest.config.*`, `apps/web/vitest.config.*` | W0-2 | API suite < 120 s, web jsdom time < 20 s, all green | `npx vitest run` timing | P2 | small | OPEN |
| W3-2 | three.js manualChunk + dynamic globe | `apps/web/vite.config.ts`, `LiveMapPage` | W0-2 | map chunk < 600 KB with three.js split; no regression | `npm run build -w @netpulse/web` sizes | P3 | small | OPEN |
| W3-3 | Chart chunk sharing | vite config | W0-2 | `LatencyChart` shared chunk across pages | build sizes | P3 | trivial | OPEN |

## Wave 4 — Field validation (no new code until data exists)

| ID | Objective | Depends | Acceptance | P |
|---|---|---|---|---|
| W4-1 | Run ≥100 real desktop investigations; record ECE/Brier; verify adaptive stopping reduces probes in field | W1-1..W1-4 | calibration report artifact in `reports/accounting/` | P1 |
| W4-2 | Learning/drift field validation before any new math | W4-1 | drift/learning usage report | P2 |

## Dependency graph

```
W0-1 ── W0-2 ────────────── W3-1/W3-2/W3-3
  ├──── W0-3 ── W1-1 ── W1-2/W1-3/W1-4 ── W4-1 ── W4-2
  │             └────── W1-5
  ├──── W0-5, W2-3
  └──── W2-1 ── W2-2
W4 (independent), W2-6 (independent)
```

## Removed from the roadmap permanently

- Rewriting the sidecar bundle as multi-file.
- Introducing R2 or any new paid infra.
- New VPN protocols/engines without implementation evidence.
- Any neural component in NANI diagnosis.
- Re-deriving "grades" documents (superseded by FABLE findings registry).
