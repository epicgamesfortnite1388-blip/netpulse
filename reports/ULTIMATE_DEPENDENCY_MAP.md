# ULTIMATE DEPENDENCY MAP

**Audit date:** 2026-11-16. **[V]** verified from manifests/source · **[A]** analysis.

---

## 1. Workspace graph **[V]**

```
packages/shared  ◀──── apps/api ────▶ apps/web
     ▲                   │                 │
     └───────────────────┴─────────────────┘
                         │
                   cloud/worker (independent deploy; uses shared types by convention, not workspace import)
                         │
                external Telegram bot (signed HTTP)
```

- Root `package.json` workspaces: `packages/*`, `apps/*`, `cloud/*`. Node ≥22.
- `apps/web` depends on `@netpulse/shared` and `@tanstack/react-query`, `@radix-ui/*`, `lucide-react`, `@fontsource-variable/*`.
- `apps/api` depends on Fastify + plugins (cookie, cors, helmet, rate-limit, static, websocket), Drizzle, zod, Pino.
- `packages/shared` depends only on `zod` — a deliberate leaf package.
- `cloud/worker` depends on Wrangler, `@cloudflare/workers-types`, vitest plugin.
- Root devDeps: `@tauri-apps/cli`, eslint, depcheck, madge, ts-prune, typescript-eslint.

## 2. Rust crate graph **[V]**

Single crate `netpulse-desktop` (no workspace). Direct deps: `tauri` 2 (tray-icon), `tauri-plugin-{single-instance,dialog,process,updater}`, `serde`, `serde_json`, `url`, `rand`, `sha2`, `reqwest` (rustls-tls, blocking). Release profile: LTO, codegen-units=1, opt-level=s, panic=abort, strip.

**Internal Rust module dependency shape [V] [A]:**

```
main.rs
├── sidecar.rs ──▶ ports.rs, status.rs, logging.rs
├── elevation.rs ──▶ dpapi.rs, paths.rs
├── dpapi.rs ──▶ paths.rs
├── commands/nani.rs ──▶ network_intelligence/{mod,events,commands...}
├── network_intelligence/mod.rs
│   ├── foundation.rs ──▶ diagnosis.rs, bayesian.rs, likelihood signature, simulation.rs
│   ├── diagnosis.rs ──▶ bayesian.rs, math.rs, evidence/correlation.rs, foundation.rs (cycles via tests)
│   ├── bayesian.rs ──▶ math.rs
│   ├── math.rs ──▶ (leaf)
│   ├── probability.rs, robust_stats.rs ──▶ math.rs
│   ├── information_theory.rs, sequential.rs, changepoint.rs, drift.rs ──▶ math.rs
│   ├── hierarchical.rs, learning.rs ──▶ bayesian.rs, probability.rs, persistence.rs
│   ├── evidence/* ──▶ measurements/provenance/validation/correlation/telemetry_pipeline
│   ├── context/* ──▶ context_identity, network_profiles, transitions, storage, privacy
│   ├── api_intelligence/* ──▶ monitor, monitor_loop, registry, failure_classifier
│   ├── ai/* ──▶ explanation.rs, local_runtime.rs
│   └── investigation.rs ──▶ foundation, events, api_intelligence/registry
├── diagnostics.rs (log redaction + support report, standalone)
├── navigation.rs, os_open.rs, safe_mode.rs, updater_feed.rs, webview_gc.rs, window.rs, tray.rs
```

**[A]** `information_theory.rs` and `sequential.rs` duplicate several entropy/stopping functions; `select_best_probe_unified` has no production caller. `causal.rs` ATE tracker and `foundation::simulate_probe` are similarly unused in production. These are candidates for wiring or `#[cfg(test)]`, not blind deletion.

## 3. Cross-boundary contracts **[V]**

| Boundary | Mechanism | Contract location | Validation |
|---|---|---|---|
| Rust ↔ webview | Tauri IPC (41 commands) | `main.rs:257-299` + `commands/nani.rs` | typed args; no zod |
| Rust → webview | `nani:event` Tauri event | `events/mod.rs` + `naniEvents.ts` | hand-written casts |
| webview ↔ sidecar | HTTP REST + WS (loopback, ephemeral token) | `apps/api/src/routes/*` + `apps/web/src/lib/*` | zod schemas for some bodies |
| sidecar ↔ engines | child process + config files | `coreProcess.ts`, `vpnService.ts` | SHA-256 checksums for installable cores |
| Rust ↔ WireGuard | UAC elevation broker with allow-list | `elevation.rs` + `elevationBroker.ts` | canonicalized path + nonce + SHA-256 |
| worker ↔ bot | signed webhook HTTP | `np-auth.ts`, `netpulse-integration.ts` | HMAC + constant-time compare |
| worker ↔ D1 | Drizzle/SQL migrations | `cloud/worker/migrations/**` | FK cascade |
| sidecar ↔ SQLite | Drizzle migrations | `apps/api/drizzle/**` | quick_check integrity gate |

**Contract drift [V]:** `packages/shared/src/nani/events.ts` (declared event contract) is imported by nobody and contradicts the emitted event shapes. No runtime zod validation on the NANI event channel. See integration audit.

## 4. Dependency risks **[A]**

1. **Dual NANI truth sources:** Rust engine (authoritative) + TS web-mode mirror (`apps/api/services/nani*.ts`, `packages/shared/src/nani/*`). They share no code and can diverge semantically.
2. **Unvalidated IPC events:** a malformed `nani:event` payload is cast, not checked.
3. **Unused math surface:** several sophisticated modules have no production caller — complexity without product value until wired.
4. **DB transaction gaps:** logical write units in `apps/api` are per-statement autocommit; a mid-sequence failure leaves partial state.
5. **Migration snapshot drift:** `apps/api/drizzle/meta/` has only `0000_snapshot.json` while `_journal.json` lists 14 entries; `db:generate` has no drift guardrail for 0001–0013.
6. **Duplicate migration number:** `cloud/worker/migrations/0005_reset_atomic.sql` and `0005_vpn_credentials.sql` collide (independent changes, benign today).

No dependency was added or removed in this audit. No blind deletion of "unused" code was performed.
