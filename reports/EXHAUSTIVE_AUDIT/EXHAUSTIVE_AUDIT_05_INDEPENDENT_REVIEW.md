# EXHAUSTIVE_AUDIT_05 — Kim independent review

## Reviewer

Kim, acting as an independent reviewer with no edit authority, read the actual source, the new tests, the two updated mocks, and all final evidence logs.

## Verdict

**PASS** for the expanded-audit fix scope. No fabricated evidence, no correctness regression, and no merely cosmetic fix was found in the listed scope.

## Verified counts

- Full workspace: 193 files / 2139 tests at the time of review (later final rerun: 194 files / 2143 tests).
- Rust: 555 passed, 0 failed, 2 ignored.
- Web: 56 files / 532 tests at review time (later final rerun: 534 tests).
- UI contract: 47/47 at review time (later final rerun: 53/53).
- Lint: clean. Typechecks: clean. Build: PASS.

## Kim's non-blocking suggestions and disposition

1. **Claim precision — `auth` pathOverride.** The implementation intentionally keeps `auth` on `/`. The report now states this explicitly instead of claiming all three HTTP-bearing layers share the override.
2. **Coverage gap — HTTPS/TLS branch.** Added `naniProbeAdapterTls.test.ts` to prove port 443 uses `node:https` with SNI and that both sockets are destroyed on handshake failure.
3. **Dead condition.** Removed the redundant `nani:recovery:rolledback` check from `activityForEvent()`'s default branch after the explicit case was added.
4. **Redundant casts.** Removed two `as RecoveryObservation` casts in `rollbackToKnownGood()`.
5. **Earlier-scope follow-up.** Kim noted that `nani:health:updated` still clears `lastFailedHealthSignal()` regardless of status, unlike the F-09 guard on `ApiHealthChanged`/`HealthCheckCompleted`. This is outside the current fix scope and is recorded as a follow-up, not silently changed.

## Evidence timing

Kim correctly noted that the first full-workspace and Rust logs predated the concurrent UI edits. The web suite, lint, UI contract, and build were rerun afterwards, and the final full-workspace rerun at `15:03Z–15:11Z` supersedes the earlier log. Rust source was unchanged by those TSX edits.

## Second independent review — scripts and release gates

A separate read-only audit of build/release/e2e scripts and configs found three material defects (report 02, E-15–E-17). After fixing them, the reviewer initially rejected the first version of the pipeline version check because a loose quoted-version scan could be fooled by React/Router version literals. It was replaced with an anchored `appVersion:"<version>"` helper and a 3-case regression test. Recheck verdict: **PASS**; all three demonstrated false-green paths are closed. The only residual note is that a future minifier changing quoting/spacing would cause a false failure, not a false pass.

## Final independent decision

Expanded-audit fixes: PASS. Script/release-gate fixes: PASS after recheck. Full release: still a separate decision because C3 and the Clippy toolchain limitation remain.
