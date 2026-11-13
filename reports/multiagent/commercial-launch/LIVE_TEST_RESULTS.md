# Live Test Results — Commercial Launch

**Date:** 2026-10-23
**VPS:** 206.1.96.89 (Ubuntu 24.04.5 LTS, 961MB RAM, 14GB disk)
**Access:** SSH root (key-based, passphrase handled securely, never printed)

## Live VPN Test Results

### Shadowsocks (port 8388, 2022-blake3-aes-128-gcm)
- **PASS** — HTTPS 200 via tunnel, egress IP 206.1.96.89

### VLESS REALITY (port 443, dest www.microsoft.com:443)
- **PASS** — HTTPS 200 via tunnel, egress IP 206.1.96.89
- REALITY handshake succeeded with derived public key (sanitized)
- Key rotation confirmed: backup file config.json.bak-20261023T054011Z exists

### Microsocks (port 18080, loopback only)
- Auth required: **PASS** (unauthenticated → rejected)
- With creds: HTTP works, HTTPS returned 000 (PARTIAL)
- Env file: 600 root:root (PASS)

### WireGuard (wg0, 10.66.66.1/24, port 51820)
- Restart: **PASS** (active after restart)
- Second restart: **PASS**
- PostUp idempotency: **PASS** (MASQUERADE rule not duplicated)
- Reboot persistence: NOT TESTED (no reboot per policy)
- Peer connectivity: NOT TESTED (no peer client)

## Services Running
- netpulse-xray (active, enabled)
- x-ui (active, enabled)
- netpulse-dnstt (active, running)
- netpulse-hysteria (active, running)
- netpulse-socks (active, running)
- wg-quick@wg0 (active, exited)

## Security Notes
- microsocks and xray loopback services bound to 127.0.0.1 only (good)
- x-ui panel exposed on 0.0.0.0:2083/2096 (should be restricted)
- Old REALITY key backup exists (should be securely deleted)
- No WireGuard peer tested (no test peer available)
- No payment provider sandbox confirmed
- No Telegram test user / staging bot available
- WhiteDNS identity still unconfirmed
