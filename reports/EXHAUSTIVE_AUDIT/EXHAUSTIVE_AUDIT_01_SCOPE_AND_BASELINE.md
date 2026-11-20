# EXHAUSTIVE_AUDIT_01 — Scope and baseline

## Mission continuity

This report continues the UI recovery mission and the later user request to inspect "every single function and file, then fix them". It preserves the earlier no-commit constraint: HEAD remains `2a9f82593537aee39f799f72816fb0f282f630ec`, nothing has been staged, and no commit, push, reset, clean, or history rewrite was performed.

## Scope actually covered

- `apps/api/src/**` and `apps/api/test/**`
- `apps/web/src/**` and `apps/web/test/**`
- `packages/shared/src/**`
- `src-tauri/src/**` and Rust tests
- `scripts/**`, root config, and packaging entry points already covered by earlier recovery reports
- Data-backed visual evidence with a scratch API sidecar and a Vite dev server pointed at real API data

## Baseline problems carried into this phase

1. Lint baseline: 44 errors, mostly `no-explicit-any`, unused imports/variables, and one unnecessary generic constraint.
2. Full workspace tests had previously failed because `apps/api/src/services/systemProxy.ts` called `spawn('reg', ...)` and the sandbox returned `EPERM`.
3. NANI-021 proxy contamination had been fixed in Rust with `.no_proxy()`, route inference, and event qualifiers, but needed independent re-verification.
4. F-02 calibration honesty had been corrected in the display path, but C3 still requires explicit authorization for any likelihood-table change.
5. Data-backed visual evidence had been captured but not yet formally reported.
6. Expanded audit reports and an updated commit candidate list did not exist.

## Concurrent work

Several UI files changed while verification was running (notably `EngineBadge.tsx`, `LiveMapPage.tsx`, and later additional account/nodes/VPN files, a design-primitives test, and `scripts/unify-palette.mjs`). Those edits were not overwritten. Two intermediate build attempts observed partially written files; the final build, lint, UI contract, web tests, and full workspace tests were rerun after the observed edits settled. Concurrent files are explicitly excluded from the commit candidate list in report 06.

## Honest boundary

The exhaustive audit found and fixed additional real defects. It does not claim that every line of every file was formally proved correct beyond the executed test suites and targeted review. C3 remains blocked pending explicit math authorization; `cargo clippy` remains unavailable in this toolchain.
