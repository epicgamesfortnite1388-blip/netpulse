# Commercial Launch — Task Board

**Mission:** NETPULSE COMMERCIAL VPN LAUNCH (live VPS + WhiteDNS + V2Ray + app purchases + Telegram)
**Created:** 2026-10-23
**Orchestrator:** A0

## Baseline

- Vpn_app HEAD: `48c1794` (main), clean except untracked `VPS-KEYS.txt`.
- Abystral HEAD: `20f10f9` (feat/iran-connection-diagnostics), 23 modified + 7 untracked.
- feat/iran-resilience exists (large diff vs main).
- VPS-KEYS.txt contains SSH private key + passphrase (UNTRACKED, secret exposure).

## Agent assignments

| Agent | Role | Status |
|---|---|---|
| A0 | Orchestrator | ACTIVE |
| A1 | WhiteDNS/V2Ray/VPS | NOT STARTED |
| A2 | Backend/Cloudflare/D1 | NOT STARTED |
| A3 | Desktop app | NOT STARTED |
| A4 | Telegram bot | NOT STARTED |
| A5 | Security/payments | NOT STARTED |
| A6 | Live QA | NOT STARTED |
| A7 | Independent review | NOT STARTED |

## Active tasks

| ID | Owner | Task | Status |
|---|---|---|---|
| T0.1 | A0 | Create board + baseline | DONE |
| T0.2 | A0 | Remove VPS-KEYS.txt from tree (secret exposure) | IN PROGRESS |
| T0.3 | A0 | Record git state + reflog | DONE |
| T1.1 | A1 | Inspect WhiteDNS repos + Xray | NOT STARTED |
| T1.2 | A1 | VPS baseline (requires SSH) | BLOCKED (key passphrase in secret file) |
| T2.1 | A2 | Inspect Worker + D1 + routes | NOT STARTED |
| T3.1 | A3 | Inspect desktop purchase flow | NOT STARTED |
| T4.1 | A4 | Inspect bot purchase flow | NOT STARTED |

## Blockers

- B1: VPS access requires passphrase from VPS-KEYS.txt; using it would echo secret. Need secure channel.
- B2: No payment provider sandbox confirmed.
- B3: No Telegram test user / staging bot.
- B4: WhiteDNS identity unconfirmed.

## Notes

- Preserve all owner changes; do not reset/clean.
- Do not restore old REALITY key.
