# ULTIMATE REPOSITORY ARCHITECTURE

**Audit date:** 2026-11-16 · Reconstructed from source, not from README files. Claims are marked **[V]** verified from code, **[A]** analysis, **[?]** unverified assumption.

---

## 1. System shape

NetPulse is a **Windows VPN + network-intelligence desktop application** with a Rust/Tauri shell supervising a Node/TypeScript backend sidecar, a React webview frontend, a Cloudflare Workers cloud backend, and an external Telegram bot (separate repo) for subscription/payment.

```
┌─────────────────────────── Windows desktop (Tauri 2) ───────────────────────────┐
│  React webview (apps/web)  ──HTTP/WS loopback + ephemeral token──▶ Node sidecar │
│         │  typed Tauri IPC (bootstrap, nani_*, secret_*, admin_*, feed_*)        │
│         ▼                                                                       │
│  Rust core (src-tauri)  ──supervises──▶ Node sidecar (apps/api)                  │
│    • sidecar lifecycle/restart budget   • DPAPI secret store                     │
│    • elevation broker (WireGuard UAC)   • NANI diagnostic engine (authoritative) │
│    • single instance / tray / updater   • log redaction / diagnostics export     │
└──────────────────────────────────────────────────────────────────────────────────┘
                    │                              │
                    ▼                              ▼
          VPN/native engines                Cloudflare Worker (cloud/worker)
          xray.exe, aether.exe              subscriptions, entitlements, Telegram
          wireguard.exe (external)          linking, profile vault, ops console
          openvpn (external)
```

**[V]** React never speaks directly to engines; it calls the sidecar over loopback. The Rust layer owns OS-sensitive operations. Sidecar token is a 32-byte CSPRNG delivered via stdin and exposed to the webview only through the `bootstrap` Tauri command (`sidecar.rs:41-46, 286-294`; `main.rs:61-127`).

---

## 2. Component map

| Component | Location | Responsibility | Consumers | Status | Verification |
|---|---|---|---|---|---|
| Rust shell entry | `src-tauri/src/main.rs` | Tauri setup, 41 command registrations, state wiring, health polling | webview IPC | Working | 529 Rust tests pass |
| Sidecar supervisor | `src-tauri/src/sidecar.rs` | spawn/readiness/restart budget/token | main.rs | Working | extensive unit tests |
| Elevation broker | `src-tauri/src/elevation.rs` | allow-listed WireGuard UAC install | Node `elevationBroker.ts` | Working | allow-list tests |
| DPAPI vault | `src-tauri/src/dpapi.rs` | protect/unprotect secrets | `secret_protect/unprotect` cmds | Working | FFI fail-closed tests |
| NANI Rust engine | `src-tauri/src/network_intelligence/**` (52 files) | Bayesian diagnosis, evidence, information theory, learning, context, APIs | 24 `nani_*` commands | **Mixed** | strong isolated tests; wiring gaps (see NANI audit) |
| Node sidecar API | `apps/api/src/app.ts` | Fastify routes, WS, persistence, VPN orchestration | webview, scripts | Working | typecheck clean; tests pending |
| VPN orchestration | `apps/api/src/vpn/vpnService.ts`, `.../aetherProvider.ts`, `.../proxyCores.ts` | engine lifecycle, verification, cleanup | `/api/v1/vpn/*` routes | Mostly real | source-traced; see VPN audit |
| Shared contracts | `packages/shared/src/**` | zod schemas, NANI TS mirror, scoring | web + api | Working | 212 tests pass |
| React frontend | `apps/web/src/**` (26 routes) | all UI, real API calls | user | Working | 500/502 tests pass → fixed → 502 (verify) |
| Cloud Worker | `cloud/worker/src/**` | auth, entitlements, Telegram link, D1 | web client, bot | Working **[?]** runtime | typecheck/tests pending |
| External Telegram bot | `E:/Code/Project/Bot/Abystral` (separate repo) | payments, link/claim | worker via signed HTTP | Out of scope | not inspected beyond identity |

---

## 3. Tauri command surface **[V]**

41 commands registered in `main.rs:257-299`. All `#[tauri::command]` functions are registered; none are invoked-but-missing. Groups:
- **Bootstrap/system (10):** `bootstrap`, `data_paths`, `reveal_path`, `netpulse_safe_mode`, `reset_app_state`, `runtime_status`, `read_log_tail`, `save_diagnostic_report`, `restart_backend`, `open_external`.
- **Admin/elevation/updater/secrets (7):** `admin_status`, `relaunch_as_admin`, `vpn_elevation_bridge`, `feed_check`, `feed_install`, `secret_protect`, `secret_unprotect`.
- **NANI (24):** events/status/health/learning/personalization/AI/investigation/math.

