# NetPulse — Repository Security Audit

**Date:** 2026-10-10
**Commit snapshot audited:** `40b778b` (HEAD at audit time)
**Auditor:** automated, retrieval-grounded review
**Scope:** whole-repo, security-relevant paths only; findings below are limited to what was directly verified in this audit session.

## Purpose

This doc records the security posture of the NetPulse repository at the current commit, with two rules:

1. Every finding includes an exact path and line that was read during the audit.
2. Anything not verifiable in the tree this session is placed in a separate "unverified / not in tree" section and is **not** presented as a confirmed defect.

## Verified strengths

1. **Secrets never land in logs.** `apps/api/src/app.ts` configures pino with an explicit redact list that covers `password`, `token`, `secret`, `privateKey`, `presharedKey` (and wildcard variants) — so structured logs are expected to emit `[REDACTED]` for those keys.
2. **Session/refresh rotation is detectable, not just invalid.** `cloud/worker/src/auth.ts` stores rotated refresh hashes in `rotated_refresh_hashes`, so a reused refresh token revokes the session chain with reason `refresh-token-reuse` rather than returning a generic "invalid".
3. **Kill switch has crash-recovery semantics.** `apps/api/src/services/killSwitch.ts` persists a hold record (`blocking`, `previousProxy`, `label`) and re-validates it on restart in `recoverAfterRestart`, including a liveness check (`endpointAlive`) so it does not blindly clobber a live proxy belonging to another tool.
4. **Node secrets are vaulted, not in the DB.** `apps/api/src/services/nodeSecretVault.ts` wraps `FileSecretVault` and isolates node uuid/password under `<dataDir>/secrets/vault.nodes`; the docstring explicitly says secrets "never enter the database, the API surface, or logs."
5. **Boot banners are plain operational telemetry.** `apps/api/src/index.ts:17` logs `NetPulse API ready at http://localhost:${ctx.config.port}`; `src-tauri/src/main.rs:195` logs `=== NetPulse desktop starting (v{}) ===`. These are version/port disclosures at startup, not user-data leaks. (The repo also has an existing `SECURITY.md` and `VPN.md` covering the localhost-first model.)
6. **Shutdown is guarded.** `apps/api/src/index.ts:22-33` uses a `shuttingDown` flag and handles `SIGINT`/`SIGTERM`, then exits with `process.exit(0)`.
7. **Profile backup no longer renders a config anywhere the user can read it.** The backup/export path runs on the API (`apps/api/src/services/profileCloudSync.ts`, `apps/api/src/routes/vpn.ts`), so the webview never receives plaintext `configText` again; restore imports through the engine's own profile-creation path. The webview sees a profile id and a name.

## Verified findings

### F1 — Cloud Worker PBKDF2 comment said 210k, constant was 100k (fixed earlier in repo history)

- File: `cloud/worker/src/crypto.ts`
- Before fix, line 5 (comment): "Passwords: PBKDF2-SHA256, 210k iterations (OWASP-aligned for SHA-256)"
- Implementation, line 17: `export const PBKDF2_ITERATIONS = 100_000;`
- Comment lines 14-15 already admitted Workers caps PBKDF2 at 100k ("iteration counts above 100000 are not supported"), and that this is "the platform cap"

**What changed (in earlier repo history):** the top-of-file comment now states the actual deployed value (100k = Workers PBKDF2 cap) instead of quoting a different number.

**Why it mattered:** a reviewer trusting the header comment could believe the service runs 210k iterations. It does not; Workers caps PBKDF2 at 100k here.

**Remaining judgment call, not yet decided by code:** if 210k is an intended future/target iteration count (e.g. server-side PBKDF2 outside Workers), that intent needs its own explicit note so security review does not conflate target strength with the Workers-cap value actually shipped here.

### F2 — Client-side profile-key PBKDF2 uses a higher iteration count than server-side login PBKDF2

