# N1_2_REVIEW_07 — Independent Test Reproduction

**Reviewer:** Kim · **Environment:** Windows, repo working tree at `2a9f825` + concurrent WIP; all commands executed by this reviewer fresh.

| Suite | Command | Exit | Result | Code tested |
|---|---|---|---|---|
| Rust full #1 | `cargo test --manifest-path src-tauri/Cargo.toml` | 0 | **552 passed / 0 failed / 2 ignored** (11.49 s) | working tree |
| Rust full #2 (same command, immediately after) | 0 | **552 / 0 / 2** (6.98 s) | working tree |
| k1_ filter | `cargo test … k1_` | 0 | **5 passed / 0** | working tree |
| k2_ filter | `cargo test … k2_` | 0 | **1 passed / 0** | working tree |
| k3_ filter | `cargo test … k3_` | 0 | **5 passed / 0** | working tree |
| Web NANI | `npx vitest run src/features/nani` | 0 | **34 passed (2 files)** | working tree |
| E2E | `npm run e2e` | 0 | **44 passed, 0 failed** | working tree |
| Perf smoke | `cargo test … n1_analysis_latency -- --nocapture` | 0 | 80 probes / 20 APIs in **2.472 s** | working tree |

Three consecutive full-green runs achieved (this reviewer's two + Will's
documented run); the k2 stress ran green twice fresh (plus four prior runs
documented by Will).

## The intermediate 4-failure batch — honestly assessed

Will's report discloses one non-reproducible batch with 4 failures during
development, then three clean runs. Inspected documentation (N1_2_05):
failures were transient network-fixture flakes during test authoring
(dynamic-port rebind + interfered network), consistent with the previously
observed live flake that motivated port-1 fixtures. I could not reproduce
any failure in 2 fresh full runs. Assessment: the environmental hypothesis
is the best-supported one, but it remains an **assumption** — the honest
position is "unreproduced transient, plausibly environmental, not
positively root-caused." This does not block acceptance (the invariants in
question have dedicated deterministic tests), but the batch is recorded
here as not-fully-explained.

## Code-tested caveat (material)

Every run above compiled the **working tree** — which includes the
concurrent author's WIP and the applied K-1 conversion. None of these runs
executed the committed ms-feeder path at HEAD (which contains no conversion;
see REVIEW_01 §3). No committed test references WIP-only symbols
(`observe_probe_recording` absent from HEAD's tree — verified), so HEAD's
tree is expected to compile and its suite to pass, but this review did NOT
execute HEAD's tree (doing so would require a disposable worktree; noted as
the one remaining unexecuted verification, low value since the defect at
HEAD is established by source inspection).

## Test-quality audit (key tests)

- k1 comparative tripwire: deterministic (no network), comparative
  assertion, would fail pre-fix ✓.
- k2 stress: real production admission, Barrier contention, asserts
  invariant + allocator exactness ✓ (cannot observe mid-section states, but
  none exist by construction — REVIEW_04 §C).
- k3 cases: pure-function mapping, boundary-pinned ✓.
- Oracle: independent reconstruction, 1e-9 ✓.

## Verdict: Test reproducibility — **PASS** (with the working-tree-vs-HEAD caveat and the unexplained-batch caveat recorded)
