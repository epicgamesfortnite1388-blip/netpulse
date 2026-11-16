# ULTIMATE LEGACY REMOVAL PLAN

**Audit date:** 2026-11-16. Every candidate lists consumer evidence. **No deletion was performed in this audit** — removal requires the owner's confirmation and a regression test per item, per the engineering rules. Classification: KEEP / REPAIR / REFACTOR / REPLACE / DEPRECATE / REMOVE / INVESTIGATE.

---

## 1. Candidates

| # | Candidate | Consumer evidence | Class | Rationale |
|---|---|---|---|---|
| L1 | Legacy shared VPN secret names `VPN_REALITY_UUID`, `VPN_VMESS_UUID`, `VPN_VLESS_WS_UUID`, `VPN_TROJAN_PASSWORD`, `VPN_SS2022_PASSWORD`, `VPN_HYSTERIA_PASSWORD` (`cloud/worker/src/auth.ts:40-45`) | only tests/config: `test/provision.test.ts:104,124,150`; `vitest.config.ts:49-54`. Production says nothing reads them (`auth.ts:31-38`) | **REMOVE** (after confirming deployment secret bindings unused) | dead secrets; keep `VPN_HYSTERIA_OBFS_PASSWORD` (still used, `auth.ts:48`) |
| L2 | Empty `apps/api/src/db/migrations/` directory | no files; real migrations in `apps/api/drizzle/` (`client.ts:151-167`) | **REMOVE** | empty artifact |
| L3 | Missing drizzle snapshots for migrations 0001–0013 | journal lists 14, only `0000_snapshot.json` exists | **REPAIR** | regenerate snapshots (see persistence P3) |
| L4 | Duplicate `0005_*` cloud migrations | both applied by wrangler; independent | **REPAIR** | renumber (persistence P4) |
| L5 | Dual NANI implementations: Rust `network_intelligence/**` vs TS `naniService.ts` + `routes/nani*.ts` | both live: webview calls Rust (`naniApi.ts:95-226`, `aiApi.ts:59`); same file documents web-mode HTTP fallback | **KEEP** + INVESTIGATE divergence | intentional dual-mode; risk of state-model drift |
| L6 | `naniDiagnosticAdapter.ts`, `naniProbeAdapter.ts`, `naniShadowHealthLoop.ts` | real consumers: `app.ts:76`, `routes/naniDiagnostics.ts:16`, `naniService.ts:52` | **KEEP** | in use |
| L7 | `profileCloudVault.ts` + `nodeSecretVault.ts` (two secret stores) | both wired: `routes/context.ts:68-69,159`; used via `routes/vpn.ts` and node services | **KEEP** + INVESTIGATE | competing source-of-truth for secret retention/backup |
| L8 | `RetentionService.getState()` (`retention.ts:63-64,118-120`) | no consumer (`app.ts` uses `sweep()` only) | **REMOVE** | dead in-memory state |
| L9 | `apps/web/src/features/nani-memory` (extensionless orphan) | no imports reference it; undefined identifiers | **REMOVE** | corrupt, dead, would fail typecheck |
| L10 | `apps/web/src/features/nani-reports/nani-reports-page.tsx` | imported nowhere; unrouted | **REMOVE or WIRE** | fully built but dead; owner decides |
| L11 | 10 dead `nani_*` Tauri commands | registered but never invoked (frontend audit D1) | **REMOVE or WIRE** | dead IPC surface |
| L12 | `packages/shared/src/nani/events.ts` | imported by nobody; contradicts emitted events | **REPLACE** | make it the validated contract, or delete (integration I1) |
| L13 | `causal.rs` ATE tracker; `information_theory.rs` cost fns; `sequential.rs`; `foundation::simulate_probe` | no production callers (NANI/math audits) | **INVESTIGATE → WIRE or `#[cfg(test)]`** | sophisticated but unwired |
| L14 | `simulation.rs` | compiled into prod binary; only tests/eval use it | **REFACTOR** | gate behind `#[cfg(test)]` |
| L15 | `/api/v1/ai/ask` & `/ai/stream` worker endpoints | uncalled by frontend; permanently 503 | **REMOVE or IMPLEMENT** | dead backend surface (integration I5) |
| L16 | Stale updater comment `main.rs:230-232` ("disabled by default") | config now has pubkey + feed; plugin registered | **REPAIR** | documentation drift |
| L17 | Duplicated constants `LOCAL_FEED_PORT` (`sidecar.rs:105-111`) vs `scripts/lib/updateFeed.mjs`; `APP_IDENTIFIER` (`paths.rs:29-30`) vs `tauri.conf.json:5` | both pinned by tests | **KEEP** | guarded duplication |
| L18 | `scripts/sign-release.mjs` / `signingIdentity.mjs` multiple signing routes | all reachable via `NETPULSE_SIGN_*` | **KEEP** | not dead alternatives |

## 2. Removal order (once approved)

1. **Zero-risk, no-consumer:** L2 (empty dir), L9 (orphan file), L8 (dead getState) — each with a typecheck/build after.
2. **Contract cleanup:** L12 (replace with zod schema) — needs the event contract settled first.
3. **Dead IPC/endpoints:** L11, L15 — remove registration + route together, or wire them.
4. **Migration hygiene:** L3, L4 — regenerate/renumber with a dry-run.
5. **Secrets:** L1 — only after confirming no deployed binding reads them.
6. **Math surface:** L13, L14 — wire or `#[cfg(test)]`, never delete working math blindly.

## 3. Non-goals
Do not reduce line count for its own sake. Do not delete the dual NANI implementations while both are reachable. Do not remove the guarded constant duplications that tests pin.
