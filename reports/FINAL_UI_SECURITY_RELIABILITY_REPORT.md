# FINAL_UI_SECURITY_RELIABILITY_REPORT

**Reviewer:** Kim · **Date:** 2026-11-20 · **Scope:** current working-tree diff + carried controls from `reports/UI_REVIEW_06_SECURITY_AND_RELIABILITY_AUDIT.md`.

No secret, `.data/`, certificate or token file was opened. No production, VPS, Cloudflare, remote DB, payment, release or installed-app change occurred.

## 1. Controls verified as preserved (carry forward — do not weaken)

- **CSP / IPC trust**: `script-src 'self'`, no `unsafe-eval`, `connect-src` limited to self/IPC/loopback; no new HTML sink introduced by Will's diff.
- **Zero unsafe sinks**: re-grep of `apps/web/src` for `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function` found none (per prior audit; no new sink in observed hunks).
- **Memory-only sidecar bearer** in `lib/transport.ts` unchanged; no new `localStorage` token write.
- **Backend-enforced entitlement** unchanged; no frontend authorization added.
- **Rust allowlists** (`open_external` https-only, `reveal_path` canonicalized) untouched.
- Will's diff *improves* reliability semantics: `ErrorState` now announces with `role="alert"`, focus-visible outlines strengthened, `LoadingState` no longer doubles ellipses.

## 2. Carried security findings (status unchanged)

| ID | Severity | Summary | Redesign rule |
|---|---|---|---|
| UI-SEC-F1 | HIGH (contained) | `secret_unprotect` DPAPI decrypt oracle reachable from webview JS; contained by CSP + zero sinks + single-window deny | Keep CSP/zero-sink invariant or gate the command |
| UI-SEC-F2 | MEDIUM | Non-http(s) links not neutralized in `externalNavigation`/`ExternalUrlLink` (web/dev path) | Add scheme allowlist before new data-driven links |
| UI-SEC-F4 | MEDIUM (web) / LOW (desktop) | Plaintext access token in `sessionStorage`; secure-store fallback to plaintext | Do not weaken; never move tokens to `localStorage` |
| UI-SEC-F5 | MEDIUM | No runtime zod validation of backend/IPC/WS payloads; `naniApi`/`ws.ts` cast DTOs | Validate at transport/ws; especially relevant given F-12 DTO shape break |
| UI-SEC-F6 | MEDIUM | `reset_app_state` one click without confirmation in `AppErrorBoundary` | Add confirmation if touching that surface |
| UI-SEC-F7 | LOW | Raw backend error text surfaced in UI | Do not add new raw-detail rendering |
| UI-SEC-F9 | LOW | `withGlobalTauri` + insecure-loopback flag widen IPC trust | Required for sidecar; keep CSP tight |

## 3. New/reinforced findings in this mission

| Registry ID | Severity | Security/reliability issue |
|---|---|---|
| F-06 | P1 | NANI-021: proxy-intercepted HTTP recorded as `RouteKind::Direct` and surfaced as `health: "Healthy"` — an authorization/target-identity assumption, not just accuracy |
| F-12 | P2 | DTO fields removed without compatibility → untrusted-shape consumers can read `undefined` |
| F-13 | P2 | Suppressed persistence write errors (`let _ = persist_model_state()`) — silent durability loss |
| F-22 | P3 | Serde failures coerced to `Value::Null` in `commands/nani.rs:151,161`; TLS marked `Ok` for any response — error masking |
| F-07 | P2 | Timer/closure leak after unmount |
| F-21 | P3 | Unbounded DNS resolution; registry mutex held across probe (availability under malicious/slow resolver) |
| F-08 | P2 | Missing `verified` interpreted as success — fail-open in event interpretation |

## 4. Failure-mode review

| Scenario | Observed behavior | Assessment |
|---|---|---|
| Backend unavailable | `tauriInvoke` propagates rejection; NANI hook retries from same cursor; UI error states exist | Honest (no fake success) — except web health F-03 |
| Command timeout | Rust probe timeouts exist for HTTP; DNS unbounded (F-21); N1.1 gate has 6 s wait that is failing under load (F-15) | Partial |
| Network disconnected | Probes record failures; no direct-path guarantee under proxy (F-06) | Unsafe for diagnosis claims |
| Invalid configuration | Shared models + ad-hoc guards; no zod validation (carried F5) | Weak but pre-existing |
| Malformed response | Cast-only DTOs; serde errors masked to `Null` (F-22) | Weak |
| Restart during operation | Bounded replay + `since` cursor recovery; event gap computed but ignored (F-07) | Partial |
| Investigation cancellation | K-2 release-once paths verified in prior review | Sound |
| Repeated user actions | K-2 atomic admission cap 4; health events unbounded (F-13) | Partial |
| Rapid navigation during async work | F-07 leak; no other stale-update path found | Defect present |

## 5. Verdict

**No new critical security exposure was introduced by the redesign; the carried HIGH item remains contained.** Reliability is **PARTIAL**: one P1 honesty/security-adjacent defect (F-06), fail-open event interpretation (F-08), silent durability loss (F-13), and masked command errors (F-22) remain. No production or remote change occurred.
