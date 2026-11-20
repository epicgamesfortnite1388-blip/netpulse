# EXHAUSTIVE_AUDIT_08 — Verification of the seventeen reported fixes

## Method

Each of the seventeen expanded-audit fixes was re-checked against the current working tree, not against memory or an earlier report. The check covered:

- the actual implementation pattern in the named source file;
- the regression test that names the behavior, where one exists;
- the final verification logs, summarized in report 11.

No source file was modified during this re-check.

## Current-tree verdicts

| ID | Claim | Current-tree verification | Verdict |
|---|---|---|---|
| E-01 | Invalid `https-get` registry literal | `apps/api/src/app.ts` registers defaults as `ApiRegistration[]` and uses `healthCheck: 'http-get'` with the explanatory comment | PASS |
| E-02 | REST-registered APIs lacked rate-limit/retry defaults | `packages/shared/src/nani/registry.ts` exports `DEFAULT_API_RATE_LIMIT`, `DEFAULT_API_RETRY`, and `ApiRegistration`; `registerApi()` applies them | PASS |
| E-03 | Bodyless HTTP probe never sent a request | `requestHttpOutcome()` calls `req.end()` | PASS |
| E-04 | Plain HTTP used against TLS endpoint | Port 443 selects `node:https`, passes `servername`/`rejectUnauthorized: true`, and uses HTTPS for the request | PASS |
| E-05 | Application probe ignored `pathOverride` | Application branch uses `pathOverride ?? '/healthz'`; auth intentionally remains `/` | PASS |
| E-06 | DNS resolved twice | DNS branch reuses the single `host ? await resolveHostname(host) : null` result | PASS |
| E-07 | TLS sockets leaked | Timer and socket listeners are cleaned up and both sockets are destroyed in `finally` | PASS |
| E-08 | Recovery event types absent from shared contract | `nani:recovery:rolledback` and `nani:recovery:reset` plus payload interfaces are present in `packages/shared/src/nani/events.ts` | PASS |
| E-09 | Step kind guessed from ID suffix | `naniService.ts` looks up `plannedStep` and rejects unknown step IDs; `kind` comes from the planned step | PASS |
| E-10 | Route kind hardcoded as `direct` | Route-activated events use `plannedStep.routeKind` captured at planning time | PASS |
| E-11 | Stale recovery controller survived replanning | `planRecovery()` clears `state.recoveryController` before building the new plan | PASS |
| E-12 | Web rollback events did not explain empty observation view | `naniEvents.ts` recognizes `nani:recovery:rolledback` and gives honest rollback/reset descriptions | PASS |
| E-13 | Sandbox `spawn EPERM` failed API egress tests | `systemProxy.ts` uses `spawnSafe()` in `regQuery()`/`regPut()` and degrades to null | PASS |
| E-14 | 44 lint errors | `lint-final.log` records zero errors; the precise types and dead-import removals are still present | PASS |
| E-15 | Local release feed survived `--repo` | `clearLocalFeedMarker()` is imported and applied in `release.mjs`; feed tests cover the behavior | PASS |
| E-16 | Pipeline version check was false-green | `findBuiltVersionAsset()` anchors on `appVersion:"<version>"`; `verify-desktop-pipeline.mjs` uses it and a 3-case regression test exists | PASS |
| E-17 | E2E accepted HTTP 500 | The five checks in `scripts/e2e-desktop.mjs` now require documented 200/202 statuses only | PASS |

## Focused regression coverage

The named regression files remain present and part of the include set:

- `apps/api/test/naniEventContract.test.ts`
- `apps/api/test/naniProbeAdapterHttp.test.ts`
- `apps/api/test/naniProbeAdapterTls.test.ts`
- `apps/api/test/naniRecoveryControls.test.ts`
- `apps/api/test/naniShadowAssessment.test.ts`
- `apps/web/src/features/nani/hypothesisView.test.ts`
- `apps/web/src/features/nani/naniEvents.test.ts`
- `apps/web/test/recoveryRegressions.test.ts`
- `scripts/verify-desktop-pipeline.test.mjs`
- `scripts/update-feed.test.mjs`

## Boundary

These seventeen fixes are verified. This does **not** imply that the six held Rust files are included in the commit, nor that C3 math authorization has been granted. Those remain separate decisions.
