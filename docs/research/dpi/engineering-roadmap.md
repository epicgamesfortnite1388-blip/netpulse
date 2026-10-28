# Engineering Roadmap

Ranked by user impact and evidence strength. Status reflects this iteration
(2026-10-25).

## P0 — correctness and truthfulness

| ID | Task | Why | Acceptance | Status |
|---|---|---|---|---|
| DPI-01 | Require authoritative `AA=1` + exact-zone NS/SOA (or labeled parent SOA) in the WhiteDNS DNS stage | old check passed on any authority section; local TUN returns forged empty `AA=1` | unit tests for AA/referral/parent/empty; API test green | **DONE** |
| DPI-02 | Make TCP/53 a real DNS query, not a port-open probe | an open socket can be a local interceptor | `tcpQuery` framing + matching ID; service uses it | **DONE** |
| DPI-03 | Use `WHITEDNS_PUBKEY` when the UI omits the key | the authenticated tunnel stage could never run from the UI | service fallback + validation | **DONE** |
| DPI-04 | Allow `WHITEDNS_SOAR_CHECK` and skip honestly when absent | API runs on Windows; Linux path is wrong there | configurable path; no false pass | **DONE** |
| DPI-05 | Record the Windows TUN/DNS blocker in the test record | local DNS results were invalid | route/DNS evidence + `BLOCKED_ENVIRONMENT` | **DONE** |
| DPI-06 | Keep the real VPS Soar result separate from Iran claims | prevent overclaiming | labels + vantage note | **DONE** |
| DPI-07 | Add HTTP CONNECT proxy support for TCP DNS | Windows TUN forges UDP answers; proxy is open | `WHITEDNS_PROXY` + proxy fallback + unit test | **DONE** |
| DPI-08 | Prove a Windows Soar client through the local proxy | direct Windows DNS is blocked | HTTP 200 over TCP/53 via `127.0.0.1:10808` | **DONE** (lab client) |

## P1 — product integration

| ID | Task | Why | Acceptance |
|---|---|---|---|
| DPI-10 | Choose the **shipping** Windows WhiteDNS client path | the lab Go client proves the protocol but is not a product artifact | one of: authenticated VPS diagnostic, pinned Windows build, or external CottenDNS/WhiteDNS Desktop workflow |
| DPI-11 | Bind WhiteDNS profile to D1 entitlement | current test profile is shared | per-user profile; expiry/revocation test |
| DPI-12 | Rotate the exposed panel path; keep panel loopback-only | path was exposed during troubleshooting | owner-approved rotation; no public port |
| DPI-13 | Fix child-zone apex NS / SOA MNAME | current zone is non-conforming | authoritative query shows conforming NS/SOA |
| DPI-14 | Add a real Windows client test without a conflicting TUN | current test is blocked | stage evidence with route snapshot |
| DPI-15 | Per-user Xray/Hysteria credentials and server sync | shared credentials cannot be revoked | **DONE** — 5 protocols live-proven; expiry removes the identity ≤60 s (`reports/accounting/PER_USER_CREDENTIAL_LIVE_PROOF_2026-10-25.md`) |

P1 status (2026-10-26): DPI-15 is closed with live evidence. DPI-11's
issuance side is closed by *withholding* WhiteDNS (`skipped:
no_per_user_identity`, guarded by a Worker test) — the product consequence is
that WhiteDNS is not delivered to anyone until per-user zones exist, which is
DPI-11's remaining half and needs panel API access. DPI-10, DPI-12, DPI-13 and
DPI-14 stay open for the reasons already listed; none of them can be closed
from the repository alone.

Revocation half of DPI-15, now reproducible off-host (2026-10-26):
`scripts/verify-vps-reconciler-removal.py` runs the reconciler in `--print`
mode with a rotated secret, a revoked identity and an expired identity, and
fails if any of them survives into the config that would be written (20/20 in
three configurations; evidence in
`reports/accounting/VPS_RECONCILER_REMOVAL_DRYRUN_2026-10-26.md`). The
live-host half of that check is BLOCKED on SSH access to `206.1.96.89`, not on
missing implementation.

## P2 — measurement and resilience

| ID | Task | Why | Acceptance |
|---|---|---|---|
| DPI-20 | 20-attempt matrix per path, two vantages | single runs are noise | median/p95, failure stages, confounders |
| DPI-21 | Bounded transport selector in staging | static preference is not adaptive | offline evaluation + no leak/false-positive regression |
| DPI-22 | DNS leak tests per mode | DoH/tunnel claims are unproven | controlled query observation + restore test |
| DPI-23 | ECH feasibility on a NetPulse-controlled front | ECH is often misclaimed | ECHConfig publication, acceptance/rejection test |
| DPI-24 | WhiteDNS throughput/latency under loss/rate limits | DNS tunnel performance is unknown | bounded emulation + real VPS |
| DPI-25 | License review: CottenDNS aggregate, WhiteDNS Desktop, StormDNS | reuse risk | written review before vendoring |

## P3 — research

| ID | Task | Why |
|---|---|---|
| DPI-30 | Parse and reproduce FOCI 2026 | current entry is unread |
| DPI-31 | Compare REALITY target policies under active probing (authorized) | target choice is operational risk |
| DPI-32 | Evaluate ECH + encrypted DNS end to end | determine if it helps the actual path |
| DPI-33 | Evaluate CottenMax vs Soar on the same loss/rate-limit profile | choose the DNS engine on evidence |
| DPI-34 | Build a privacy-preserving network-context cache for the selector | avoid destination history |

## Do-not-do list

- Do not install a duplicate WhiteDNS/dnstt stack.
- Do not re-enable the old `netpulse-dnstt` while Soar owns 53.
- Do not expose the panel or commit its path.
- Do not copy proprietary Android code or ship an APK.
- Do not claim Iran readiness from VPS-only tests.
- Do not enable an experimental transport globally after one success.
