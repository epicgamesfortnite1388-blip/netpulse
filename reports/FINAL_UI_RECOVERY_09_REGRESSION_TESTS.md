# FINAL_UI_RECOVERY_09_REGRESSION_TESTS

## New regression suite

**File:** `apps/web/test/recoveryRegressions.test.ts`

Result in the final web run: **14/14 PASS**.

| # | Finding | Guard |
|---|---|---|
| 1 | F-03 | Web path with no aggregate verdict returns `healthy: null`, not the attempt count |
| 2 | F-03 | A real desktop aggregate verdict `2/3 healthy` is still parsed correctly |
| 3 | F-08 | Missing `verified` is reported as `Verification unavailable`, not passed |
| 4 | F-08 | Explicit `true` / `false` remain passed / failed |
| 5 | F-09 | `HealthCheckCompleted: Unhealthy` does not erase an older failure signal |
| 6 | F-09 | `Healthy` / `Degraded` still resume observation |
| 7 | F-07 | `recordReplayGap` increments `gapCount` and sets `joinedLate` |
| 8 | F-30 | Pre-aborted request never delivers a delta |
| 9 | F-30 | **Mid-flight** abort prevents a late IPC answer from being delivered |
| 10 | F-32 | Rejected `fetchUpdateHistory` propagates instead of resolving `[]` |
| 11 | F-27 | Settings source wires `onValueChange={selectTab}` and writes `?tab=` |
| 12 | F-28 | Executable startup-health code no longer probes `window.__TAURI__?.invoke` directly |
| 13 | F-28 | Canonical resolver finds packaged v2 `__TAURI__.core.invoke` |
| 14 | F-05 | `q.state.data?.tunnel?.state` guard prevents the mounted-console crash |

## Independence notes

- The original F-30 test was rejected during independent review because it aborted before the async call and would have passed on the buggy implementation. It was replaced with a deferred Tauri `invoke` that resolves **after** `controller.abort()`, proving the late answer is discarded.
- The F-03 test is behavioral: it imports `parseHealthCheckResult` and asserts both the honest web-path null and the preserved desktop aggregate parse. This was added specifically after Kim found that the earlier C1 evidence referenced a non-existent guard.
- Source-regex guards (F-27, F-28, F-05) now strip comment lines, matching the earlier F-28 pattern, so a quoted pattern in a comment cannot manufacture a pass.

## Final aggregate results

```text
Test Files  55 passed (55)
     Tests  523 passed (523)
  Duration  40.05s
```

```text
✓ UI contract intact — 47/47 assertions passed (index-CRlbLKG2.css)
```

```text
test result: ok. 552 passed; 0 failed; 2 ignored
```

## Load-sensitive perf guard

An intermediate run with tests, typecheck, and build executing concurrently failed `mapClusterPerf` at 393.90 ms against its 100 ms budget. The final isolated run passed all 523 tests. This is the previously documented load sensitivity of that timing guard, not a source regression; the final gate uses the isolated run.

## Conclusion

C7 is **CLOSED**. Coverage includes every P1 fix and the highest-risk P2 regressions identified by the independent reviewer.
