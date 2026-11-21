# 08 — SECURITY AUDIT

**Posture:** defensive, repository-local review only. No external systems, real accounts, payment providers or production credentials were touched. No secrets are reproduced in this report.
**Sources:** `apps/api/src/**`, `src-tauri/src/**`, `apps/web/src/lib/cloud/**`, `cloud/worker/src/**`, `scripts/**`, `src-tauri/tauri.conf.json`.
**Method:** Specialist audit (SEC-DD-* IDs) + personal verification of every P2 candidate + minimal, test-covered repairs. All commands ran inside the local workspace.

## Confirmed correct (with evidence)

| Control | Evidence | Verdict |
|---|---|---|
| Sidecar session auth | `apps/api/src/auth.ts` per-launch secret + loopback binding; daemon token persisted at `DATA_DIR/daemon-token` with shell-injected per-launch secret in desktop mode | Correct |
| Elevation broker | `apps/api/src/vpn/elevationBroker.ts:100-190` allow-listed exe, nonce, staged-config hash re-read at fetch; `src-tauri/src/elevation.rs:155-210` independently re-validates action/exe/args/path and SHA-256 before `ShellExecuteExW` | Correct (SEC-DD-003 rejected — see §"Rejected claims") |
| WireGuard config import | `hasWgScriptDirectives` (`vpnService.ts:409-411`) rejects PostUp/PostDown/PreUp/PreDown/SaveConfig; API test `vpnImportHardening.test.ts` exercises the 400 path | Correct |
| sing-box config import | `BLOCKED_OUTBOUND_FIELDS` (`vpnService.ts:1248-1264`) rejects `exec`, `exec_internal`, `script`, `inbounds`, `outbounds`; control-char guard tested | Correct |
| Update verification | `scripts/update-feed.mjs:129-264` verifies archive contents, STORED method, minisign signature against the app's baked pubkey, key id, and global comment signature; optional Authenticode gate via `NETPULSE_REQUIRE_TRUSTED_SIGNATURE` | Correct |
| Log redaction | `apps/api/src/util/redact.ts`, `src-tauri/src/logging.rs` — `test/redact.test.ts` (5) passes | Correct |
| Webview navigation | Document-level external-URL guard + Rust navigation command; real-webview backstop test exists (ignored by default, CI job runs it) | Correct (not re-run live here) |
| Entitlement enforcement | Server-side provision gate (`cloud/worker/src/index.ts`) + VPS reconciler (`vpn-users.ts`), both fail-closed; client-writable state cannot grant premium (DD-018) | Correct |
| Secret storage | `apps/web/src/lib/cloud/secureStore.ts` desktop path uses `secret_protect` IPC (DPAPI) with a marker; concurrent session changed the failure path to fail-closed (plaintext removed, memory-only) — preserved untouched | Correct after concurrent fix |

## Repairs made in this pass

### DD-033 / SEC-DD-001 (P2) — non-admin could select the admin AI role

`cloud/worker/src/index.ts:1239-1277` (`/api/v1/ai/ask`) and `:1280-1315` (`/ai/stream`) took `role` from the JSON body, accepted `admin` from any caller, defaulted to `admin`, and forwarded it to an **admin-only** upstream (`/admin/ai`) together with `x-admin-secret` and the caller's id in `x-ai-admin-telegram-id`. Any authenticated non-admin could ask the Copilot to act as an administrator — a trust-boundary crossing even if the upstream also checks the Telegram id.

**Fix:** added exported `resolveAiRole(requested, callerRole)` (`index.ts:146-166`); both routes now query the verified session's D1 row (`SELECT role FROM users WHERE id = ?`) and derive the role. Non-admins asking for `admin`/`developer` are downgraded to `support`; `support`/`diagnostics` remain usable; admins keep their requested role. An unknown/missing value defaults to `admin` only for a verified admin.

**Regression:** `cloud/worker/test/aiRole.test.ts` — 4 tests covering downgrade, non-admin default, admin retention, and non-privileged roles. **Result:** 4 passed / 0 failed. No upstream was contacted.

### DD-034 / SEC-DD-002 (P2) — OpenVPN config allowed command execution

`OpenVpnProvider.importProfile` (`apps/api/src/vpn/vpnService.ts:824+`) accepted any text matching `<ca>` or `remote`. OpenVPN applies `script-security`, `up`/`down` hooks, `plugin`, `writepid`, `log-append`, `management` and `config` (include) directives from that file; connecting ran attacker-chosen commands with the app user's privileges. WireGuard already had an equivalent import-time guard, so this was an inconsistent gap, not a design choice.

**Fix:** exported `openVpnUnsafeDirective(text)` (`vpnService.ts:413-444`) with a denylist of side-effecting directives; skips comments and inline `<...>` PEM/credential blocks; accepts `--`-prefixed long options. Wired into `importProfile` at `:867-871` so rejection happens at import with `400 invalid_config`. **Regression:** `apps/api/test/vpnImportHardening.test.ts` extended to 15 tests (pure guard cases, API 400, clean-profile no-overreach). **Mutation:** removing the import guard makes the HTTP test fail with `expected 201 to be 400`. **Result:** 15 passed / 0 failed.

### DD-011 (P3) — concurrent-session fix preserved

`secureStore.ts` previously wrote a refresh token in plaintext when `secret_protect` failed. The working tree now contains a fail-closed catch (`safeRemove(key)` + one-shot warning), with `apps/web/test/secureStoreFailClosed.test.ts` added by that session. I did not modify either file; they are recorded as concurrent work in the register.

## Rejected claims (no change)

- **SEC-DD-003 (nonce not bound to config bytes):** rejected. The descriptor carries `configSha256`, `fetchForBridge` re-hashes the file at fetch time (`elevationBroker.ts:165-176`), and Rust re-reads and verifies SHA-256 immediately before launch (`elevation.rs:206-210`). The nonce binds the UI↔bridge↔result chain; the hash binds the bytes. Both controls are present.
- **SEC-DD-004 (DPAPI downgrade):** factually stale at current working-tree state — the fail-closed catch is present (see above).
- **SEC-DD-005 (AI `x-ai-admin-telegram-id` naming):** naming wart preserved; the value is the verified user's id from the session, not client-supplied. Covered by DD-033's role derivation.

## Remaining / unverified

- `src-tauri/tauri.conf.json:62` `dangerousInsecureTransportProtocol: true` (DD-008, P4) is required for the loopback local feed; release stamping uses HTTPS. Left open with documented rationale.
- `cloud/worker/src/auth.ts:242-257` D1 rate-limit INSERT-then-read-back is not atomic (DD-013, P4), fail-open under concurrency. Local fixture testing only; no production change.
- `cloud/worker/src/vpn-users.ts:53-71` concurrent provision can transiently hand out the losing credential (DD-012, P3), self-healing on next provision; no production mutation attempted.
- No dependency-vulnerability scan (`npm audit`) was run; no webview CSP/browser security test was executed in a live engine.
- Secrets were never printed; all fixtures used synthetic values (`vpn.example.com`, `203.0.113.x`).

**Verdict:** two real P2 security defects were found and fixed with mutation-verified regressions. No P0 was found. Residual items are P3/P4 with explicit rationale.
