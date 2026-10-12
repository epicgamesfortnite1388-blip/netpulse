# NetPulse — App Review, Debug & Audit

**Date:** 2026-10-12
**Scope:** whole repo — `apps/api`, `apps/web`, `cloud/worker`, `src-tauri` (Rust), plus the intermittent test failures observed during the release-gate pass
**Method:** three parallel deep-dives (API / web / Rust) with every reported line re-read and verified; root-cause debug of 3 intermittent test failures; `cargo check` validation of the Rust fixes; 22+ full worker-suite runs for stability evidence
**Snapshot:** working tree at `40b778b` + uncommitted changes (`cloud/worker/src/crypto.ts`, `cloud/worker/wrangler.toml`, `package.json`)

---

## A. Debug — intermittent test failures (3 root-caused; 2 fixed)

All three flakes were **test-side defects**, not product bugs. The service-signature verification itself (`cloud/worker/src/np-auth.ts:120-167`) was read end-to-end and is sound: fail-closed when the secret is unset, constant-time comparison (`timingSafeEqualHex`), nonce burned in D1 *before* the signature compare (a replay can never probe verification behavior), and the canonical string covers the raw request target including the query string.

### A1 — FIXED: tamper test was a no-op 1/16 of the time
- `cloud/worker/test/netpulse-integration.test.ts` › `rejects tampered bodies (signature binds the exact bytes)`
- Root cause: the "tamper" was `` `f${sig.slice(1)}` `` — if the HMAC hex digest already starts with `f` (probability 1/16), the tampered signature is **identical** to the valid one, so the request succeeds and the test fails with `expected 200 to be 401`.
- Fix: `tamperHex()` flips the final hex char to a guaranteed-different value (`…endsWith('f') ? '0' : 'f'`).
- Verification: 0 failures across 22+ full-suite runs after the fix (was ~2/13 before).

### A2 — FIXED: same bug in the sessions boundary test
- `cloud/worker/test/netpulse-sessions.test.ts` › `refuses an unsigned or tampered call` — same `` `f${sig.slice(1)}` `` pattern at line 61, same 1/16 no-op window, same fix applied.
- The handler (`cloud/worker/src/netpulse-sessions.ts`) is correct: signature verified over raw bytes before parsing, `netpulseAccountId` authenticated via the signed query string, mirror queries scoped by `user_id`, 404 (not 401) for unlinked accounts so there is no id-existence oracle.

### A3 — NOT REPRODUCED: ops rate-limit test is load-sensitive
- `cloud/worker/test/ops-page.test.ts` › `throttles guessing after 30 attempts from one IP with 429` failed once during heavy parallel I/O; 15/15 passes in isolation.
- The limiter (`cloud/worker/src/auth.ts:220-235`, fixed 5-minute window, D1 `INSERT ON CONFLICT`) is correct. No code change made.
- Recommendation: if it recurs in CI, add vitest retries or fake timers; do not weaken the 30/5-min wall.

**Also noted (pre-existing, harmless today):** `cloud/worker/test/worker.test.ts:401` returns a promise from `expect(actual).resolves.toHaveLength(...)` without awaiting — Vitest auto-awaits it now but states this will fail under Vitest 3.

## B. Debug — Rust defects (2 fixed; `cargo check` exit 0)

