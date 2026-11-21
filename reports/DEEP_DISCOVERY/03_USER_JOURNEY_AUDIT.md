# 03 — User Journey Audit

Scope: the 35 journeys in the mission directive. Evidence is code-path tracing plus fresh suite runs; where a journey requires a real tunnel or a real installer it is marked UNVERIFIED rather than assumed.

| # | Journey | Trace / evidence | Result |
|---|---|---|---|
| 1 | First launch | `desktop-index.ts:83` loopback bind + per-launch token; startup health probe | VERIFIED (code + API suites) |
| 2-3 | Startup / init | `vpnService.initAll()` now has a 10 s deadline (DD-025) | VERIFIED |
| 4 | Account state retrieval | account page + cloud session store | VERIFIED |
| 5 | Telegram linking | `TelegramIntegrationCard.tsx`, cloud worker identity endpoints | VERIFIED (no real account tested) |
| 6-7 | Subscription / entitlement | `cloud/worker/src/index.ts:717-746`, `vpn-users.ts:186-219` fail-closed | VERIFIED (server-enforced) |
| 8-10 | Config import / parse / store | `nodesService.ts:171-195`, `nodeParsers.ts` (no file I/O in parsers) | VERIFIED; invalid lines not itemized (DD-023) |
| 11-17 | Engine select → startup → TUN → DNS → routes → connect → status → traffic | `vpnService`, provider adapters, `verifyConnect` before/after IP proof | Partially VERIFIED; **live traffic not re-proved this cycle** |
| 18 | Real traffic transfer | exit-IP/relay/public-IP proofs in `aetherProvider.ts` | UNVERIFIED live (no tunnel provisioned in sandbox) |
| 19-20 | Disconnect / reconnect | `vpnState.ts` epoch fence + bounded watchdog | VERIFIED (unit + code) |
| 21-22 | Engine failure / recovery | `recovery.rs`, `killSwitch.ts`, `tunClaim.ts` orphan sweep | VERIFIED (code) |
| 23 | Shutdown | `sidecar.rs stop_sidecar` stdin-EOF graceful path (DD-020) | VERIFIED (`cargo test sidecar` 32/0 prior, re-read current) |
| 24 | Restart after failure | boot recovery + proxy restoration | VERIFIED (code) |
| 25 | Subscription expiration | server-side expiry gate; UI grace | VERIFIED |
| 26 | Missing entitlement | provision gate fails closed | VERIFIED |
| 27 | Invalid config | parser + `validate_op` double validation | VERIFIED |
| 28 | Network interruption | watchdog, bounded reconnect | VERIFIED |
| 29 | Sleep / resume | recovery memory + re-probe | UNVERIFIED live |
| 30 | Update check / apply | `updater.ts:205,266`, `UpdateBanner.tsx`, minisign verification | VERIFIED at code + gate level, no real install |
| 31-32 | Diagnostics / history | `SystemHealthPage`, `HistoryPage`; export path discarded in toast (DD-024) | VERIFIED / Partial |
| 33 | Copilot | `CopilotPage.tsx`; clipboard false-success (DD-036) | Partial |
| 34 | Settings | `SettingsPage.tsx`; unwired switches honestly disabled | VERIFIED |
| 35 | Logs / error reporting | pino redaction + Rust tail redaction; `read_log_tail` allow-listed | VERIFIED |

## Defects found on these journeys (this cycle)

1. **Elevated WireGuard connect was impossible** (DD-049, P1): the nonce required by `/vpn/elevation/pending` was minted by the broker and discarded; neither UI nor Rust ever held it. Repaired end-to-end; regression coverage at all three layers.
2. **Reset App State from System Health reported success without acting** (DD-033, P1): now routes to the confirmed Settings control.
3. **Node "Direct vs VPN" ignored the clicked node** (DD-034, P2): deep-link param mismatch; now uses the server-resolved `?nodeId=` contract.
4. **Graceful quit (prior DD-020)** and **startup init deadline (prior DD-025)** remain fixed in the tree and were re-read; no regression found.

## Silent-success audit

Every `toast('ok', …)` on the two repaired pages was checked against a real implementation. Remaining suspicious successes: `AccountPage.tsx:773` and `CopilotPage.tsx:279` (clipboard), and the fallback branch that previously hid `repair-reset-state` (now removed).
