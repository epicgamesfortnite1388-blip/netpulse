# NetPulse — Repair Log

All changes are in `Vpn_app`. Commits: `7c2a9d9` (engine hardening), `578b6d7` (DPAPI + engine/install fixes, 2026-10-12). The worker-test await fix and `.gitignore` hygiene entry are uncommitted at report time (pending the owner's go-ahead for the next commit).

## R1 — P1: engine install could write an unverified binary

- **File:** `apps/api/src/services/engineManager.ts:607-622`
- **Problem:** `installEngine` verified the downloaded asset against the release's digest sidecar only when the sidecar was present. A release missing the expected `.dgst`/`hashes.txt` asset fell through with `checksumVerified: false` and still copied the binary into the cores dir — an unverified-executable install, the exact outcome the pipeline exists to prevent.
- **Root cause:** the sidecar branch was `if (digestUrl) { …download, compare… }` with no failure path when the sidecar is absent.
- **Fix:** fail the install with an explicit reason when the expected digest sidecar is missing (`release … publishes no digest sidecar … — refusing to install unverified`), matching the stricter behavior Aether's install path already had.
- **Why this fix:** the pin layer (sing-box) already refuses unverifiable assets; this closes the same hole for the sidecar cores. Failing closed is the only contract-consistent behavior.
- **Tests:** engineFundamentals.test.ts asserts the release-table digest declarations per engine; install guards covered by engineManager.test.ts (never-writes-on-failure contract).
- **Verification:** API suite 1007/1007; typecheck, lint clean.
- **Remaining risk:** none identified for the local path; live GitHub release metadata was not re-fetched in this environment (network-touching path guarded by tests).

## R2 — P2: version-currency comparison false positives

- **File:** `packages/shared/src/models/proxyEngine.ts:123-139`
- **Problem:** `engineVersionIsCurrent` used `installedLine.includes(want)`, so tag `v1.4.0` matched an installed `Xray 11.4.0` (and `app/v2.12.3` matched `Version: 12.12.3`) — the Engine Manager page would hide real updates.
- **Root cause:** bare substring match across version-component boundaries.
- **Fix:** whole-token match — the version must be bounded by anything other than a digit or dot on both sides (`(?:^|[^\d.])<escaped>(?![\d.])`).
- **Why this fix:** preserves every documented true case (including `Version: v2.12.3` where the version follows a letter) while eliminating boundary collisions; no lookbehind, so it runs in every browser the webview ships.
- **Tests:** 10 boundary cases in engineFundamentals.test.ts (documented shapes, substring collisions, prerelease, no-digit tag).
- **Verification:** API + shared + web suites green; the Engine Manager page consumes this function at `EngineManagerPage.tsx:188`.

## R3 — P3: unawaited test assertion

- **File:** `cloud/worker/test/worker.test.ts:444`
- **Problem:** `expect(…).resolves.toHaveLength(0)` without `await` — Vitest warns it will hard-fail in Vitest 3.
- **Fix:** await the response JSON and assert the array length directly (same style as the adjacent owner-assertion lines).
- **Verification:** worker suite 91/91; the "not awaited" warning is gone.

## R4 — P3: untracked deploy staging output

- **File:** `.gitignore`
- **Problem:** `.staging-dist/` (worker bundle from a deploy attempt) was untracked and unignored — one `git add -A` from being committed.
- **Fix:** ignore `.staging-dist/` with a comment, matching the existing generated-output entries.

## R5–R9 — earlier same-day session (commit 578b6d7, all verified there)

- **R5 (P1, security):** refresh token + E2E vault key stored plaintext in localStorage → DPAPI-backed secure store (`src-tauri/src/dpapi.rs` Rust commands with hand-rolled FFI, fail-closed on tampered blobs; `apps/web/src/lib/cloud/secureStore.ts` with prime/migrate/fallback; wired into sessionStore, vaultKey, useCloudSession). 5 regression tests.
- **R6 (P1, platform correctness):** PBKDF2 at 210k iterations — Workers' WebCrypto refuses counts above 100000, so register/login would fail on the platform → capped at 100k (`cloud/worker/src/crypto.ts`).
- **R7 (P2, test determinism):** tamper-rejection tests prefixed the signature with 'f' — a no-op on the 1/16 of signatures already starting with 'f', which made the "rejects tampered bodies" test intermittently pass the tampered request → flip the final hex char (`tamperHex` in both worker test files). Worker suite went from flaky (2/13 failing) to 91/91 stable.
- **R8 (P2, functional):** elevation allow-list compared raw paths against `canonicalize` output (the `\\?\` verbatim form), so legitimate WireGuard installs never matched and the gate always denied → canonicalize allow-list entries too (`src-tauri/src/elevation.rs`).
- **R9 (P2, reliability):** updater's locked-file recovery called `spawn_sidecar()` while the stop flag was still set, so the "recovery" spawn was a no-op and the backend stayed dead for the session → `allow_respawn()` first (`src-tauri/src/updater_feed.rs`).
- **Audit correction:** the 2026-10-12 audit's finding C2 ("no session revocation") was incorrect — the worker keeps stateful sessions in D1 with `revoked_at` enforcement, logout, per-session and global revoke routes (verified in `cloud/worker/src/auth.ts` and `index.ts`).

## Mission 3 closeout (2026-10-13, session 2)

**No production code was changed in either repository in this session.** The Vpn_app tree is untouched except for these report files; the Abystral Phase 6 working tree (48 files) is the owner's uncommitted WIP and was neither modified nor committed.

- **R10 — pre-existing test defect (Abystral, documented, NOT fixed here):** `workers/src/telegram/tests/admin-api.test.ts:707` ("subscription.extend … extends to an exact end date") fails with 400 instead of 200. The fixture anchors the subscription expiry at `now + 9 days` (≈ 2026-10-22 UTC) while the test hardcodes `to_date: '2026-10-15'` — a date the wall clock passed around 2026-10-06. The production guard correctly rejects a `to_date` at/before the current expiry, and the logic is byte-identical at baseline `5343e1b` (no extend/to_date hunks in the Phase 6 diff), so this is a stale test constant, not a regression and not a security gap. Full suite impact: 3328/3329 pass. Fix (test-only, for the Abystral owner): derive the test's `to_date` from the anchored fixture (e.g. fixture expiry + 2 days) instead of a hardcoded date.
- **Temp probe patch (not repo code):** the session's live adversarial probe (`%TEMP%\netpulse-phase3\adversarial.mjs`) initially crashed on this host's transient DNS (`ENOENT`) because its curl-fallback pattern did not cover it; the pattern was extended to include `ENOENT|ENOTFOUND|EAI_AGAIN`. The file lives in the temp directory, outside both repositories.
- **No test was deleted, weakened, or re-scoped in either repo.** No security assertion was relaxed.

## Change review

- Diff is additive: 3 files in 7c2a9d9 (+583/−12), 20 files in 578b6d7 (+2029/−38), plus the R3/R4 fixes. No formatting-only churn, no unrelated rewrites.
- No secrets, personal data, or production configuration were added. `.staging-dist/` contains no credentials (worker bundle).
- No test was removed or weakened anywhere in the audit.
