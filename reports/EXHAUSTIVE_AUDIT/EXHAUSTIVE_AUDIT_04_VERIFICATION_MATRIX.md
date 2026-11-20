# EXHAUSTIVE_AUDIT_04 — Verification matrix

| Area | Check | Final status | Notes |
|---|---|---|---|
| Lint | `eslint packages/shared/src apps/api/src apps/web/src` | PASS | 44 baseline errors reduced to 0 |
| Shared math | Vitest, 14 files | PASS | 212 tests; no likelihood-table change made under C3 |
| API | Vitest, 118 files | PASS | 1271 tests; includes 3 new NANI regression files |
| Web | Vitest, 56 files | PASS | 534 tests; includes 16 recovery regressions and 9 design-primitive tests |
| Cloud worker | Vitest, 6 files | PASS | 126 tests |
| Rust | `cargo test` | PASS | 555 passed, 0 failed, 2 ignored |
| UI contract | `assert-ui-contract.mjs` | PASS | 53/53 |
| Typecheck | API and web `tsc --noEmit` | PASS | Web also checked inside the build |
| Build | `npm run build` | PASS | API tsup + web Vite |
| Visual | CDP screenshots against scratch sidecar | PASS | 5 data-backed screens, no horizontal overflow |
| Update feed | `npm run test:feed` | PASS | 76/76, including local-marker clearing |
| Pipeline version gate | `npm run test:pipeline` | PASS | 3/3, including two false-green cases |
| Desktop pipeline | `npm run desktop:verify` | PASS | All checks, including the anchored version marker |
| Security | Target guard, CSRF, CORS, egress, vault suites | PASS | No new unsafe casts in the changed NANI path |
| Reliability | Proxy spawn, WebSocket cancel, updater failure propagation | PASS | Covered by API/web suites |

## New regression files added in the expanded phase

- `apps/api/test/naniProbeAdapterHttp.test.ts` — bodyless GET is actually sent; application path override is honored.
- `apps/api/test/naniProbeAdapterTls.test.ts` — port 443 uses `node:https` with SNI; TLS failure destroys both sockets.
- `apps/api/test/naniEventContract.test.ts` — typed event envelope/topics, planned step kinds, real route kinds, registry policy defaults.
- `scripts/verify-desktop-pipeline.test.mjs` — an unrelated framework version and a stale version cannot satisfy the built-version gate.
- `scripts/update-feed.test.mjs` — extended with local-marker clearing coverage (76/76 total).

## Modified regression fixtures

- `apps/api/test/naniRecoveryControls.test.ts` and `apps/api/test/naniShadowAssessment.test.ts` were updated for the removed unused `dns` parameter in `runDiagnosticTest()`.

## Overall gate

The expanded-audit fix scope is verified green. Full release remains a separate gate because C3 is still authorization-gated and `cargo clippy` is unavailable. No commit was made.
