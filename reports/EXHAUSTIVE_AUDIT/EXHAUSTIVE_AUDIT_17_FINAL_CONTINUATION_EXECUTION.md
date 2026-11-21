# EXHAUSTIVE_AUDIT_17 — Final continuation execution and clean-checkout proof

## Authorization

The user granted full access and instructed continuation after commit `1399be63003c07a4888ddb1b2d231f30b165858f`. This phase created four additional local commits. No push, deploy, release activation, remote infrastructure change, or production configuration change was performed.

## Commits created

| # | Hash | Subject | Paths |
|---:|---|---|---:|
| 1 | `350ffedf7d3db31cea6f85632329e6b5b5bcbce8` | `test: deterministic map work envelope and reliable ui-capture tab/detail handling` | 5 |
| 2 | `9eda1322642347b4102d1e27dde90fde18afff05` | `style(vpn): give engine glyphs distinct protocol identities` | 1 |
| 3 | `503ce2ae2e8af3ca2b0a6b8d55ab686af75afdb5` | `test(ui): add rendered colour and contrast audit` | 1 |
| 4 | `354034747b8fff87be94d4f34c635f3efc0a2bcd` | `refine(vpn): apply detail-level gates across connection surfaces` | 5 |

All commits are local only. Branch is `main...origin/main [ahead 20]`.

## First continuation commit — 350ffed

Staged paths:

- `apps/web/test/mapClusterPerf.test.ts`
- `apps/web/test/mapClusterWork.test.ts`
- `apps/web/test/perf-baseline.json`
- `reports/EXHAUSTIVE_AUDIT/EXHAUSTIVE_AUDIT_16_ALL_REMAINING_COMMIT_EXECUTION.md`
- `scripts/ui-capture.mjs`

Changes:

- Wall-clock clustering assertions became opt-in via `NP_PERF=1`, with warm-up, 21 samples, medians, p95, environment reporting, and recorded-baseline drift checks.
- A deterministic `mapClusterWork.test.ts` was added. It counts node property reads and `Map` iteration to prove linear growth rather than relying on scheduler timing.
- `ui-capture.mjs` now treats the first detail-level pass as non-fatal, scrolls tabs into view, verifies the active tab after click, and fails on a missing or unactivated tab.
- The comment reporting skipped perf cases was corrected from `3 skipped` to `4 skipped`.

Kim originally returned **APPROVED WITH CONDITIONS** because the initial proposed title under-described the ui-capture behavior change. The commit was created with the broader approved title, satisfying the condition.

Generated 362 KB test-result files `apps/.perf-idle.json` and `apps/.perf-load.json` were deliberately left unstaged and untracked.

## Later continuation commits

- `9eda132` gives each engine/provider glyph a distinct `--color-proto-*` identity and documents why violet is reserved for Aether.
- `503ce2a` adds `scripts/ui-colour-audit.mjs`, a rendered-interface colour/contrast audit using computed browser styles rather than token values.
- `3540347` applies detail-level gates across `Surface.tsx`, `CoreSurface.tsx`, `OverviewSurface.tsx`, `ProviderSurface.tsx`, and `VpnPage.tsx`.

## Gate evidence

After the continuation changes:

- Web tests: **57 passed files / 1 skipped**, **553 passed tests / 4 skipped**.
- Workspace typechecks: PASS.
- Production build: PASS.
- UI contract: **55/55**, PASS.
- `node --check scripts/ui-capture.mjs`: PASS.
- `node --check scripts/ui-colour-audit.mjs`: PASS.

`app/.perf-*` result files were not treated as source or evidence because they are generated machine-specific Vitest JSON dumps.

## Clean-checkout proof

A temporary detached Git worktree of final HEAD `3540347` was created outside the repository, local `node_modules` directories were symlinked for dependency resolution, and the gates were rerun against the clean checkout:

```text
WORKTREE_ADD=0
TYPECHECK=0
BUILD=0
UI=0
WEB=0
UI contract: 55/55 assertions passed
Web tests: 57 passed | 1 skipped (58)
WORKTREE_REMOVE=0
```

This resolves the earlier finding that commit `6dd3929` was not self-contained. The final HEAD builds and passes the UI contract from a clean checkout.

## Final state

```text
HEAD: 354034747b8fff87be94d4f34c635f3efc0a2bcd
Branch: main...origin/main [ahead 20]
Index: empty
Remaining tracked modification: apps/web/src/styles/identity.css
Remaining untracked: apps/.perf-idle.json, apps/.perf-load.json, this report
```

`apps/web/src/styles/identity.css` changed again after the final clean-checkout verification. It was not staged or committed; active external UI edits are still landing. The two perf JSON files remain intentionally untracked.

This report is intentionally untracked and not part of any commit.

## Limitations

- `cargo clippy` remains unavailable.
- The sandbox still blocks `reg.exe`; API tests pass through graceful degradation.
- Active external edits mean the working tree can change after any verification checkpoint.

## Boundary confirmation

**NO PUSH WAS PERFORMED. NO DEPLOYMENT WAS PERFORMED. NO REMOTE OR PRODUCTION CHANGES WERE MADE.**