**Gap [V]:** 10 `nani_*` commands are registered but never invoked by the frontend (`nani_personalization_transitions`, `nani_context_observe`, `nani_personalization_delete`, `nani_math_entropy`, `nani_math_rank_hypotheses`, `nani_math_select_probe`, `nani_math_should_stop`, `nani_math_drift_analysis`, `nani_math_changepoint_analysis`, `nani_math_mutual_information`). Dead IPC surface, not a correctness failure.

---

## 4. Data and event flows

### 4.1 Startup **[V]**
1. Rust `setup()` installs disk-backed NANI `PersistenceStore`, replaces placeholder event bus, reserves loopback port, spawns sidecar with token on stdin.
2. Sidecar boots Fastify, opens SQLite (`apps/api` data dir) with `quick_check` integrity gate, runs Drizzle migrations, starts WS + route listeners.
3. Webview loads bundled assets, calls `bootstrap` → receives token/port, then queries REST + subscribes to WS + `nani:event`.

### 4.2 NANI event contract **[V]**
- Rust emits `nani:event` with envelope `{seq, event:{kind, payload}}` (`events/mod.rs:21, 251-254`).
- Frontend normalizes that exact shape (`naniEvents.ts:266-286`) and listens on the same channel.
- Poll fallback `nani_poll_events` shape is consistent.
- **Defect [V]:** the "official" shared contract `packages/shared/src/nani/events.ts` is imported by nobody and describes different event names/envelope. No zod runtime validation of event payloads. See integration audit.

### 4.3 VPN lifecycle **[V]** (source-traced in VPN audit)
`VALIDATE CONFIG → PREPARE → START → VERIFY (public-IP diff / Cloudflare trace) → MONITOR → STOP → CLEANUP`. Real for xray, sing-box, v2ray, hysteria, WireGuard, Aether, proxy tunnel. OpenVPN is PARTIAL (3s survival heuristic). Custom is an honest 501 stub.

### 4.4 Subscription/entitlement **[V] [?]**
Signed webhook inbox → entitlement mirror in D1 → provisioning checks entitlement + expiry server-side → issues per-user credentials. Depends on external bot + secrets (`TELEGRAM_BOT_BASE_URL`, `NETPULSE_SERVICE_SECRET`). Runtime correctness not verified in this audit.

---

## 5. Persistence topology

| Store | Tech | Owner | Integrity |
|---|---|---|---|
| Local app data | SQLite (WAL, FK on) | `apps/api/src/db/client.ts` | `quick_check` gate, quarantine corrupt DB, migrations 0000–0013 |
| NANI model/observations | JSONL + JSON (atomic rename) | `src-tauri/.../persistence.rs` | **repaired** this audit (serialization errors no longer write empty files) |
| Cloud D1 | SQLite (Cloudflare) | `cloud/worker/migrations/**` | FK cascade, token hashing, refresh rotation |
| Secrets | Windows DPAPI / cloud ciphertext | `dpapi.rs`, `profileCloudVault.ts` | fail-closed, app-scoped entropy |

---

## 6. Architecture assessment **[A]**

**Strengths:** clear OS-boundary separation; authoritative local Rust diagnostic engine; narrow Tauri capabilities/CSP; honest error states; bounded restart/cleanup budgets; real process supervision.

**Weaknesses:**
1. Dual NANI implementations (Rust authoritative + TS web-mode mirror) with drift risk and an unused shared contract.
2. 10 dead NANI IPC commands and a dead route (`nani-reports-page.tsx`).
3. Uncommitted and untracked code is a large fraction of the extended NANI engine → no clean architectural baseline.
4. Some mathematical modules (`causal.rs`, `information_theory.rs` cost functions, `simulation.rs`) are well-built but have no production callers — sophisticated code that is not wired in.
5. `main.rs setup()` has 6 unguarded `unwrap()` in mutex acquisition; a poisoned lock fails startup silently.
6. Node-side DB writes are per-statement autocommit with no explicit transactions for logical units.

**Recommended simplification order:** (1) wire or remove the 10 dead commands; (2) make `packages/shared/src/nani/events.ts` the single validated event contract or delete it; (3) consolidate NANI state (store + event reducer); (4) convert verified-unused math modules to `#[cfg(test)]` or wire them; (5) add transactions to multi-statement API units. Each item requires its own verification cycle — no blind deletion.
