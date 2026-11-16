# ULTIMATE BASELINE AND PRESERVATION REPORT

**Audit date:** 2026-11-16 · **Repository:** `E:/Code/Project/Vpn_app` · **Branch:** `main` · **HEAD at audit start:** `b0311fb` ("Fix softmax underflow that fails adversarial_softmax_extreme_log_probs")

This report records the state of the repository *before* any repair work, so that the user's existing work can be preserved and every change can be attributed. It separates **verified facts** (directly observed), **analysis** (inferences), and **assumptions**.

---

## 1. Verified git state (audit start)

| Property | Value |
|---|---|
| Branch | `main` |
| HEAD commit | `b0311fb` |
| Submodules | none configured |
| Tracked files | 908 |
| Modified tracked files (`M`) | 37 |
| Staged files | 0 |
| Untracked files/dirs (`??`) | 142 |
| Commits made during this audit | none (no approval process assumed) |

### Modified tracked files (all 37 — PRESERVED, not reverted)

`apps/api/package.json`, `apps/api/src/app.ts`, `apps/api/src/routes/nani.ts`, `apps/api/src/services/naniProbeAdapter.ts`, `apps/api/src/services/naniService.ts`, `apps/web/package.json`, `apps/web/src/app/AppShell.tsx`, `apps/web/src/app/router.tsx`, `apps/web/src/features/copilot/CopilotPage.tsx`, `apps/web/src/features/copilot/aiApi.ts`, `apps/web/src/features/engines/EngineManagerPage.tsx`, `apps/web/src/features/vpn/AdaptiveRecoveryCard.tsx`, `apps/web/src/lib/cloud/client.ts`, `apps/web/vite.config.ts`, `package.json`, `packages/shared/package.json`, `packages/shared/src/nani/decision.ts`, `packages/shared/src/nani/defaultTests.ts`, `packages/shared/src/nani/diagnosis.ts`, `packages/shared/src/nani/metrics.ts`, `packages/shared/src/nani/registry.ts`, `packages/shared/src/nani/types.ts`, `packages/shared/test/nani.simulation.test.ts`, `scripts/release.mjs`, `src-tauri/Cargo.toml`, `src-tauri/src/main.rs`, `src-tauri/src/network_intelligence/{api_model,bayesian,diagnosis,evaluation,math,mod,probability,recovery,simulation,validation}.rs`, `src-tauri/tauri.conf.json`.

**Interpretation (analysis):** the uncommitted work is dominated by an in-progress NANI hypothesis-space refactor (13 → 19 hypotheses in `diagnosis.rs`), TypeScript NANI parity changes, and desktop pipeline updates. This is clearly active user work.

### Untracked files (142 entries)

Mostly generated audit/phase reports at repo root and in `reports/`, plus newly added NANI source: `apps/web/src/features/nani/`, `apps/web/src/features/nani-reports/`, `apps/web/src/features/nani-memory`, `apps/api/src/routes/naniDiagnostics.ts`, `apps/api/src/services/naniDiagnosticAdapter.ts`, `apps/api/src/services/naniShadowHealthLoop.ts`, 6 API test files, and 40+ Rust `network_intelligence/*` modules (ai/, api_intelligence/, context/, evidence/, events/, plus `hierarchical.rs`, `information_theory.rs`, `learning.rs`, `robust_stats.rs`, `timeseries.rs`, etc.).

**Critical observation (verified):** a substantial portion of the codebase — including the entire extended NANI engine — is **untracked**. These files are not in git history and represent irreplaceable user work. No cleanup, `git clean`, or destructive checkout was performed at any point in this audit.

### Ignored artifacts (PRESERVED)

`.data/`, `.freebuff/`, `.scratch-*`, `.staging-dist/`, `aether/`, `apps/api/cores/`, `apps/api/dist*/`, `certs/`, `cores/`, `evidence/`, `node_modules/`, `src-tauri/target/`, `src-tauri/gen/`, `src-tauri/backend/`, `src-tauri/Cargo.lock`, `tmp/`, and gitignored token files (`cloud/worker/.ops-token.local`, `.vps-sync-token.local`). Secret-bearing files were **not read**.

### Related repositories (discovered, read-only, untouched)

| Path | Exists | Branch | HEAD |
|---|---|---|---|
| `E:/Code/Project/Abystral` | yes | `feat/iran-connection-diagnostics` | `20f10f9` |
| `E:/Code/Project/Abystral-ledger` | yes | `feat/ledger-rearchitecture` | `7593256` |
| `E:/Code/Project/abystral-agent` | yes | `main` | `ee238db` |
| `E:/Code/Project/Bot/Abystral` | yes | `main` | `92329b0` |

None were inspected beyond identity; they are separate repos and outside the authorized change scope.

---

## 2. Baseline verification (before repairs)

| Check | Command | Result |
|---|---|---|
| Rust tests | `cd src-tauri && cargo test` | **527 passed, 0 failed, 2 ignored** |
| Rust toolchain | `rustc --version` | 1.98.1 |
| Node toolchain | `node --version` | v22.22.2 |
| Rust clippy | `cargo clippy --version` | **not installed** |
| Rust fmt | `cargo fmt --check` | **cargo-fmt not installed** |

Compiler emitted **279 warnings** on a clean `cargo check`, including many unused imports and one genuine defect (unreachable pattern — see corruption audit). Warnings were recorded, not hidden.

---

## 3. Preservation rules followed

1. No `git reset`, `git clean`, destructive checkout, or recursive delete was executed.
2. No tracked or untracked file was overwritten wholesale; edits were surgical `Edit` operations on 2 files plus new report files.
3. Pre-existing reports (`NANI_*.md`, `V3_*.md`, `reports/NANI_*.md`, etc.) were **not** modified — all new deliverables use the `ULTIMATE_*` prefix or `ROADMAP.md`.
4. No credentials were read, printed, rotated, or committed.
5. No production infrastructure or deployment was touched.
6. No automated commit was made (project shows no established auto-commit workflow; commit approval left to the user).

## 4. Backups / recovery points

- **Verified:** git history at `b0311fb` is intact and is the recovery point for tracked files.
- **Untracked files have no git recovery point.** This is the single largest preservation risk. Assumption: the user maintains their own backup of untracked work; this audit did not create a filesystem copy (that would duplicate ~700k lines and large binaries). **Recommendation:** commit the untracked NANI source to a feature branch at the user's earliest convenience.

## 5. Work completed in this audit (change attribution)

| File | Change | Verification |
|---|---|---|
| `src-tauri/src/network_intelligence/diagnosis.rs` | removed stale `LocalInterface` catch-all binding; fixed correlation-window reset ordering; added 2 regression tests | compiler warning gone; 529 tests pass |
| `src-tauri/src/network_intelligence/persistence.rs` | 3 × `unwrap_or_default()` serialization sites → error propagation | 529 tests pass |

Both files had pre-existing user changes; edits preserved all of them. See `ULTIMATE_REMOVAL_CHANGELOG.md`.
