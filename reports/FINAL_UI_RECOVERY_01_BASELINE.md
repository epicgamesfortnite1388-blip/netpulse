# FINAL_UI_RECOVERY_01_BASELINE

## Purpose

This report records the preserved baseline for the NetPulse/NANI final UI recovery mission. No git history was rewritten and no commit was created.

## Repository baseline

| Item | Value |
|---|---|
| Repository | `E:\Code\Project\Vpn_app` |
| Branch | `main` |
| HEAD | `2a9f82593537aee39f799f72816fb0f282f630ec` |
| Upstream relationship | `main...origin/main [ahead 14]` |
| Working tree | Dirty before, during, and after recovery work |
| Commit created | **No** |
| Push/deploy/release | **No** |

## Preservation measures

- Read `git status --short --branch` before edits.
- Did not run `reset --hard`, `clean`, `checkout --`, `amend`, `force-push`, or `add -A`.
- Did not stage files.
- Did not overwrite concurrent user work without verifying file stability.
- Used fresh output/cache directories for build and visual verification to avoid destructive cleanup of existing generated artifacts.
- Left all existing reports, screenshots, `.data`, certificates, and configuration files in place.

## Recovery scope accepted

The recovery mission required:

1. Eliminate the actionable P1 UI defects (F-03, F-05, F-27, F-28; F-04 had already been fixed).
2. Repair event, Copilot, socket, and updater honesty defects (F-07–F-09, F-29–F-32, F-36).
3. Correct false/overstated claims in the UI_MASTER report set (F-35).
4. Investigate and stabilize Rust test failures (F-15).
5. Re-run frontend, Rust, UI-contract, build, visual, and regression checks.
6. Produce twelve `FINAL_UI_RECOVERY_*` reports.
7. Provide an exact commit-candidate file list without committing.

## Out-of-scope / authorization-gated items

These were explicitly not changed as part of the UI recovery:

- F-01 — authoritative likelihood table changes.
- F-02 — self-derived “calibration” semantics.
- F-11 — evaluation thresholds / calibration algorithm.
- F-06 — NANI-021 proxy contamination (`.no_proxy()` and route honesty).
- Backend DTO, persistence, K-1/K-2/K-3 command-surface changes not necessary for the UI recovery.

## Attribution limitation

Git establishes preservation and non-commit, but the pre-existing dirty tree was not hashed file-by-file at recovery start. Therefore the reports distinguish between:

- changes **made in this recovery pass** (enumerated in report 03), and
- larger uncommitted diffs that were already present at baseline (for example the engine/evaluation work behind F-01/F-02/F-11).

No claim is made that the full uncommitted Rust diff was authored during this recovery.

## Final baseline statement

The recovery work changed only frontend UI/test files, Rust **test fixtures and test oracles**, evidence-correction appendices, verification tooling, and reports. No production engine math or probe transport behavior was changed in this recovery pass.
