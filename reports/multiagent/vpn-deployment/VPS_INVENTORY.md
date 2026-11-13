# VPS Inventory (sanitized)

- Host: vpn (206.1.96.89), Ubuntu 24.04.5 LTS, kernel 6.8.0-139-generic, x86_64
- Resources: 1 vCPU, 961 MiB RAM (473 used), 14G disk (3.0G used, 11G free), no swap
- SSH: BatchMode access verified as root via authorized agent key (no secret echoed)
- Active units: netpulse-dnstt, netpulse-hysteria, netpulse-socks, netpulse-xray, x-ui
- WireGuard: wg0 up, listening 51820/udp, 1 peer (10.66.66.2/32)
- Listeners: xray on 443/tcp, 8388/tcp+udp, 8443/tcp+udp, 2053/tcp, 2087/tcp; x-ui on 2083/2096; hysteria 8443/udp; dnstt 53/udp; microsocks 18080 (loopback); python 8080/18081; sshd 22
- systemd-resolved on 127.0.0.53/54 (loopback only)
- Baseline captured 2026-10-23. No modifications performed.
