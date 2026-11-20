# N1_2_REVIEW_01 — Repository and Commit Forensics

**Reviewer:** Kim — Code Review Expert · **Date:** 2026-11-17 · **Mode:** read-only
**Verified HEAD:** `2a9f82593537aee39f799f72816fb0f282f630ec`, branch `main`

## 1. Commit inventory (independently inspected)

| Commit | Parent | Files | Contents verified |
|---|---|---|---|
| `c7fe33b` | `0a3cce5` | investigation.rs (+60/−16), N1_07 tracker | K-2 atomic admission + K-3 three-way prose + tracker addendum. Boundary matches description. |
| `d46ece9` | `c7fe33b` | monitor.rs (+145), investigation.rs (+236/−33) | Canonical timestamp boundary + K-1/K-2/K-3 tests + pure `verify_result_text`. Boundary matches. |
| `2a9f825` | `d46ece9` | registry + 7 N1_2 reports (8 files, +507/−1) | Documentation only. All seven reports present in the tree (`git ls-tree` → 7 hits). |

Ancestry linear: `2a9f825 → d46ece9 → c7fe33b → 0a3cce5 → 200de54 → 5b65737 → 481f6b3`. Nothing pushed.

## 2. Working tree (concurrent state)

- Staged: **empty** (`git diff --cached` — no output).
- Modified tracked: 18 files — the concurrent author's WIP (`AppShell.tsx`,
  `NaniPage.tsx`, `hypothesisView.*`, `naniApi.ts`, `naniEvents.*`,
  `main.tsx`, `commands/nani.rs`, `registry.rs`, `diagnosis.rs`,
  `evaluation.rs`, `events/mod.rs`, `foundation.rs`, `persistence.rs`,
  `validation.rs`, `NANI_ADVERSARIAL_TEST_REPORT.md`).
- Untracked: 53 paths. All preserved; reviewer modified nothing.

## 3. MATERIAL FINDING — the ms-feeder IS at HEAD (falsifies a report claim)

`git show 2a9f825:src-tauri/src/commands/nani.rs` contains, inside the
manual health-check loop (after `for api_id in ids { let outcome =
probe_api(...) }`):

```rust
let probes = diagnostic_probes(&outcome);
let mut math = state.math.lock().unwrap_or_else(|p| p.into_inner());
for probe in &probes {
    math.observe_probe(probe);      // ← RAW MILLISECOND timestamps, no conversion
}
```

- This entered history in **`384f7f9`** ("chore(recovery): preserve complete
  NANI baseline") — `git log -S "observe_probe"` confirms it — i.e. the
  ms-feeder has been **committed since the W0-1 recovery**, long before N1.2.
- The working-tree WIP *expands* this code (`observe_probe_recording` +
  isotonic-calibration samples — `observe_probe_recording` does **not** exist
  at HEAD) and carries Will's applied conversion at `nani.rs:326`
  (`probe.timestamp /= 1000`, unstaged, correctly preserved around the
  author's ~67 other changed lines).
- **Consequence:** N1_2_01 §4's claim — "the manual health-check feature
  itself does not exist at HEAD … the committed binary has no ms-feeder at
  all" — is **factually incorrect**. The committed binary DOES feed the
  shared `state.math` engine raw millisecond deltas on every manual health
  check. N1_REVIEW_01's original misattribution ("uncommitted concurrent
  work") stemmed from the same error (the feeder's *expansion* is WIP; the
  *feeder* is committed). This reviewer's own prior review shared that error
  and now corrects it.

## 4. Test-vs-HEAD caveat (established, not assumed)

`cargo test` compiles and runs the **working tree**, which contains the
applied conversion — so the green suites do **not** exercise the committed
ms-feeder path. HEAD's own tree compiles (its code predates the WIP and
matches the `384f7f9` baseline API), but no current test execution verifies
HEAD's runtime behavior directly.

## 5. Commit-boundary integrity checks

- No unrelated files entered any N1.2 commit (file lists verified above).
- Registry diff `0a3cce5 → 2a9f825`: 36 → 39 entries, **nothing lost**, added
  `N1R-K1/K2/K3` only; NANI-003 and NANI-022 modified (justified, evidence
  strings present).
- Engine files untouched: `git diff 0a3cce5..2a9f825` over `diagnosis.rs`,
  `bayesian.rs`, `math.rs`, `probability.rs` → **empty diff**.
- No credentials, tokens, or local state in any inspected diff.

## 6. Verdicts (this phase)

- Repository and commit integrity: **PASS** (boundaries clean, ancestry linear, reports committed).
- Working-tree preservation: **PASS** (18 modified + 53 untracked intact; the author's WIP byte-preserved around Will's documented 1-hunk conversion).
- Documentation accuracy of N1_2_01 §4 / N1_2_07 §B: **FAIL on one material claim** — corrected here; carried into the final decision.
