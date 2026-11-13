# NetPulse Vpn_app — Project Plan & Handover
**Path:** `E:\Code\Project\Vpn_app`
**Workspace package:** `netpulse`
**Monorepo workspaces:** `packages/*`, `apps/*`, `cloud/*`
**Runtime evidence date:** 2026-10-24
**Active model/provider (this chat):** stepfun/step-3.7-flash:free / nous

---

## 1. Goal
Provide a concise, evidence-based handover for the Vpn_app monorepo: what it is, how its components fit together, how to build/test/deploy it, and what is already verified versus still blocked from local inspection.

---

## 2. Repository inventory

| Component | Location | Stack | Purpose | Build/test |
|---|---|---|---|---|
| **Desktop shell** | `src-tauri/` | Rust + Tauri 2 | Window, IPC, sidecar supervision, elevation, engine installs, updater | `tauri build`; `cargo test` |
| **Sidecar API** | `apps/api/` | Node + Hono + SQLite | Local API: VPN, nodes, profiles, diagnostics, proxy cores, TUN gateway | `npm run build -w @netpulse/api`; `vitest run` |
| **Web app** | `apps/web/` | React 19 + TS + Vite | All UI feature pages | `npm run build -w @netpulse/web`; `vitest run` |
| **Shared models** | `packages/shared/` | TS + zod | Engine tables, node schemas, tunnel/gateway models | `tsc --noEmit`; `vitest run` |
| **Cloud worker** | `cloud/worker/` | Cloudflare Worker + D1 | Accounts, sessions, reset mail, Telegram integration, ops page | `wrangler deploy`; `vitest run` |
| **Telegram bot** | external (Abystral) | — | Purchases, payments, entitlements | — |
| **CI** | `.github/` | — | — | **Not present** |

Dependency direction:
- `web` -> `shared` <- `api`
- `worker` -> shared models (constants kept byte-identical by contract tests)
- `desktop` embeds the sidecar bundle

---

## 3. Architecture summary

### 3.1 Desktop chain
Windows EXE (Tauri) -> React webview -> Tauri IPC -> Rust commands (elevation, engine install, updater) -> portable Node sidecar (spawned, supervised) -> local Hono API (SQLite) -> engine processes (xray / sing-box / v2ray / hysteria / WireGuard / OpenVPN / Aether) -> OS (system proxy or TUN gateway).

### 3.2 Account/subscription chain
Telegram Bot (Abystral, external) -> signed lifecycle events -> worker inbox (idempotent) -> `np_entitlements` mirror -> desktop polls `/api/v1/subscriptions` (safe model only).

### 3.3 Key security invariants observed in code
- Service-to-service HMAC auth with nonce burned before signature compare.
- Session tokens stored as SHA-256 hashes; access token short-lived; refresh tokens rotate on use; rotation tombstones detect replay.
- Password reset mail is optional and fails closed when transport/secret is missing.
- Engine installs verify digests before writing binaries; missing digests fail closed.

---

## 4. Configuration essentials

### 4.1 Local API defaults
| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `127.0.0.1` | Loopback by default |
| `DATA_DIR` | `./.data` | SQLite DB, daemon token, VPN vault, VPN configs |
| `SESSION_TTL_HOURS` | `168` | Session lifetime |
| `LOG_LEVEL` | `info` | pino level |

### 4.2 Cloud worker secrets (never committed)
- `AUTH_SECRET`
- `RESET_PEPPER`
- `NETPULSE_SERVICE_SECRET`
- `TELEGRAM_BOT_BASE_URL`
- `OPS_TOKEN`
- `RESEND_API_KEY` / `MAIL_FROM` (optional; enables reset mail)
- `EXPECTED_ORIGIN` (reset-link hostname validation)

### 4.3 VPS/SSH
- SSH host alias: `abyssal-tls` -> `153.52.92.193:443` via OpenSSL wrapper
- SSH host alias: `abyssal-22` -> `153.52.92.193:22`
- Current status: **BLOCKED** — TLS-wrapped path closes during handshake; direct path rejects all local keys in this environment.

---

## 5. Build, test, and verify commands

```bash
# Install
npm install

# Build workspaces
npm run build --workspaces --if-present

# Tests
npm run test:all
npm run test -w @netpulse/api
npm run test -w @netpulse/web
npm run test -w @netpulse/shared
npm run test -w @netpulse/cloud-worker
cargo test --manifest-path src-tauri/Cargo.toml

# Typecheck + lint
npm run typecheck -w @netpulse/api
npm run typecheck -w @netpulse/web
npm run typecheck -w @netpulse/shared
npm run typecheck -w @netpulse/cloud-worker
npm run lint

# Local production run
npm start -w @netpulse/api
```

---

## 6. Verified baseline (2026-10-24)

| Check | Result |
|---|---|
| API tests | **1013/1013 PASS** |
| Web tests | **356/356 PASS** |
| Shared tests | **66/66 PASS** |
| Cloud-worker tests | **92/92 PASS** |
| Total workspace tests | **1527/1527 PASS** |
| Web production build | **PASS** (entry chunk ~549 kB / 170 kB gzip; 3D map lazy) |
| Typechecks | **PASS** in all 4 projects |
| Lint | **PASS** |
| Production audit | **0 production vulnerabilities** |
| Wrangler account | Logged in to expected Cloudflare account; worker `netpulse-cloud` deployed |

---

## 7. Outstanding honest gaps / blockers

| Item | Status | Evidence / next step |
|---|---|---|
| Live VPS SSH access | **BLOCKED** | TLS-wrapped path closes; direct path rejects keys. Needs credential/host reachability review. |
| Live VPN/TUN from this environment | **NOT VERIFIED** | Requires Windows admin + authorized nodes. |
| Live Abystral bot + payments | **NOT VERIFIED** | External service; test harness skips bot-authority stage by design. |
| Production reset-mail inbox delivery | **NOT VERIFIED** | API accepts; recipient inbox not observable without mail provider access. |
| CDN/Worker hostnames (`cdn443`, `cdn`, `cf`, `sub`, `xui-edge-proxy`) | **BROKEN / NOT ATTACHED** | Akamai/CDN misconfiguration; worker route attachment missing. |
| `s` / `t` DNS delegations | **BROKEN** | Public SERVFAIL; nameservers do not host zones. |

---

## 8. Immediate priorities (recommended order)
1. Restore VPS SSH access and run the live smoke scripts (`scripts/vpn-live-proof.mjs`, `scripts/e2e-telegram-link-staging.mjs`).
2. Fix the CDN/Worker hostnames and remove stale `s`/`t` delegations.
3. Validate REALITY + AmneziaWG 3.1 configuration on the live node using only authorized test clients.
4. Add CI workflows.
5. Verify production reset-mail delivery via provider dashboard/DMARC if `MAIL_FROM` remains on the current zone.
