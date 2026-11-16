# ULTIMATE SECURITY AUDIT

**Audit date:** 2026-11-16 · No secret values were read, printed, rotated, or committed. Credential-bearing files (`cloud/worker/.ops-token.local`, `.vps-sync-token.local`, `certs/netpulse-release.pfx`) were referenced by location only. **[V]** verified · **[A]** analysis · **[?]** assumption.

---

## 1. Verified strengths

**Secrets handling.**
- Sidecar daemon token: 32-byte CSPRNG, passed via **stdin** (not argv), never written to disk, delivered to webview only through typed `bootstrap` (`sidecar.rs:41-46,113-117,286-294`; `main.rs:61-75,91-127`). **[V]**
- DPAPI bridge exposes only protect/unprotect; entropy is documented non-secret and app-scoped (`dpapi.rs:61-65,207-219`). At-rest protection is user+machine binding; no generic encrypt/decrypt surface. `unsafe` is scoped Win32 FFI, fail-closed on tampered blobs (`:263-274`). **[V]**

**IPC / Tauri boundary.**
- Capabilities minimal: no shell/fs/http plugins; only dialog/updater/window/event for window `main` (`capabilities/default.json:4-18`). **[V]**
- CSP `script-src 'self'`, no `unsafe-eval`; `connect-src` limited to self/IPC/loopback (`tauri.conf.json:14-16`). Frontend is bundled assets. **[V]**
- All 41 commands explicit in `generate_handler!`. **[V]**

**Process execution / injection.**
- Elevation accepts exactly one action, exact executable allow-list via canonicalization, exact 2-arg shape, config path absolute/`.conf`/inside data dir, SHA-256 re-verified to defeat TOCTOU; `ShellExecuteExW` with `runas`, no shell (`elevation.rs:53-58,154-215,290-325,480-552`). **[V]**
- Node subprocess injection structurally prevented: `shell:false`, arg arrays, hard timeout, `windowsHide` (`util/exec.ts:12-19`). `explorer`/`open`/`xdg-open` reveal uses allow-list + `canonicalize().starts_with(...)` (`os_open.rs:47-94,149-170`). **[V]**
- SSRF guard: target charset + private/reserved IPv4/IPv6 blocklists (`util/targetGuard.ts`). **[V]**

**Updater / installer integrity.** Signature verification delegated to `tauri-plugin-updater` with minisign pubkey baked in; `download()` verifies before returning bytes; loopback broker redirects disabled (`tauri.conf.json:56-63`; `updater_feed.rs:11-17,145-150,190-192`; `elevation.rs:100-105,127-130`). **[V]**

**Entitlement enforcement.** Server-side provisioning checks active entitlement + expiry, fails closed on unreadable date, issues per-user credentials only (`cloud/worker/src/index.ts:716-754,770-789`). Admin routes check `isAdmin`. Webview only renders mirrored subscription data; no client-side grant path. Cloud sessions: access tokens hashed at rest, refresh rotation with reuse detection revoking the chain, identity from verified session (`auth.ts:1-8,129-190`). Ops gate fails closed, rate-limits before compare, constant-time compare (`ops-auth.ts:1-16,68-96`). HMAC integration constant-time, no secret logging (`np-auth.ts:114-170`). **[V]**

**User-data isolation.** Every user-owned table carries `user_id ... REFERENCES users(id) ON DELETE CASCADE` (or `SET NULL` for audit) across migrations 0001/0002/0003/0005. **[V]**

**Log redaction.** Export path redacts all-or-nothing per line (keyword list + JWT shape) with a write-line-atomicity invariant so a credential cannot split across lines (`diagnostics.rs:39-47,90-125`; `logging.rs:14-22,79-103`). **[V]**

## 2. Risks (analysis, not confirmed leaks)

**A1 — Webview-decryptable secrets [MED].** `secret_unprotect` returns plaintext to the webview and entropy is in the binary. Any webview code execution could decrypt any blob it obtains. Mitigated by `script-src 'self'`; no per-command caller authorization. **REVIEW.**

**A2 — Raw stderr to disk [MED].** Sidecar stderr logged verbatim (`sidecar.rs:302-316`); `write_log` does not redact at the sink (`logging.rs:79-94`); Pino logger applies no sink redaction. Redaction is applied only at specific call sites. On-disk log therefore depends on call-site discipline; export is the only enforced filter. **REPAIR (defense-in-depth): redact at the sink.**

**A3 — Filter coverage gap [LOW].** Bare hex/base64 digests and PEM bodies are intentionally not redacted (indistinguishable from diagnostics). A bare 64-hex token logged without a keyword survives export.

**A4 — Trust assumptions.** Operator rate limiting keys on `cf-connecting-ip` (valid only if the worker is exclusively Cloudflare-fronted). `vpn_credentials.secret` is plaintext in D1 by design — DB read access yields live VPN credentials.

**A5 — Loopback updater [LOW].** `dangerousInsecureTransportProtocol: true` acceptable because integrity is signature-based; a local process could control feed metadata but signature verification still gates the artifact.

**A6 — Elevation parameter joining.** `op.args.join(" ")` passed as `lpParameters`; no shell so not injection, but a config path containing spaces could be parsed unexpectedly by `wireguard.exe`.

**A7 — Error text logging.** Sidecar error bodies interpolated into returned/logged strings; a verbose local backend error could reach the log.

**A8 — Signing identity [REPLACE for prod].** `certs/netpulse-release.pfx` is gitignored; the local route is a self-signed dev certificate whose chain is untrusted (the release tooling itself flags SmartScreen warnings). Production releases should use CA/Azure Trusted Signing. **KEEP for dev.**

## 3. Fixed this audit (security-relevant)
**Vault key-file ACL [V] [FIXED].** `apps/api/src/vpn/keychain.ts` granted the vault `.key` file a **read-only `(R)` ACL**, which on Windows also denies DELETE and overwrite. Consequences: key rotation (`writeFileSync` over a read-only file) and vault deletion both failed with `EPERM`, and the plaintext key file survived the Credential-Manager migration — exactly the exposure the migration exists to eliminate. Fixed to grant the current user `(F)` (still removing Everyone/SYSTEM/inherited, preserving "current user only") and added `removeKeyFile()` that restores delete rights before unlinking pre-existing files. Verified by 74 vault tests.

## 4. Not done (by design)
- Did not rotate credentials, change secrets, deploy, or alter live infrastructure.
- Did not attempt to bypass the sandbox's `reg.exe` block.
- Did not read secret file contents.

## 5. Verdict
Security posture is strong: minimal capabilities, narrow CSP, allow-listed elevation with TOCTOU protection, server-side entitlement enforcement, hashed tokens with refresh-rotation, per-user data isolation. The main gaps are defense-in-depth in log redaction (A2), the webview-decryptable-secret surface (A1), and the now-fixed vault ACL. Priority: A2 → A1 → A3.
