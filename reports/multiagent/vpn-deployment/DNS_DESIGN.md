# DNS Design

**VPS:** 206.1.96.89

## DNS Paths Identified

1. **Plain DNS (systemd-resolved):** 127.0.0.53, 127.0.0.54 — loopback resolver
2. **Xray sniffing:** enabled on Shadowsocks inbound (destOverride http, tls, quic)
3. **dnstt DNS tunnel:** netpulse-dnstt.service (separate DNS tunnel, not WhiteDNS)
4. **WireGuard tunnel DNS:** not configured (no DNS= in wg0.conf)
5. **DoH/DoT:** not configured on VPS

## Current DNS State

- systemd-resolved active on 127.0.0.53/54
- Xray inbounds have sniffing enabled (SS inbound overrides dest)
- No dedicated DoH/DoT endpoint configured
- No DNS leak protection configured for WireGuard (no DNS= in peer config)
- WireGuard PostUp/PostDown do not modify resolv.conf

## Limitations

- No DoH/DoT endpoint verified
- No DNS leak test performed
- WireGuard DNS not configured (clients use their own resolver)
- dnstt is a DNS tunnel but not WhiteDNS Soar/Cotten
- No DNS path verification through tunnel performed
