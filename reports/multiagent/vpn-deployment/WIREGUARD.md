# WireGuard Verification

**VPS:** 206.1.96.89
**Date:** 2026-10-23

## Configuration (sanitized)

- Interface: wg0, 10.66.66.1/24, MTU 1280, ListenPort 51820
- Peer: 10.66.66.2/32 (netpulse-peer-1)
- PostUp: idempotent (iptables -C check before -A)
- PostDown: cleanup rules
- MASQUERADE: 10.66.66.0/24 → eth0

## Live Tests

### Service Restart
- systemctl restart wg-quick@wg0 → active, interface re-established **PASS**
- Second restart → active **PASS**

### PostUp/PostDown Idempotency
- MASQUERADE rule present once after repeated restarts **PASS**
- No rule duplication **PASS**

### Not Tested
- Reboot persistence (no reboot performed per policy)
- Peer handshake (no test peer client available)
- DNS through tunnel (no peer available)
- Peer revocation (no peer management tested)
- IPv6 (not configured)

## Limitations

- Only one peer configured (netpulse-peer-1)
- No per-user peer provisioning
- No automated peer management
- Reboot persistence not verified
- No client-side test performed
