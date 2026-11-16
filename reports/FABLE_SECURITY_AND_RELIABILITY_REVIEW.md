# FABLE — Security and Reliability Review

## 1. Trust boundaries and surfaces (verified)

| Boundary | Control | Assessment |
|---|---|---|
| Webview ↔ sidecar | loopback-only ephemeral port; 64-hex cryptographically-random daemon token via **stdin** (never disk/env/logs); webview receives it once via typed `bootstrap` command | STRONG. Token hygiene tests exist (`token_is_64_hex_chars`, uniqueness). |
| Webview ↔ OS shell | No generic shell/fs IPC — only `os_open` two allow-listed handoffs + narrow commands (documented in main.rs header, verified in invoke_handler) | STRONG. This is the right model; keep it invariant. |
| Elevation | Single `elevation.rs` broker; staged tunnel config integrity via SHA-256; loopback HTTP pending-op handshake | STRONG; one privilege path, testable. |
| Secrets at rest | DPAPI (per-user, per-machine) for refresh token + vault key; node secrets in vault dir; keychain service (`keychain.ts`) | ADEQUATE with honest scope statement in `dpapi.rs` (does not defend same-user code — stated in-file). |
| Engine downloads | https + host allowlist; pinned digests (sing-box) + release sidecars; size/time caps; single-file extraction; `version` self-check; refusal on unpinned | STRONG; best-in-class for this kind of app. |
| Updater | minisign signature vs baked pubkey; loopback `no_proxy()` transport fix documented; pre-install file-lock wait | STRONG. |
| Cloud Worker ↔ D1 | Secrets via `wrangler secret put` (not in toml); `EXPECTED_ORIGIN` per env; admin plan isolated from normal accounts (`5ec1249`); reset atomic migration | STRONG; `account_id` committed in toml is not a secret (binding id also public) — acceptable. |
| AI copilot | Server-to-server key to Abystral worker; 503 when unconfigured; no direct user keys in desktop | STRONG. |
| Local LLM | Opt-in, binary+model path user-configured, prose-only boundary | STRONG. |
| Rate limiting | `@fastify/rate-limit` on sensitive routes (e.g. webrtc-report 10/min) + helmet + cors with documented method allowlist | ADEQUATE. |

## 2. Findings

| ID | Severity | Finding |
|---|---|---|
| S-01 | MEDIUM | **Desktop cloud secrets DPAPI-protected, but webview storage scope is localStorage** — a malicious renderer compromise could invoke the two typed DPAPI commands (entropy ships in the binary — acknowledged in-file). Accepted residual risk; documented. Mitigation candidates: per-session entropy from the Rust side injected at bootstrap rather than binary constants. |
| S-02 | MEDIUM | `src-tauri/backend/node.exe` + full runtime ships with the app — any Node 0-day applies. Patch discipline: pin Node version, track CVEs; currently no documented pin/patch policy file. |
| S-03 | LOW | `evidence/leak-live-20261112/` committed — verify no user-identifying data. |
| S-04 | LOW | Loopback Fastify allows any local process to attempt auth — token prevents access, but a same-user malicious process could also read the token from the webview's memory (same-user threat model, as DPAPI notes). Accepted. |
| S-05 | LOW | CRLF churn + committed build residue increase supply-chain audit noise. Cleanup listed. |
| S-06 | INFORMATIONAL | Kill switch honesty: proxy-layer enforcement only (WinINET), stated in-file — do not ever market it as firewall-level. |
| S-07 | LOW | Bot/Abystral (`E:\Code\Project\Bot\Abystral`) pytest collection error — reliability issue in the sibling ecosystem, not the desktop; separate workstream. |

## 3. Crash and recovery reliability (verified)

- Sidecar crash-loop: restart budget + cooldown + re-arm rule (unit-tested); exit-code table (e.g. 78 = handshake fail) surfaced.
- Desktop quit: best-effort disconnect of owned tunnels so the machine is never left routed through a dead port (`app.ts:946` comment + implementation).
- Kill switch: pre-arm → arm ordering crash-safe; drop with switch on = fail-closed sink; drop with switch off = deliberate restore.
- Updater: NSIS file-lock race fixed deterministically (15 s wait, honest failure report).
- Safe mode flag exists for broken-state boot.

## 4. Entitlement enforcement

- Desktop: local capability + cloud Worker plans (admin plan of record normal accounts cannot reach); desktop operates fully without cloud (verified design intent + offline honest states).
- Telegram integration is server-side (Worker + Bot repo) — outside the desktop trust boundary.

## 5. Verdict

No critical security defect found. The security posture is unusually disciplined for this app category, with in-code honesty about residual risks. The two real asks are: (1) a Node runtime pin/CVE policy doc, (2) cleanup of committed evidence/build artifacts.
