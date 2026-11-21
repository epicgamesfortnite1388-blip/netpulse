# 14 — Findings and Repairs (master list for this cycle)

The authoritative register is `DEEP_DISCOVERY_FINDINGS.md`. This is the human-readable summary of cycle-2 work. IDs DD-060..DD-064 were remapped from an initial DD-032..DD-036 collision with concurrent work; see the reconciliation note in the register.

## Repairs implemented (with verification)

| ID | Sev | Defect | Repair | Evidence |
|---|---|---|---|---|
| DD-049 | **P1** | Elevated WireGuard connect impossible: UI sent only opId; broker minted and discarded a nonce; Rust `/pending` fetch omitted it and the API requires it | UI mints 48-hex nonce, sends it in `/vpn/connect` and IPC; Rust validates and includes `?opId=&nonce=`; broker binds the UI-supplied value | Rust elevation 12/0; API elevation 12/0; typechecks PASS; new tests at both seams |
| DD-061 | **P1** | System Health "Reset App State" toasted success but did nothing | Now performs the same confirmed, backed-up `reset_app_state` operation inline (Kim corrected the initial navigate-to-hidden-control fix) | web typecheck PASS; code-path traced to `reset_app_state` |
| DD-062 | P2 | Node "Direct vs VPN" ignored the clicked node | RoutesPage consumes `nodeId` and calls the existing server-side `?nodeId=` API | typecheck PASS; API contract `routes.ts:71-98` |
| DD-001 | P2 | Release could succeed without updater artifacts | `NETPULSE_REQUIRE_UPDATER_FEED=1` on release:feed | `test:build-gates` 10/10 |
| DD-002 | P2 | CI did not run release-readiness suites | Added signing/release/pipeline/build-gates steps | all four pass locally |
| DD-003 | P2 | `desktop:prepare` could stage a runtime-less bundle | Hard failure unless explicit fallback opt-in | `test:build-gates` 10/10 |
| DD-011 | P3 | DPAPI failure silently downgraded tokens to plaintext | Desktop failure now fails closed; only genuinely plaintext stale values removed (Kim P2) | `secureStoreFailClosed.test.ts` 4/4 |
| DD-004/005 | P3 | Warn-only/false-PASS gates | Honest advisory labeling; Cargo/endpoint hard failures | `test:build-gates` 10/10; `node scripts/release.mjs` PASS |
| Counterpart DD-032 | P2 | NANI K-1 correlation window used ms constant against seconds clock | Renamed to `CORRELATION_WINDOW_SECONDS = 5*60`; fixture corrected; new regression test; mutation verified | report 06, 22/0 diagnosis tests |
| Counterpart DD-033 | P2 | AI proxy role escalation | `resolveAiRole()` from verified D1 role | `cloud/worker/test/aiRole.test.ts` 4/0 |
| Counterpart DD-034 | P2 | OpenVPN config allowed side-effecting directives | `openVpnUnsafeDirective()` at import time | `vpnImportHardening.test.ts` 15/0 |
| Counterpart DD-035 | P2 | `useBackgroundTest` showed stale results across runs | Reset on id transition | `backgroundTestState.test.tsx` 3/0 |

## Blocked / not changed (with reason)

| ID | Sev | Reason |
|---|---|---|
| DD-060 | **P0** | Committed SSH key requires key rotation and git-history rewriting — both explicitly outside this mission's authorization. Owner action required. |
| DD-042 | P2 | NANI per-condition accuracy needs a mathematically justified policy; documented, math engine preserved |
| DD-050 | P4 | Removing permissive e2e status assertions requires a built installer and staged sidecar, unavailable here |
| DD-051/052/053/054 | P4 | Low-impact doc/orphan/a11y items; documented, not changed (see 17) |

## Process discipline

No commits, pushes, deployments, history rewrites, resets or destructive cleanup were performed. No system routes, DNS or proxy settings were modified. No real accounts or production systems were touched. Every source change was made with exact-string edits so concurrent edits could not be silently clobbered.
