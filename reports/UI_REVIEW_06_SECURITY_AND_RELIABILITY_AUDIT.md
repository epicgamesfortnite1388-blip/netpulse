# UI_REVIEW_06 — Security and Reliability Audit (frontend boundary)

**Read-only.** No secrets read/printed. `.data/`, `certs/`, token files not opened.

---

## Verified controls (carry forward — do not weaken)

- **Sidecar token is memory-only.** `lib/transport.ts` captures the bearer from `bootstrap` in a closure; `authHeaders()` returns it; never written to `localStorage`/`sessionStorage`. (F3, positive)
- **Rust-side URL/path allowlists.** `open_external` is https-only, no userinfo, host required, no shell; `reveal_path` canonicalizes under app-data/log dirs; `read_log_tail`/`save_diagnostic_report` redact.
- **CSP** `script-src 'self'` (no `unsafe-eval`), `connect-src` limited to self/IPC/loopback; capabilities minimal (no shell/fs/http plugins); single-window `on_new_window` deny.
- **Zero unsafe HTML sinks** in `apps/web/src`: no `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function`.
- **Entitlement is server-enforced.** No client gate; `AccountPage` reacts to Worker error codes (`entitlement_expired`, etc.); `POST /vpn/connect` does no subscription check (enforced at cloud provisioning). Frontend cannot bypass a check it does not implement. (F8, positive)
- **Desktop auth:** cookies removed from trust chain; per-launch bearer; timing-safe compare; CSRF same-origin check on cookie-mode mutations; log redaction of tokens/keys.

## Findings

### F1 — `secret_unprotect` is a DPAPI decrypt oracle exposed to webview JS — HIGH · blocks redesign: no
`lib/cloud/secureStore.ts` (`primeSecureStore`/`doPrime`) calls `tauriInvoke('secret_unprotect', {protected})` with any stored `np.cloud.*` value; the command is registered unconditionally. Any webview script could enumerate `localStorage` and decrypt the refresh token / vault key. **Contained today** by CSP `script-src 'self'`, zero HTML sinks, single-window deny — so reachable only if an XSS primitive appears. **Redesign rule:** keep the CSP + zero-HTML-sink invariant, or gate `secret_unprotect` to values the shell itself wrote. A new rendering sink turns this into a credential dump.

### F2 — non-`http(s)` links not neutralised by the navigation guard — MEDIUM · no
`lib/externalNavigation.ts` `externalTarget` returns `null` for non-http(s) and `onActivate` then returns without `preventDefault`; `components/ui/ExternalUrlLink.tsx` calls `openExternalUrl(href)` with no scheme check, and `openExternal` falls back to `window.open` in web mode. Backend-supplied hrefs exist (`release.url`, `dns.homepage`, `game.statusUrl`, `entry.url`). Desktop Rust rejects non-https, so web/dev-only. **Fix before any new data-driven link.**

### F3 — sidecar token memory-only — INFO (positive) — see above.

### F4 — plaintext credential persistence in web mode — MEDIUM (web) / LOW (desktop) · no
`lib/cloud/sessionStore.ts` `persist` writes the access token to `sessionStorage` **plaintext**; refresh/user/sessionId/vault key go through `secureStore` which **falls back to plaintext** when no IPC and on DPAPI failure. Affected keys: `np.cloud.refresh|user|sessionId|e2eKey.*|lastSyncAt`, `np.pref.*`. Documented trust decision (`profileVaultCrypto`), acceptable for a local desktop app but must not be weakened.

### F5 — zero runtime schema validation of backend/IPC/WS payloads — MEDIUM · no
No `from 'zod'` import anywhere in `apps/web/src`. `ws.ts` casts `JSON.parse(...) as WsTestMessage`; `naniApi` casts every DTO; `useStartupHealth` casts `RuntimeStatus`; `transport` trusts `bootstrap` fields; `updater` casts `feed_check`. Ad-hoc guards exist (`useStartupHealth` checks `checks`/`status`; `naniEvents.fromTauriEvent` does manual `typeof`). **Cheap, high-value redesign addition:** validate at `transport.ts`/`ws.ts` using the shared zod schemas already exported (`schemas/engines.ts`, `schemas/settings.ts`, `schemas/vpnTunnel.ts`).

### F6 — destructive/privileged IPC one click from UI — MEDIUM · no
`AppErrorBoundary` "Reset app state…" invokes `reset_app_state` **without confirmation**; Settings confirms; Health's `restart_backend`/Repair. Rust moves data to `backup-<ts>/` rather than deleting (availability, not data loss). `vpn_elevation_bridge` is **not** a free UAC trigger (opId must be staged server-side with a nonce).

### F7 — backend error detail reaches UI text — LOW · no
`plugins/errorHandler.ts` returns `err.message` verbatim for 4xx–5xx; `routes/health.ts` embeds raw `SQLite error: …`; client renders `error.message` in `States`/toasts. No stack traces rendered. Local-only app → LOW; absolute paths/SQL text can appear. Redesign should not add raw-detail surfacing.

### F8 — frontend does not own entitlement — INFO (positive) — see above.

### F9 — `withGlobalTauri` + insecure-transport flag widen IPC trust — LOW · no
`tauri.conf.json` `withGlobalTauri:true` exposes `window.__TAURI__.invoke`; `dangerousInsecureTransportProtocol:true` permits `http://127.0.0.1`. Both required for the loopback sidecar; contained by CSP + no HTML sink.

### F10 — `openExternalUrl` reports success before OS confirms — LOW (reliability) · no
Returns `true` immediately; `.catch(()=>undefined)` discards rejection. UI cannot distinguish "opened" from "refused".

### F11 — `bootstrap` response trusted as origin selector — LOW · no
`transport` sets `apiBase`/`wsBase` from IPC with no origin check; CSP `connect-src` restricts blast radius to loopback.

---

## IPC surface summary (verified)

All invoke calls funnel through `transport.tauriInvoke`. No invoke passes a user-controlled filesystem path, shell string, or URL without a Rust-side allowlist except `open_external`/`reveal_path` (both Rust-validated). NANI commands take `{question}`, `{since}`, `{investigation_id}`, `{query}` — cast only, no runtime validation.

## Redesign security rules (must hold)
1. Preserve `script-src 'self'` and the zero-HTML-sink invariant, or gate `secret_unprotect`.
2. Add a scheme allowlist in `openExternalUrl` itself before introducing new data-driven links.
3. Do not move entitlement or verification logic into the frontend.
4. Do not surface raw backend errors/stack traces in new UI.
5. Do not persist tokens to `localStorage`; keep the memory-only bearer.
