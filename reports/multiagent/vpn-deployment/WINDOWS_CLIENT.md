# Windows Client Integration

**Status:** NOT YET TESTED — no NetPulse Windows client execution performed this session.

## Current Codebase

- NetPulse desktop app: Tauri + React/TypeScript + Rust
- Location: `apps/` in Vpn_app repo
- Engine abstraction exists (proxy cores: xray, sing-box, v2ray, hysteria)
- VPN providers: WireGuard, OpenVPN, sing-box, Aether

## Engine Matrix (from codebase inspection)

| Engine | Supported | Config Format | TUN/System Proxy | Elevation Required |
|---|---|---|---|---|
| Xray | yes | JSON config | both | TUN: yes |
| V2Ray | yes | JSON config | both | TUN: yes |
| sing-box | yes | JSON config | both | TUN: yes |
| Hysteria2 | yes | YAML config | both | TUN: yes |
| WireGuard | yes | wg-quick conf | TUN only | yes |
| Shadowsocks | via Xray | JSON (Xray) | both | TUN: yes |

## Limitations

- No real Windows client test performed this session
- No profile import/connect cycle tested
- No TUN adapter creation tested (requires elevation)
- Kill switch not verified
- WhiteDNS Windows integration not established (may require external client)
- No engine version pinned/verified against VPS Xray version
