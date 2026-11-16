# ULTIMATE REMOVAL CHANGELOG

**Audit date:** 2026-11-16. Every change made to the repository during this audit, with before/after and verification. No user work was overwritten; edits were surgical. No commit was made.

---

## A. Code changes (4 files, all repairs — no deletions)

### A1. `src-tauri/src/network_intelligence/diagnosis.rs`

**Change 1 — removed stale `LocalInterface` catch-all binding.**
- Before: `InterfaceCheck => match h { LocalInterface => 0.97, Gateway => 0.25, _ => 0.05 }`. `LocalInterface` was removed from the `Hypothesis` enum by the in-progress refactor but the arm remained; Rust parsed it as an irrefutable binding, so **all 19 hypotheses** got `0.97` and the `Gateway`/`_` arms were unreachable (compiler: `unreachable pattern` ×2, `unused variable`, `non_snake_case`).
- After: `InterfaceCheck => match h { Gateway => 0.25, _ => 0.05 }`.
- Verification: compiler warnings gone; `interface_check_failure_is_not_uniformly_shared` passes.

**Change 2 — fixed correlation-window reset ordering.**
- Before: `self.previous_timestamp = Some(result.timestamp)` executed **before** the gap check `result.timestamp.saturating_sub(prev) > CORRELATION_WINDOW_MS`, so the gap was always 0 and `observation_history.clear()` never ran.
- After: capture `previous` first, use it for the gap check, then assign `previous_timestamp`.
- Verification: `long_gap_starts_a_fresh_correlation_window` passes.

**Change 3 — added 2 regression tests** (the two named above).

### A2. `src-tauri/src/network_intelligence/persistence.rs`

**Change — serialization failures no longer write empty files.**
- Before: 3 × `serde_json::to_string(...).unwrap_or_default()` → empty JSONL line / empty `model_state.json` atomically renamed over good state.
- After: `map_err(|e| std::io::Error::new(InvalidData, e))?` — the write aborts and the previous good file is preserved.
- Verification: full Rust suite 529 passed.

### A3. `apps/api/src/vpn/keychain.ts`

**Change 1 — vault key ACL grants `(F)` not `(R)`.**
- Before: `icacls ... /grant:r "%USERNAME%:(R)"` → read-only, which on Windows also denies DELETE and overwrite, so key rotation and vault deletion failed with `EPERM` and the plaintext key survived the Credential-Manager migration.
- After: `/grant:r "%USERNAME%:(F)"` (still `/inheritance:r`, so Everyone/SYSTEM/inherited removed — the "current user only" goal is preserved).
- Verification: 5 vault test files, 74 tests pass.

**Change 2 — added `removeKeyFile()` helper** that grants `(F)` before unlinking, for pre-existing files written under the old `(R)` ACL. `FileKeyStore.delete()` now uses it.

### A4. `apps/api/src/vpn/vpnService.ts`

**Change — migration cleanup uses `removeKeyFile()`.**
- Before: `fs.rmSync(this.legacyKeyFile(), { force: true })` inside try/catch — silently failed under `(R)` ACL, leaving the plaintext key.
- After: `removeKeyFile(this.legacyKeyFile())`.
- Verification: `vaultKeychain` migration test passes.

### A5. `apps/web/src/features/copilot/CopilotPage.tsx`, `apps/web/src/features/nani/NaniPage.tsx`

**Change — replaced sub-12px arbitrary font sizes with scale tokens.**
- Before: `text-[10px]` ×2, `text-[11px]` ×1 (below the project's 12px accessibility floor).
- After: `text-micro` (12px), `text-mini` (13px).
- Verification: `typeScale.test.ts` 10/10 passes; full web suite 502/502.

## B. Reports created (new files only — no existing report modified)

`reports/ULTIMATE_BASELINE_AND_PRESERVATION_REPORT.md`, `ULTIMATE_REPOSITORY_ARCHITECTURE.md`, `ULTIMATE_SOURCE_INVENTORY.json`, `ULTIMATE_DEPENDENCY_MAP.md`, `ULTIMATE_FAKE_FUNCTION_AUDIT.md`, `ULTIMATE_CORRUPTION_AUDIT.md`, `ULTIMATE_LEGACY_REMOVAL_PLAN.md`, `ULTIMATE_REMOVAL_CHANGELOG.md` (this file), `ULTIMATE_VPN_ENGINE_AUDIT.md`, `ULTIMATE_NANI_AUDIT.md`, `ULTIMATE_MATHEMATICAL_AUDIT.md`, `ULTIMATE_FRONTEND_AUDIT.md`, `ULTIMATE_PERSISTENCE_AUDIT.md`, `ULTIMATE_INTEGRATION_AUDIT.md`, `ULTIMATE_SECURITY_AUDIT.md`, `ULTIMATE_WINDOWS_VERIFICATION.md`, `ULTIMATE_TEST_AND_REGRESSION_REPORT.md`, `ULTIMATE_PERFORMANCE_REPORT.md`, `ULTIMATE_ROADMAP_RECONSTRUCTION.md`, `ULTIMATE_FINAL_ENGINEERING_REPORT.md`, plus `ROADMAP.md`.

## C. Explicitly NOT done
- No code deleted. No `git reset`/`clean`/destructive checkout. No commit.
- No existing report overwritten (all `NANI_*`, `V3_*`, `reports/NANI_*` preserved).
- No secret read/rotated; no deploy; no `reg.exe` bypass attempt.
- No math or VPN engine semantics changed (those require product decisions).

## D. Test deltas
| Suite | Before | After |
|---|---|---|
| Rust | 527 pass / 0 fail | **529 pass / 0 fail** (+2 regression tests) |
| shared TS | 212 pass | 212 pass |
| web TS | 500 / 502 (2 fail) | **502 / 502** |
| api TS | 1236 / 1264 (28 fail) | **1252 / 1264** (12 fail, all `reg.exe` sandbox-blocked) |
