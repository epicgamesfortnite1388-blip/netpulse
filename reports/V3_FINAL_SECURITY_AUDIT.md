# NetPulse V3 — Final Security Audit

**Status: PASS WITH DOCUMENTED MODERATE FINDINGS. Release is unsigned.**

## Controls verified in source and artifact

| Control | Result | Evidence |
| --- | --- | --- |
| Tauri CSP | Present | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src` restricted to self, IPC and loopback sidecar |
| Sidecar authentication | Enforced | `npm run desktop:verify`: "sidecar enforces bearer auth"; installed app returns HTTP 401 to unauthenticated `/api/v1/health` |
| Sidecar binding | Loopback only | Verification log: `127.0.0.1:18061`; installed app `127.0.0.1:47615` |
| Secrets in web bundle | None found | Search of `apps/web/dist` and staged backend for bot tokens, OpenAI-style keys and private-key headers returned no matches |
| `.env` / key files in package | None | No `.env`, `.pem` or `.key` files in `src-tauri/backend` staging |
| Credentials in reports | None | Reports contain paths and hashes only |
| Deterministic override by LLM | Not possible | Diagnosis and recovery are deterministic; Copilot is a separate cloud-proxied feature |
| Updater | Local feed only | Endpoint is `http://127.0.0.1:47615/api/v1/update-feed/latest.json`; `dangerousInsecureTransportProtocol` is enabled only for this loopback feed. Artifacts carry `createUpdaterArtifacts: false`. |

## Dependency audit

`npm audit --omit=dev --audit-level=high` exited 0 with **3 moderate** advisories:

- `minimatch` (7.0.0–11.0.0): potential denial of service via globparts amplification.
- `glob` 7.x–11.x: AbortSignal cancellation bypass allowing post-timeout filesystem traversal.
- `@fastify/static` 7.0.0–10.1.8: depends on the vulnerable `glob`.

These are transitive runtime dependencies of the local API. They require attacker-controlled filesystem glob patterns to exploit; the desktop serves its own bundled assets and does not accept user-supplied glob patterns. No high or critical advisory was reported. No dependency was upgraded at release time, because an untested lockfile change immediately before signing/install would invalidate the regression evidence.

## Signing

The installer and executable are **unsigned**. No code-signing certificate or private key is present in the workspace, and no signature was fabricated. Windows SmartScreen will warn on first install. SHA-256 hashes are published in `installer/SHA256SUMS.txt` for integrity checking.

## Residual risk

1. Unsigned binaries — users cannot verify Authenticode publisher identity.
2. Three moderate npm advisories as described above.
3. The local update feed uses plain HTTP on loopback. It cannot be reached off-host, but a local process able to bind the port could serve a manifest; update artifacts are still minisign-verified by the app's embedded public key.
4. The installed application preserves the user's existing database and secret store; the installer does not encrypt them (they were already stored by the previous version).

No critical or high-severity unresolved vulnerability was found. Release proceeds with the above accepted risks.
