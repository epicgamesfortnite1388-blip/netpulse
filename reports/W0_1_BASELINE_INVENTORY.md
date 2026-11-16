# W0-1 Baseline Inventory

Executed 2026-11-16 21:45–22:20. Preservation task only — no algorithm, behavior, or configuration changes.

## Repository state at mission start

| Item | Value |
|---|---|
| Root | `E:\Code\Project\Vpn_app` |
| Branch | `main` |
| HEAD | `b0311fb8addc542f9fc79cd26893f6bdd2cf982d` |
| Tracked modified | 39 files (list in `W0_1_STAGING_MANIFEST.md`) |
| Untracked entries | 204 (317 files when expanded `--untracked-files=all`) |
| Staged | none |
| Submodules | none |
| Git LFS | none (no `.gitattributes`, `git lfs ls-files` empty) |
| Symlinks | none under src/apps/packages/cloud |
| Ignored runtime state (verified, left in place) | `.data/` (daemon token, sqlite db + wal, logs), `certs/` (signing keys), `dist-desktop/`, `apps/api/dist-desktop/`, `.staging-dist/`, `apps/api/dist/`, `.wrangler/` |

## Critical NANI source verification (by symbol + path, not historical lines)

| Required file | Present | Tracked before W0-1 | Committed by W0-1 |
|---|---|---|---|
| `src-tauri/src/network_intelligence/foundation.rs` (1,407 L, NaniMathEngine) | ✅ | NO | ✅ `384f7f9` |
| `src-tauri/src/network_intelligence/investigation.rs` (967 L, lifecycle) | ✅ | NO | ✅ |
| `src-tauri/src/network_intelligence/sequential.rs` (VOI/stopping) | ✅ | NO | ✅ |
| `src-tauri/src/commands/nani.rs` (all Tauri NANI commands) | ✅ | NO (whole `commands/` dir untracked) | ✅ |
| `network_intelligence/events/` (EventBus, event/state definitions) | ✅ | NO | ✅ |
| `network_intelligence/ai/` (local LLM boundary) | ✅ | NO | ✅ |
| `network_intelligence/api_intelligence/` (registry, monitor, classifier) | ✅ | NO | ✅ |
| Rust math modules (math/bayesian/probability/robust_stats/causal/changepoint/hierarchical/timeseries/learning/persistence/…) | ✅ | mixed: 14 tracked-modified, 8 untracked | ✅ all |
| TS NANI adapters/consumers (`apps/api` nani services+route+8 tests; `apps/web/src/features/nani/` 9 files — **entire feature uncommitted**; `packages/shared/src/nani` 6 modified + hypotheses test) | ✅ | NO / partially | ✅ |
| `apps/web/src/features/nani-memory` | ✅ (2,183 B JS hook, "NANI Action History Hook") | NO | ✅ (flagged: referenced by nothing yet — preserved, not wired) |
| Config/build (`package.json`×4, `Cargo.toml`, `tauri.conf.json`, `vite.config.ts`, `scripts/release.mjs`) | ✅ | modified | ✅ |

Missing-from-inventory check: **no required source file is absent.** The engine compiles and its 368 tests pass from the committed tree (see `W0_1_BUILD_VERIFICATION.md`).

## The one deviation from the Phase-2 inventory

`AdaptiveRecoveryCard.tsx` appeared "modified" after the commit — verified as a **CRLF phantom** (`git diff` on it is empty, 0 lines). No real unstaged change exists post-commit.

## Post-commit remaining tree (fully accounted)

23 untracked entries: the 2 W0-1 manifest files at root (committed separately after), `.tmp-desktop-dev.log` + `.workbuddy-ai/` (intentionally unstaged, in backup), and PNG-only report paths (intentionally unstaged, in backup). **Zero real user changes remain unstaged.**