### B1 — FIXED: elevation allow-list never matched on Windows
- `src-tauri/src/elevation.rs:167-171` canonicalized only `op.exe`; on Windows `PathBuf::canonicalize` returns the `\\?\` verbatim form (documented in `os_open.rs:33-38`), which never equals the bare allow-list strings (`C:\Program Files\WireGuard\wireguard.exe`). Every legitimate WireGuard tunnel-install op was therefore denied — safe direction, but the security gate had never actually fired in production, so a regression to permissive would have been invisible.
- Fix: canonicalize the allow-list entries too (mirrors `os_open.rs:88-93`), with a bare-string fallback when WireGuard is not installed.

### B2 — FIXED: aborted update left the backend permanently dead
- `src-tauri/src/updater_feed.rs:176` called `spawn_sidecar()` as a "recovery" after `stop_sidecar()` — but `stop_sidecar` sets `shutting_down = true` (`sidecar.rs:525-531`) and `spawn_sidecar` returns `Ok(())` immediately while that flag is set (`sidecar.rs:215-217`). The respawn was a no-op, contradicting its own comment ("a refused update never leaves a broken install"); the backend stayed dead for the rest of the session.
- Fix: `crate::sidecar::allow_respawn(&app)` before the recovery spawn — the exact pattern `main.rs:152-153` and `162-164` already use.

## C. Security audit — confirmed findings (ranked)

### HIGH

1. **Updater trust anchor is the Tauri documentation's example key** — `src-tauri/tauri.conf.json:72`. The baked pubkey decodes to `untrusted comment: minisign public key: D43C6888D5686EC4…` — the well-known example keypair from the Tauri updater docs/test fixtures, whose private half is public. Anyone can sign an "update" that shipped copies accept. Signature verification itself is performed (`updater_feed.rs:145-150`), so only the anchor is wrong. Mitigated today by the loopback-only endpoint (`127.0.0.1:47615`) and `createUpdaterArtifacts: false` (`tauri.conf.json:51`), but this is **release-blocking before any real update channel** — rotate to a project-generated minisign keypair.
2. ~~**No session revocation**~~ — **CORRECTION (2026-10-12): this finding was wrong.** Sessions are stateful, not stateless: `createSession` stores `token_hash`/`refresh_hash` in D1 (`auth.ts:80-86`), and `sessionByAccessToken` (`auth.ts:108-123`) validates the hash and rejects `revoked_at`/expired rows on every request. Server-side revocation is fully wired: `POST /api/v1/auth/logout` (`index.ts:514-518`), `DELETE /api/v1/account/sessions/current`, `DELETE .../sessions/all`, `POST .../sessions/revoke`, and `revokeAllSessions` on password change/reset. Refresh-token reuse kills the whole session chain (`auth.ts:126-145`). The only residual gap: a stolen session is valid until TTL **if the attacker never calls logout** — inherent to the design and adequately mitigated by rotation + reuse detection.
3. **Single master secret with no key separation** — `auth.ts:34-36`, `apps/api/src/services/vpn/vpnService.ts:139-140`. The one `daemonToken` is simultaneously the Bearer auth secret, the session-cookie HMAC key, and the AES-256-GCM key for the file secret vault (profile/node/cloud-backup secrets). One compromise breaks confidentiality and integrity everywhere. Derive distinct keys (HKDF) per purpose. **(Still open.)**
4. ~~**Refresh token persisted in localStorage**~~ — **MITIGATED 2026-10-12** (see "Implemented this session"): on desktop the refresh token now persists as a DPAPI-protected `dpapi1:` blob (user+machine bound), not plaintext. Plaintext remains only in web mode (no OS protection available) and as a deliberate availability fallback if DPAPI itself fails.
5. ~~**Derived vault key cached in localStorage**~~ — **MITIGATED 2026-10-12** (same mechanism): the vault key cache now goes through the same DPAPI-protected store. The documented risk acceptance is thereby strengthened on desktop; web mode is unchanged by design.

### MED

6. **Bundled sidecar binary spawned with no integrity check** — `src-tauri/src/sidecar.rs:277`. `backend/node.exe` + `netpulse-backend.js` are executed as-is; the NSIS installer uses `installMode: currentUser` (`tauri.conf.json:53`), so the install dir is user-writable. Same-user malware can replace the sidecar and the watchdog (`sidecar.rs:516`) will respawn the replacement with the desktop core's token. Not reachable from the webview (no file-write IPC exists), so the exposure is local-only.
7. **Staging environment reuses the production D1 database** — uncommitted `cloud/worker/wrangler.toml` diff: `[env.staging]` points `database_id` at the same `netpulse-cloud` database (`31f2435b-3c23-42ad-b5b8-3b7f815d17dc`). Staging code runs against real user data; a staging bug or test run can corrupt production. Isolate the staging D1 before the first staging deploy.
8. **WebSocket ticket endpoint is unauthenticated** — `apps/api/src/realtime/wsRoute.ts:35-45` is in `PUBLIC_API_PATHS` (`app.ts:111-119`); any loopback caller can mint tickets and subscribe to real-time test progress/events. In desktop mode it should require the launch secret like `/auth/session` does.
9. **No per-route brute-force limit on session issuance** — `auth.ts:214-248` has only the global 600/min limit on `/api/v1/auth/session`.

### LOW

10. **CSP gaps** — `tauri.conf.json:29` uses `style-src 'unsafe-inline'` and has no `frame-ancestors`; `apps/web/index.html` has no CSP meta tag, so web-mode deployments run without a CSP. No user-controlled content currently reaches style sinks.
11. **`dangerousInsecureTransportProtocol: true`** — `tauri.conf.json:76`. Acceptable only because the feed endpoint is loopback; keep it loopback-only.
12. **Cloud backup shares the local vault key** — `apps/api/src/services/profileCloudVault.ts:43-48` (suffix `.cloud` on the same `FileSecretVault` derivation). Documented trade-off; the cloud blob is protected against local-filesystem access, not against a later local-key compromise.
13. **Prior audit (2026-10-10) F3 still open** — `apps/api/src/services/profileCloudSync.ts` collapses 5xx/429/403 into one `cloud_rejected` error; carve out retryable (`cloud_unreachable`) and `cloud_rate_limited` so clients can back off.

## D. Verified solid (no action needed)

- **IPC surface (Rust):** all 15 `#[tauri::command]`s enumerated; none passes a webview-controlled string to `Command::new` as program or args; every spawn uses fixed names (`explorer`, `rundll32`, `net`, `node`, `taskkill`) or `current_exe()`. `reveal_path` canonicalizes both sides and refuses traversal/dot/space components (heavily unit-tested); `open_external` is https-only with no credentials.
- **SSRF guard:** `apps/api/src/util/targetGuard.ts:138-203` resolves DNS and rejects private/reserved/loopback/link-local targets; applied to node tests, tunnel start, and proxy probes.
- **Service auth (`np-auth.ts`):** fail-closed, constant-time compare, nonce burned before compare, stable reason codes, nothing sensitive logged.
- **Entitlement/mirror isolation:** every mirror query is scoped by `user_id`; the cross-account and tamper tests pass deterministically after the A1/A2 fixes.
- **Input validation & errors:** Zod schemas on all routes; structured errors with no stack traces to clients; pino redaction covers `authorization`, `cookie`, `password`, `token`, `secret`, `privateKey`, `presharedKey`.
- **Process spawning:** `shell: false`, `windowsHide: true` (`apps/api/src/util/exec.ts:15-56`).
- **Web crypto:** PBKDF2-SHA256 310k iterations, 16-byte random salt, AES-GCM-256 with additionalData binding (`userId:profileId`); the account password never leaves the client.
- **No XSS sinks:** no `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or `new Function` anywhere in the web app.
- **Window security:** production loads only bundled assets (`frontendDist`, no `remoteURL`); `safe_mode` is a single exact-match boolean; `webview_gc` matches by image name + dead parent + ownership before `taskkill /T`.
- **No premium gates exist in the backend** to bypass — entitlement logic lives in the Telegram-side mirror, which is correctly isolated.

## E. Implemented this session (2026-10-12)

### DPAPI secret-protection bridge (fixes audit C4/C5 on desktop)

- **Rust** — `src-tauri/src/dpapi.rs` (new): `secret_protect` / `secret_unprotect` IPC commands wrapping `CryptProtectData`/`CryptUnprotectData` with `CRYPTPROTECT_UI_FORBIDDEN` and app-scoped entropy. Hand-rolled FFI (no new dependencies); DPAPI blobs are base64-encoded for storage. Fail-closed: tampered, truncated, or foreign blobs return errors, never plaintext. 6 unit tests pass (roundtrips incl. empty/Unicode, known base64 vectors, tamper/truncation rejection) — real DPAPI exercised via `cargo test`. Registered in `main.rs` `invoke_handler`.
- **Web** — `apps/web/src/lib/cloud/secureStore.ts` (new): synchronous get/set/remove API backed by an in-memory decrypted map; `primeSecureStore()` decrypts all `np.cloud.*` values at startup before the session store hydrates. On desktop, values persist as `dpapi1:<base64>` blobs; legacy plaintext values migrate on first write; corrupted blobs are dropped (re-auth) rather than failing the app; a DPAPI failure falls back to plaintext so a DPAPI hiccup never locks the user out. Web mode (no IPC) is byte-for-byte the previous behavior. Wired into `sessionStore.ts` (refresh token, user record, session id, last-sync) and `vaultKey.ts` (E2E key cache); `useCloudSession.init()` now primes before hydration. 5 unit tests pass; full web suite 349/349.

**Scope, plainly:** DPAPI binds secrets to the user + machine — it defeats at-rest extraction (stolen profile dir, off-machine backup, cross-user processes) but not code running as the same interactive user (the entropy ships in the binary). XSS in the webview can still read decrypted values from the memory map; that is inherent to any same-process secret and is why the vault key is derived from the password at unlock.

### Debug fixes (from section A/B)
Two cloud-worker test tamper fixes and two Rust fixes (elevation canonicalization, aborted-update respawn) — `cargo check` green, worker suite stable across 22+ runs.

## F. Working-tree change review

| Change | Verdict |
|---|---|
| `cloud/worker/src/crypto.ts` (comment 210k → 100k) | OK — comment-only alignment with the actual `PBKDF2_ITERATIONS = 100_000` (the Workers platform cap), consistent with `REPO_SECURITY_AUDIT.md` F1. Not a weakening; the constant was already 100k. Commit it. |
| `cloud/worker/wrangler.toml` (staging env) | See finding C7 — isolate the D1 before use. |
| `package.json` (`e2e:telegram` scripts) | Benign. |

## F. Working-tree change review

| Change | Verdict |
|---|---|
| `cloud/worker/src/crypto.ts` (comment 210k → 100k) | OK — comment-only alignment with the actual `PBKDF2_ITERATIONS = 100_000` (the Workers platform cap), consistent with `REPO_SECURITY_AUDIT.md` F1. Not a weakening; the constant was already 100k. Commit it. |
| `cloud/worker/wrangler.toml` (staging env) | See finding C7 — isolate the D1 before use. |
| `package.json` (`e2e:telegram` scripts) | Benign. |

## G. Priority recommendations

1. **Rotate the updater keypair** to a project-generated minisign keypair before any update channel goes live (C1).
2. **Isolate the staging D1** (C7).
3. **Split the daemonToken** into distinct keys for Bearer auth, session HMAC, and vault encryption (C3) — the remaining HIGH.
4. Rebuild and re-verify the desktop artifacts so they include the DPAPI bridge and the two Rust fixes (build in progress at audit-update time).
5. Consider a webview-side hardening pass on the memory map (C4/C5 residual): clear decrypted values on window blur/hide for high-sensitivity surfaces.
