# Security Review

**Date:** 2026-10-23
**Scope:** VPS services, secrets, firewall, provisioning

## Findings

### CRITICAL
1. **VPS-KEYS.txt untracked** — contains SSH private key + passphrase in working tree. Must be deleted and key rotated.
2. **Old REALITY key backup** — /opt/netpulse-xray/config.json.bak-20261023T054011Z contains compromised key. Should be securely deleted.

### HIGH
3. **x-ui panel publicly exposed** — ports 2083, 2096 on 0.0.0.0. Admin panel accessible from internet. Should be restricted to localhost or admin IP.
4. **Single shared client UUID** — all profiles use same UUID f5e39e90-6322-418b-a397-6044ac40abdb. Per-user provisioning needed.
5. **No per-user provisioning** — no automated client creation/revocation.

### MEDIUM
6. **Microsocks HTTPS issue** — HTTPS returned 000 via microsocks; needs investigation.
7. **No WireGuard peer management** — only one static peer configured.
8. **No DNS leak protection** — WireGuard has no DNS= setting; clients use own resolver.
9. **No kill switch verified** — requires Windows elevation.

### LOW
10. **WhiteDNS identity unconfirmed** — dnstt running but not WhiteDNS Soar.
11. **No DoH/DoT endpoint** — not configured.
12. **No payment provider sandbox** — TON mainnet only, card/C2C requires admin approval.

## Positive Findings

- microsocks bound to 127.0.0.1 only ✅
- Xray loopback services bound to 127.0.0.1 ✅
- microsocks env file 600 root:root ✅
- WireGuard PostUp idempotent (no rule duplication) ✅
- Cloudflare Worker cross-account isolation verified ✅
- Signed inbox rejects unsigned requests (401) ✅
- REALITY key rotated (backup confirms) ✅
- SSH key-based auth only ✅
- fail2ban active ✅
