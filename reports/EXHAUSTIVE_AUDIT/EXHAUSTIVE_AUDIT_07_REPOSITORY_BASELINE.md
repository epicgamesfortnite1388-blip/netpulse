# EXHAUSTIVE_AUDIT_07 — Repository baseline and preservation proof

## Purpose

This report records the independent repository state captured at the start of the commit-readiness mission. It is the baseline against which every later verification and ownership decision was made.

## Constraints observed

- No staging.
- No commit, push, reset, clean, amend, or force-push.
- No production or external-service modification.
- No C3 likelihood-table or authorization-policy change.
- No removal of the checked-in local release-feed marker.
- No overwrite of concurrent external UI work.

Raw evidence: `reports/EXHAUSTIVE_AUDIT/commit-readiness-baseline-raw.log`.

## Git state at baseline

| Item | Value |
|---|---|
| Branch | `main` |
| HEAD | `2a9f82593537aee39f799f72816fb0f282f630ec` |
| HEAD subject | `docs(nani): N1.2 deliverables — timestamp contract, atomic concurrency, verification semantics; registry 36->39 (K-1/K-2/K-3 tracked with evidence; NANI-022 accurate)` |
| Upstream | `main...origin/main [ahead 14]` |
| Index | empty; nothing staged |
| Tracked modified files | 71 |
| Untracked files | 254 |
| Total dirty/untracked entries | 325 |
| Base diff stat | `71 files changed, 2628 insertions(+), 1375 deletions(-)` |

The HEAD matched the value reported in the handoff. The index was empty both in the raw baseline and in the status re-check performed after the audit work.

## Ownership landscape

The 325 dirty/untracked entries fall into these classes:

1. **Audit-authored source/config/test changes** — the UI-recovery and expanded-audit fixes summarized in report 06.
2. **Audit-authored reports and evidence** — prior recovery, exhaustive audit, NANI, UI design, and visual evidence corpora.
3. **Concurrent external UI work** — files observed changing during verification, including `EngineBadge.tsx`, `LiveMapPage.tsx`, account/nodes/VPN UI files, `designPrimitives.test.tsx`, and the palette script. These were never edited by this mission.
4. **Pre-existing user work** — including `NANI_ADVERSARIAL_TEST_REPORT.md` and earlier report corpora.
5. **Local operational state** — `.tmp-desktop-dev.log`, `.workbuddy-ai/`, and generated evidence directories not part of the coherent fix set.

## Official candidate reconciliation

The handoff report 06 proposed 154 paths. Those paths were extracted verbatim into `reports/EXHAUSTIVE_AUDIT/proposed-candidates-from-06.txt`:

- 154 lines total.
- 74 source/config/test candidates.
- 80 report/evidence candidates.
- Every path existed and was dirty or untracked at baseline.
- No staging or commit operation was performed on any of them.

## Preservation proof

- Every command used for this mission was read-only against the working tree except for writing new audit reports and logs under `reports/EXHAUSTIVE_AUDIT/`.
- No source file was edited during the commit-readiness mission itself.
- The excluded concurrent files remained dirty and unchanged by this mission.
- The checked-in `package.json` still contains `netpulse.releaseFeed: "local"`.

## Baseline conclusion

The baseline is real and reproducible. The working tree is large and mixed-ownership; a commit must therefore be a curated subset rather than a blanket `git add -A`. The official 154-path list is a useful starting point, but final inclusion still requires the ownership and C3 decisions recorded in reports 09, 10, and 13.