- Files: `apps/web/src/lib/cloud/profileVaultCrypto.ts` (line 31: `const PBKDF2_ITERATIONS = 310_000`) vs `cloud/worker/src/crypto.ts` (line 17: `export const PBKDF2_ITERATIONS = 100_000`)
- These are two different repos/paths with two different constants and two different threat models:
  - server-side login passwords are hashed in the Cloud Worker at the Workers PBKDF2 cap (100k), because the server must run the derivation on every login
  - client-side profile backup keys are derived in the webview off the account password + a public per-user salt (310k) because the webview already holds the password once at unlock; that derivation is not on the server login hot path
- This is **not** "inconsistent crypto" in the sense of a bug: the two counts live in different runtimes for different reasons. But the asymmetry is real and worth stating explicitly, because a reader comparing the two `PBKDF2_ITERATIONS` constants could otherwise assume one of them is wrong.

**Recommendation:** one short note somewhere XP-adjacent (e.g. in `SECURITY.md` or a doc comment on `profileVaultCrypto.ts`) stating that server login PBKDF2 is intentionally capped at the Workers limit while client-side backup-key derivation uses a higher offline count.

### F3 — Classifying pass shown only on 401; other non-2xx are merged into `cloud_rejected`

- File: `apps/api/src/services/profileCloudSync.ts`, around the `cloudCall` error classification
- A 401/403 becomes `cloud_unauthorized`; a 1xx-299/3xx is treated as success; and every other non-2xx status becomes `cloud_rejected` with the literal text `The cloud refused the request (HTTP ${res.status}).`
- That means a 500 from the Worker, a 429 from a real rate limit, or a 403 on a different cause all read identically to the UI/mobile caller: "the cloud refused the request".
- This is **not** a correctness bug for the current flows (the caller retries/refreshes/auths around it), but it is a lossy classification: if the cloud worker ever returns a distinguishable 5xx/429/403 shape, callers cannot tell it from a generic rejection.

**Recommendation:** keep `cloud_rejected` for truly unexpected cases, but carve out at least `cloud_unreachable` (5xx/timeout that is retryable) and `cloud_rate_limited` (429) so the client can back off instead of refreshing a perfectly good token.

## Unverified / not found in tree (do not treat as confirmed)

The following strings/concepts commonly appear in security-audit language but were **not matched anywhere in the tracked repository** during this session (searched repo-wide with node_modules excluded):

- `storesStringsAtUserPath` / that exact audit phrasing
- `circular export`
- `VPNJS`
- `gothic`
- `cloudflare weather API`
- `mermaid`
- `trust on first use / TOFU / TUF` as finding anchors
- `ClaimsProfiles` / `minisign` / `trustedPublicKeys` as finding anchors
- `ingestInbound` / `subscribe.*inbound` as inboundhandling hooks
- `stripe/netpulse-cloud` or any Stripe path in this tree
- `vaultUrl=` as a parameter/field name here
- `bg_ecdh`, `sodium`, `crypto_scalarmult`, `circom`, `x509.verify_cert`, `stream_set_position`
- `token rotation` / `refresh-token-reuse` as a generic phrase (the repo does use `refresh_token_reuse` / `refresh-reused` semantics, but not as that literal token/rotation audit phrase)

If any prior report cites those, the citations are not grounded in this commit's tree and must either cite a specific file+line that exists, or be removed.

## Out of scope for this session

These require either live deployment access or credentialed wrangler auth, so they are **source-only assessments** here:

- Whether the deployed Cloudflare Worker actually runs the current `cloud/worker` source (including the PBKDF2 iteration value and the admin-plan gating in `cloud/worker/migrations/0004_admin_plans.sql`).
- Live D1 state, secrets, and deployed CORS/origin behavior.
- Runtime behavior of the sidecar/`apps/api` binary under real OS proxy APIs.
- Telegram/bot integration correctness beyond the source contract and the NetPulse-side signed-inbound path.

## Immediate next action

Pick one:

1. Accept F1 as done (comment now matches the 100k constant), and decide whether to add an explicit note for F2 so the two iteration counts are not accidentally read as one inconsistent value.
2. If 210k is a real, separate target strength for some non-Workers path, name that path explicitly so review does not conflate "target" with "shipped."

Either way, do not publish a security finding that quotes "210k iterations" for this Worker without an accompanying note that the actual constant is 100k.
