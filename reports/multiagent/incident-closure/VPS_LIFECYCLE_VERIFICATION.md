# VPS Lifecycle Verification (Updated with Live Evidence)

**Scope:** A6 — live VPS verification performed 2026-10-23 via SSH (root@206.1.96.89).

## VPS Identity

- OS: Ubuntu 24.04.5 LTS
- Uptime: ~6 days 20 hours
- RAM: 961 MiB total, 467 MiB used, 494 MiB available
- Disk: 14G total, 3.0G used (23%), 11G free
- CPU: load avg 0.06 / 0.02 / 0.00 (idle)

## Services (systemd active units)

| Unit | Status | Notes |
|---|---|---|
| netpulse-xray.service | active, enabled | Xray VLESS Reality + VMess WS + Trojan + Shadowsocks 2022 |
| x-ui.service | active, enabled | 3x-ui management panel (ports 2083, 2096) |
| netpulse-dnstt.service | active, running | DNS tunnel |
| netpulse-hysteria.service | active, running | Hysteria2 QUIC |
| netpulse-socks.service | active, running | microsocks loopback SOCKS5 upstream for dnstt |
| wg-quick@wg0.service | active, exited | WireGuard 10.66.66.1/24, port 51820 |

## Xray Configuration (sanitized)

- Inbounds: vless 443 (reality), vmess 8443 (ws), vless 2053 (ws-tls), trojan 2087 (tls), shadowsocks 8388 (2022-blake3-aes-128-gcm)
- Outbounds: freedom, blackhole
- Log level: warning
- REALITY: dest www.microsoft.com:443, serverNames [www.microsoft.com], shortIds [674622f7], privateKey present (REDACTED), no publicKey field (correct — client derives from private key)
- REALITY public key derived: CAS1AR2c9NrFKDMP1JVMIHx1y4_nxY8HqlemAGclsgU
- Client UUID: f5e39e90-6322-418b-a397-6044ac40abdb, flow xtls-rprx-vision
- Backup: config.json.bak-20261023T054011Z (key rotation at 05:40 UTC confirmed)

## Key Rotation Verification

- Backup file `config.json.bak-20261023T054011Z` exists — confirms key rotation occurred around 05:40 UTC on 2026-10-23.
- Current config uses a different privateKey than backup (rotation performed).
- Old key material exists only in backup file (retained operational artifact). Recommendation: secure or remove backup after confirming new key works.

## Live VPN Test Results

### Shadowsocks (127.0.0.1:8388)
- Client (Xray as SOCKS proxy on 10808 → SS outbound to 127.0.0.1:8388): **PASS**
- HTTPS via tunnel: HTTP 200 from www.google.com
- Egress IP observed: 206.1.96.89
- Result: **PASS**

### VLESS REALITY (127.0.0.1:443)
- Client (Xray SOCKS proxy on 10809 → VLESS Reality outbound to 127.0.0.1:443): **PASS**
- HTTPS via tunnel: HTTP 200 from www.google.com
- Egress IP observed: 206.1.96.89
- REALITY handshake succeeded with derived public key
- Result: **PASS**

### Microsocks (127.0.0.1:18080)
- Auth required: YES (without creds → connection rejected) **PASS**
- With creds: HTTPS connectivity returned HTTP 000 (connection issue — possible transient; SOCKS5 CONNECT for HTTPS may need investigation)
- IP test via microsocks: returned 206.1.96.89 (HTTP works)
- Env file: /etc/netpulse-socks.env, permissions 600 root:root (suitably restricted) **PASS**
- Result: **PARTIAL** (HTTP works, HTTPS returned 000)

### WireGuard (wg0)
- Interface: UP, 10.66.66.1/24, MTU 1280
- Peer: 10.66.66.2/32 (netpulse-peer-1)
- Restart test: systemctl restart wg-quick@wg0 → active, interface re-established **PASS**
- Second restart: active **PASS**
- PostUp idempotency: iptables rules not duplicated after repeated restarts (MASQUERADE rule present once) **PASS**
- Ping to 10.66.66.1: not tested (no peer client available in this session)
- Reboot persistence: not tested (no reboot performed per policy)
- Result: **PARTIAL** (restart + idempotency verified; reboot not tested)

## Firewall / Ports

- SSH (22), Xray (443, 8388, 8443, 2053, 2087), x-ui (2083, 2096) — all listening on 0.0.0.0
- microsocks (18080) and xray loopback (21901, 62789, 11111) — bound to 127.0.0.1 only **PASS** (not publicly exposed)
- iptables: FORWARD rules for wg0 present; MASQUERADE for 10.66.66.0/24 → eth0

## WhiteDNS

- netpulse-dnstt.service active (DNS tunnel) — present
- No separate WhiteDNS installation identified; dnstt is the DNS tunnel component
- WhiteDNS identity/purpose still not fully established (per policy, not installed)

## Residual Risks

1. Old REALITY key backup file exists at `/opt/netpulse-xray/config.json.bak-20261023T054011Z` — contains compromised key. Should be securely deleted.
2. Microsocks HTTPS returned 000 — needs investigation (may be transient or CONNECT handling issue).
3. WireGuard reboot persistence not tested (no reboot performed).
4. No peer client tested for WireGuard (no test peer available).
5. x-ui panel exposed on ports 2083/2096 — should be restricted to admin IP or localhost-only.
