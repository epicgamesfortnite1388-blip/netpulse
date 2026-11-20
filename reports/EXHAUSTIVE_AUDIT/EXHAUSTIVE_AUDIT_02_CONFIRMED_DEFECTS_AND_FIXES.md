# EXHAUSTIVE_AUDIT_02 — Confirmed defects and fixes

| ID | Defect | Root cause | Fix | Evidence |
|---|---|---|---|---|
| E-01 | Invalid `healthCheck: 'https-get'` literal in the default API registry | Value was hidden by `as any`; `HealthCheckMethod` does not define `https-get` | Changed to `http-get` with an explanatory comment; typed `defaultApis` as `ApiRegistration[]` | `apps/api/src/app.ts`, `api-tests-final.log` |
| E-02 | Providers registered through REST received no rate-limit or retry policy | `registerApi()` never defaulted `rateLimit` or `retry` | Added `DEFAULT_API_RATE_LIMIT`, `DEFAULT_API_RETRY`, and `ApiRegistration` with explicit defaults | `packages/shared/src/nani/registry.ts`, `naniEventContract.test.ts` |
| E-03 | Bodyless HTTP probe never sent a request | `http.request()` was created but `.end()` was never called | Added `req.end()` in `requestHttpOutcome()` | `naniProbeAdapterHttp.test.ts` |
| E-04 | Plain `http` module used against port 443 | Scheme was inferred from module choice, not from the endpoint | Port 443 now uses `node:https` with SNI and `rejectUnauthorized: true` | `naniProbeAdapterTls.test.ts` |
| E-05 | Application-layer probe ignored `pathOverride` | The `application` branch hardcoded `/healthz` | Uses `pathOverride ?? '/healthz'`; `auth` intentionally remains `/` | `naniProbeAdapterHttp.test.ts` |
| E-06 | DNS was resolved twice in one probe | `ip` was computed up front and again in the DNS branch | Reuses the first result, so verdict and later layers share one answer | `naniProbeAdapter.ts` |
| E-07 | TLS sockets leaked on timeout/error | Timer rejected the promise but sockets were never destroyed | Added deterministic listener cleanup and `destroy()` in `finally` | `naniProbeAdapterTls.test.ts` |
| E-08 | Recovery events used types outside the shared contract | `nani:recovery:rolledback` and `nani:recovery:reset` were emitted but not declared | Added both event types and payload interfaces to the shared union | `packages/shared/src/nani/events.ts` |
| E-09 | Recovery step `kind` was guessed from the step-id suffix | `stepId.split(':')[1]` produced invalid values such as `probe` | Uses the planned step's real `RecoveryStepKind`; unknown step IDs are rejected | `naniEventContract.test.ts` |
| E-10 | Route-activated events always claimed `kind: 'direct'` | Hardcoded value ignored the planned route type | Uses `plannedStep.routeKind` captured at planning time | `naniEventContract.test.ts` |
| E-11 | A stale recovery controller could survive a new plan | `planRecovery()` only attached a controller when the new plan was ready | Clears `recoveryController` at the start of every plan | `naniService.ts` |
| E-12 | Web rollback events did not explain an empty observation view | `lastFailedHealthSignal()` only knew Rust-style `RecoveryRolledBack` | Recognizes `nani:recovery:rolledback` and describes rollback/reset honestly | `naniEvents.ts`, `naniEvents.test.ts` |
| E-13 | Sandbox `spawn EPERM` failed API egress tests | `spawn('reg', ...)` could throw synchronously | Added `spawnSafe()` with graceful null fallback | `systemProxy.ts`, API egress suite |
| E-14 | 44 lint errors in API/shared source | Unsafe `any`, dead imports, unused variables | Precise event/controller types, removed dead imports and casts, removed no-op assignment | `lint-final.log` — 0 errors |
| E-15 | `release.mjs --repo owner/repo` still shipped a localhost updater feed | The `netpulse.releaseFeed: "local"` marker survived and overrode `repository` | Added `clearLocalFeedMarker()`; `--repo` now clears the marker and rewrites when either value changes | `feed-tests-after-scripts-fix.log` — 76/76 |
| E-16 | `desktop:verify` claimed a version check but never compared versions | Checked only file existence | Added `findBuiltVersionAsset()` anchored on `appVersion:"<version>"` plus a regression test | `pipeline-version-tests.log` — 3/3; `desktop-verify-after-scripts-fix.log` |
| E-17 | E2E checks accepted HTTP 500 as success | `status >= 500` used as a pass condition in five checks | Only documented 200/202 success statuses now pass | `scripts/e2e-desktop.mjs`, syntax check |

## Non-defects and deliberate choices

- `auth` probes still request `/` rather than `pathOverride`; an auth check is defined against the provider root, and no default health layer list includes `auth`.
- The checked-in `package.json` intentionally still uses `netpulse.releaseFeed: "local"`; a release run with `--repo owner/repo` now clears it. Deliberately setting `NETPULSE_RELEASE_REPO=local` still wins by documented precedence.
- The pipeline version anchor assumes the minifier keeps `appVersion:"…"`. A future quoting change would cause a false failure, not a false pass.
- The UI contract warning about large chunks remains a performance advisory, not a correctness blocker.
- `reg.exe` remains blocked by the sandbox; tests now degrade gracefully by design.
