# EXHAUSTIVE_AUDIT_11 — Final test revalidation

## Honest summary

The current working tree is green across every executed gate. One earlier full-workspace run failed a timing-sensitive web clustering test under load; isolated reruns and a clean full-workspace rerun passed. This report records both results rather than hiding the failure.

## Full workspace

### First run — load-sensitive failure

Log: `reports/EXHAUSTIVE_AUDIT/commit-readiness-full-workspace.log`, `15:37:02Z–15:44:14Z`.

| Workspace | Result |
|---|---|
| shared | 14 files / 212 tests PASS |
| api | 118 files / 1271 tests PASS |
| web | 1 failed file, 55 passed; 1 failed test, 533 passed |
| cloud | 6 files / 126 tests PASS |

Failure detail:

```text
FAIL test/mapClusterPerf.test.ts > clustering performance >
clusters 5,000 nodes in under 100ms at far zoom
AssertionError: expected 112.6205000000009 to be less than 100
```

This test had previously failed under heavy parallel load and passed in isolated runs. No source change was made to weaken the assertion.

### Isolation recheck

Log: `reports/EXHAUSTIVE_AUDIT/map-cluster-isolated-reruns.log`.

Three isolated runs of `apps/web/test/mapClusterPerf.test.ts`:

| Run | Result | Duration |
|---|---|---|
| 1 | 1 file / 3 tests PASS | 1.84s |
| 2 | 1 file / 3 tests PASS | 2.04s |
| 3 | 1 file / 3 tests PASS | 1.93s |

### Superseding full-workspace rerun

Log: `reports/EXHAUSTIVE_AUDIT/commit-readiness-full-workspace-rerun.log`, `15:47:53Z–15:53:47Z`.

| Workspace | Result |
|---|---|
| shared | 14 files / 212 tests PASS |
| api | 118 files / 1271 tests PASS |
| web | 56 files / 534 tests PASS |
| cloud | 6 files / 126 tests PASS |
| **Total** | **194 files / 2143 tests PASS** |

Logged command exit: `0`. The earlier failing test passed in this run.

## Other current-tree gates

| Gate | Evidence log | Result |
|---|---|---|
| Rust tests | `commit-readiness-rust-tests.log` | Primary unit suite: 555 passed, 0 failed, 2 ignored; second binary: 0 passed, 0 failed, 1 ignored; EXIT=0 |
| Lint | `commit-readiness-lint.log` | EXIT=0; only the existing module-type advisory warning |
| Typechecks | `commit-readiness-typecheck.log` | shared, api, web, cloud `tsc --noEmit` all EXIT=0 |
| UI contract | `commit-readiness-ui-contract.log` | 55/55 assertions passed |
| Production build | `commit-readiness-build.log` | PASS; large-chunk advisory only |
| Update feed | `commit-readiness-feed-tests.log` | 76/76 checks passed |
| Pipeline version | `commit-readiness-pipeline-tests.log` | 3/3 checks passed |
| Desktop pipeline | `commit-readiness-desktop-verify.log` | All staged-bundle, version-anchor, sidecar, auth and readiness checks PASS |
| Focused NANI API | `commit-readiness-api-nani-focused.log` | 5 files / 25 tests PASS |
| Focused NANI web | `commit-readiness-web-nani-focused.log` | 3 files / 50 tests PASS |
| E2E script syntax | `commit-readiness-e2e-syntax.log` | `node --check` EXIT=0 |

## Environmental notes

- The sandbox blocked `reg.exe` during API egress-related tests. This is an environmental restriction. `spawnSafe()` degrades gracefully, and the full rerun still exited 0. No attempt was made to allow or bypass the blocked program.
- `cargo clippy` remains unavailable in this toolchain. It is not claimed as passing; the limitation is recorded in `cargo-clippy-baseline.log`.
- The production build emits a large-chunk advisory for `LiveMapPage`/`three.module`. This is a performance advisory, not a correctness gate.
- The build and desktop verification regenerated local dist/stage artifacts. Those are not part of the curated commit list.

## Revalidation verdict

**PASS** for commit readiness on all executed gates. The one failed run is superseded by an isolated pass three times and a clean full-workspace pass with the current tree.
