# Xray / V2Ray Verification

**VPS:** 206.1.96.89
**Date:** 2026-10-23

## Inbounds Configured

| Protocol | Port | Tag | Security | Status |
|---|---|---|---|---|
| VLESS | 443 | vless-reality | REALITY (dest www.microsoft.com:443) | **LIVE TESTED PASS** |
| VMess | 8443 | vmess-ws | WebSocket | not tested |
| VLESS | 2053 | vless-ws-tls | WebSocket + TLS | not tested |
| Trojan | 2087 | trojan-tls | TLS | not tested |
| Shadowsocks | 8388 | ss2022 | 2022-blake3-aes-128-gcm | **LIVE TESTED PASS** |

## Live Test Results

### Shadowsocks (port 8388)
- Client: Xray SOCKS proxy on 10808 → SS outbound to 127.0.0.1:8388
- HTTPS: 200 from www.google.com
- Egress IP: 206.1.96.89
- **PASS**

### VLESS REALITY (port 443)
- Client: Xray SOCKS proxy on 10809 → VLESS Reality outbound to 127.0.0.1:443
- HTTPS: 200 from www.google.com
- Egress IP: 206.1.96.89
- REALITY handshake: succeeded with derived public key
- **PASS**

## Key Rotation

- Backup: config.json.bak-20261023T054011Z (confirms rotation at 05:40 UTC)
- Current key differs from backup
- Old key in backup file — should be securely deleted
- Profile generation uses current active keypair

## Limitations

- VMess WS, VLESS WS-TLS, Trojan TLS not live-tested
- No per-user provisioning adapter yet
- x-ui panel publicly exposed (security concern)
- No profile delivery API integrated with D1/Cloudflare
