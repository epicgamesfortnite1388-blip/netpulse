# ULTIMATE INTEGRATION AUDIT

**Audit date:** 2026-11-16. Boundaries between Rust, Tauri, React/TS, Cloudflare Worker, Telegram bot, subscription services, and engine processes. **[V]** verified · **[A]** analysis.

---

## 1. Boundary inventory

| Boundary | Mechanism | Contract location | Runtime validation |
|---|---|---|---|
| Rust ↔ webview | Tauri IPC (41 cmds) | `main.rs:257-299` + `commands/nani.rs` | typed args; no zod |
| Rust → webview | `nani:event` Tauri event | `events/mod.rs` + `naniEvents.ts` | hand-written casts |
| webview ↔ sidecar | HTTP REST + WS (loopback, ephemeral token) | `apps/api/src/routes/*` + `apps/web/src/lib/*` | zod for some bodies |
| sidecar ↔ engines | child process + config files | `coreProcess.ts`, `vpnService.ts` | SHA-256 for installable cores |
| Rust ↔ WireGuard | UAC broker with allow-list | `elevation.rs` + `elevationBroker.ts` | canonicalized path + nonce + SHA-256 |
| worker ↔ bot | signed webhook HTTP | `np-auth.ts`, `netpulse-integration.ts` | HMAC + constant-time compare |
| worker ↔ D1 | SQL migrations | `cloud/worker/migrations/**` | FK cascade |
| sidecar ↔ SQLite | Drizzle migrations | `apps/api/drizzle/**` | `quick_check` gate |

## 2. Verified contracts (consistent)

- **WS test stream:** ticket mint + single-use ticket + subscribe/unsubscribe protocol match between backend (`wsRoute.ts:35,47,75-96`) and frontend (`ws.ts:55-56,62,76-85`). Unsubscribe on close implemented.
- **NANI desktop event:** Rust emits `nani:event` `{seq,event:{kind,payload}}`; frontend normalizes exactly that and listens on the same channel; poll fallback shape consistent.
- **Tauri commands:** no invoked-but-missing, no defined-but-unregistered; argument names match on invoked commands.
- **Entitlement mirror:** field names line up across worker `listEntitlements` → `NetpulseSubscription` (`client.ts:436-447`) → `SubscriptionCard`/`subscriptionView.ts`.
- **Signed integration:** HMAC constant-time compare, no secret/signature logging, inbound inbox dedup, outbound signed client.

## 3. Contract defects

**I1 — Shared NANI event contract is dead and contradictory [V] [HIGH].** `packages/shared/src/nani/events.ts:17-53` declares `nani:health:started`, `nani:health:updated`, … with envelope `{seq,at,type,payload,version}`. Nothing imports it; it does not describe the emitted `ApiHealthChanged`/`FailureDetected`/`RecoveryStarted`/… events; it is **not a zod schema**. The frontend instead uses unvalidated casts (`naniEvents.ts:266-307`). **Fix:** make this the single source of truth as a zod schema, or delete it.

**I2 — Two contradictory capability contracts [V] [LOW].** `apps/api/src/routes/meta.ts:102-117` returns 10 hardcoded `true` flags; `/meta/capabilities` does real detection. **Fix:** remove the hardcoded list or derive it.

**I3 — Duplicate entitlement field mapping [V] [LOW].** `cloud/worker/src/index.ts:958-995` duplicates the safe-model field map in `listEntitlements` and `/subscriptions/:id`. **Fix:** extract one mapper.

**I4 — Duplicate `nani_explain` wrappers [V] [LOW].** `naniApi.ts:148` and `aiApi.ts:59` invoke the same command with divergent result handling. **Fix:** one wrapper.

**I5 — AI endpoints permanently 503 and uncalled [V] [MED].** `/api/v1/ai/ask` & `/ai/stream` (`cloud/worker/src/index.ts:1239,1281`) are never called by the frontend and return 503 (`ABYSTRAL_AI_BASE_URL=""`). **Fix:** remove or implement.

## 4. Error / ordering / cancellation semantics

- **Timeouts:** cloud egress and updater calls have timeouts; loopback broker disables redirects.
- **Event ordering:** NANI events carry a monotonic `seq`; frontend applies by seq. Good.
- **Duplicate delivery:** inbound webhook inbox dedups by event id. Good.
- **Cancellation:** investigations check `is_cancelled()` before each stage. Good.
- **Reconnection:** WS has a ticket flow; `transport.ts` resets on `sidecar-restarted`. One duplicate-listener issue (D18).
- **Error propagation:** worker swallows several audit/entitlement errors (F7) — a failure can appear as success to the caller.

## 5. Contract tests
Existing: WS ticket/unsubscribe tests, NANI event normalization tests (24 in `naniEvents.test.ts`), entitlement tests in worker suite, vault tests. **Missing:** a schema-validated test that every emitted `nani:event` kind validates against a shared zod schema (because I1 doesn't exist as a schema). Recommend adding one once I1 is resolved.

## 6. Verdict
The boundaries are, on the whole, honestly implemented with real auth and real data. The one structural integration defect is I1 (the dead/contradictory event contract), which leaves NANI event payloads unvalidated. Priority: I1 → I5 → I2/I3/I4.
