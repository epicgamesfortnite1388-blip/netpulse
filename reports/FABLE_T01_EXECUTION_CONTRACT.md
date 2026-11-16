# FABLE — T-01 Execution Contract: Eliminate Competing NANI Authority

## 1. Current behavior (traced, re-validated)

- `apps/api/src/app.ts:608` constructs `NaniService`; `:651` constructs `NaniShadowHealthLoop`; `:897` calls `naniShadowHealth.start()` **unconditionally** — including desktop mode (`NETPULSE_DESKTOP=1`).
- The loop runs `nani.runShadowHealthPass()` on a timer → `naniProbeAdapter` opens real sockets → results land in the Node registry + SQLite.
- Concurrently the Rust `MonitorLoop` (wired in `main.rs`) probes the same APIs → `registry.rs` + `persistence.rs`.
- Result (FABLE-ARCH-001): two probing loops, two registries, two truth sources in desktop.

## 2. Problem & root cause

Web-mode NANI was added for browser operation; the desktop never turned it off. No consumer in desktop reads the Node NANI state (verified: `naniApi.ts` routes to Tauri when `hasTauriIpc()`; `AppShell` references `/nani` for navigation only).

## 3. Target behavior

Desktop (`NETPULSE_DESKTOP=1`): Node NANI **loops** do not start. Web mode: unchanged. One-shot Node NANI routes remain available in both modes (they are read-only endpoints; no loop).

## 4. Exact source files & symbols

| File | Symbol/line | Change |
|---|---|---|
| `apps/api/src/app.ts` | `:897 naniShadowHealth.start()` | Wrap: `if (!isDesktop) naniShadowHealth.start();` where `isDesktop = process.env['NETPULSE_DESKTOP'] === '1'` (constant already used at `app.ts:215`) |
| `apps/api/src/services/naniService.ts` | any internal `setInterval`/`.start(` timers | Grep and gate identically **only if they are loops**; the in-flight work added `runShadowHealthPass`-adjacent exports — do not alter their logic |
| `apps/api/test/naniShadowHealthLoop.test.ts` (or nearest) | — | New case: with `NETPULSE_DESKTOP=1`, `start` is not invoked (spy via deps seam) |

## 5. Call paths affected

`app.ts boot → naniShadowHealth.start() → setInterval → nani.runShadowHealthPass() → naniProbeAdapter.runDiagnosticTest()` — the change severs exactly the first hop. Nothing downstream changes for web.

## 6. Required API/event changes

**None.** Routes `/nani/*`, `nani:*` topics, and Tauri contracts are untouched (Rule O-5).

## 7. Persistence changes

**None.** Shadow SQLite history remains as historical records; no writes in desktop mode after the gate.

## 8. Migration strategy

None required (behavioral gate only). Compatibility: web deployments unaffected; desktop gains only the absence of background Node NANI work.

## 9. Mathematical parity requirements

Not applicable (no math touched). FABLE-MATH-003 constraint respected trivially.

## 10–12. Tests

- **Unit**: gate test (above); web-mode default-on test (guards against accidental global off).
- **Integration**: boot app with `NETPULSE_DESKTOP=1` in a test harness → assert no `nani:*` events emitted within the shadow interval ×2; boot without the env → events still flow.
- **Regression**: `npx vitest run test/nani*` + full API suite; Rust suite untouched (no Rust change) but run once for the record.

## 13. Performance expectations

Desktop: eliminates one full probing loop (network + CPU). Measured basis: dual engines identified in Phase 1; expect roughly halved NANI background traffic.

## 14. Rollback

Single-commit revert restores unconditional start. No data/contract effects.

## 15. Objective acceptance criteria

1. With `NETPULSE_DESKTOP=1`: zero Node NANI timer invocations over one shadow interval (spy + log evidence).
2. Without the env: shadow loop starts as before (test green).
3. All existing tests green; no new warnings.
4. `naniApi.ts` desktop flows still function (manual one-run check).
5. Gate F evidence: diff + test output attached to the ticket.

## Gate notes

- **Gate A**: re-verify `app.ts:897` line number may have shifted (in-flight churn) — locate by symbol, not line.
- **Gate D (Gemini)**: verify no desktop consumer silently depended on shadow-published events (grep consumers of `nani:*` topics in webview transport; confirm all NANI UI in desktop comes from Tauri channel).
