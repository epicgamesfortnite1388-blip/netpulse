# VPN Deployment — Task Board

**Mission:** NETPULSE-LIVE-VPN-2026
**Created:** 2026-10-23
**Orchestrator:** A0

## Baseline (verified)

- Vpn_app HEAD: `48c1794` (main), clean except untracked `VPS-KEYS.txt`
- Abystral HEAD: `20f10f9` (feat/iran-connection-diagnostics), 23 modified + 7 untracked
- VPS: 206.1.96.89, Ubuntu 24.04.5 LTS, 961MB RAM, 14GB disk, 6 days uptime
- SSH: root via Ed25519 key (passphrase never printed)

## Agent Assignments

| Agent | Role | Status |
|---|---|---|
| A0 | Orchestrator | ACTIVE |
| A1 | Xray/V2Ray | PARTIAL — live tests done |
| A2 | WhiteDNS Soar/Cotten | NOT STARTED |
| A3 | WireGuard/DNS | PARTIAL — restart/idempotency verified |
| A4 | NetPulse Windows | NOT STARTED |
| A5 | Subscription/Bot/CF | NOT STARTED |
| A6 | Security/Ops | PARTIAL — services inventoried |
| A7 | Real Tests/Release | PARTIAL — VPS tests done |

## Live VPS Services Verified

| Service | Port | Status | Live Test |
|---|---|---|---|
| netpulse-xray | 443, 8388, 8443, 2053, 2087 | active | SS PASS, REALITY PASS |
| x-ui | 2083, 2096 | active | not tested |
| netpulse-dnstt | DNS tunnel | active | not tested |
| netpulse-hysteria | QUIC | active | not tested |
| netpulse-socks | 18080 (loopback) | active | PARTIAL (HTTPS 000) |
| wg-quick@wg0 | 51820 | active | restart PASS, idempotency PASS |

## Key Findings

1. Xray REALITY key rotated at 05:40 UTC (backup exists); new key works (HTTPS 200)
2. Shadowsocks 2022-blake3-aes-128-gcm: HTTPS 200 via tunnel
3. WireGuard: restart + idempotency verified; reboot/peer not tested
4. Microsocks: auth enforced, HTTP works, HTTPS returned 000
5. x-ui panel publicly exposed on 0.0.0.0:2083/2096 (security concern)
6. Old REALITY key backup at /opt/netpulse-xray/config.json.bak-20261023T054011Z
7. WhiteDNS identity unconfirmed — netpulse-dnstt is DNS tunnel, not WhiteDNS Soar
8. VPS-KEYS.txt untracked contains SSH private key + passphrase (secret exposure)

## Blockers

- B1: WhiteDNS Soar/Cotten server not deployed (identity unconfirmed)
- B2: No payment provider sandbox
- B3: No Telegram test user / staging bot
- B4: WireGuard reboot persistence not tested
- B5: Microsocks HTTPS issue unresolved
- B6: x-ui panel publicly exposed
- B7: Old REALITY key backup not securely deleted
