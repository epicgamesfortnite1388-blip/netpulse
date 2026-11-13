# WhiteDNS Soar/Cotten � Operator TTY Checklist

## 2026-10-25 update — installed and live

The plan below is historical. The current state is:

- Soar panel **0.6.0** installed; `soar-panel` and `soar-panel-ops` active.
- Soar engine **v0.2.2**; diagnostic `soar-check 0.1.0`.
- Public listeners: `206.1.96.89:53` UDP and TCP. Panel: loopback only.
- `netpulse-dnstt` is disabled; Soar owns port 53.
- A real `soar-check` client authenticated through public recursive resolvers
  and fetched `https://example.com/` with HTTP 200 over UDP only, TCP only,
  and automatic transport. A wrong public key failed closed.
- The Windows host could **not** validate the same tunnel directly: an active
  `happ-xray` TUN owns the default route and all tested resolvers return an
  immediate empty `AA=1` answer. That is `BLOCKED_ENVIRONMENT`, not a server
  failure.
- The same Windows client, using the user's local Happ proxy
  (`127.0.0.1:10808`) for TCP/53 only, authenticated and fetched
  `https://example.com/` with HTTP 200 in ~3.4 s. This is a real Windows
  client through the local proxy, not a direct Iranian-path result.
- NetPulse now supports `WHITEDNS_PROXY` (HTTP CONNECT) for its TCP DNS
  checks; `soar-check` has no proxy mode, so the tunnel stage is skipped
  rather than faked.
- Open: rotate the exposed panel path, enable HTTPS without taking 443 from
  Xray, fix the child zone's missing apex NS/SOA conformance, and bind
  WhiteDNS profiles to NetPulse entitlements.

Evidence and the full analysis: `docs/research/dpi/`, especially
`results/2026-10-25-soar-live.md` and `whitedns-design.md`.

## Bundle (verified)
- Path on VPS: /root/whitedns-check/soar-panel-0.6.0-linux-amd64/
- Checksum: verified (sha256sum -c OK, 2026-10-23).
- Release: WhiteDNS Soar Panel 0.6.0 (stable), Ubuntu 24.04/amd64.

## Port-53 conflict (RESOLVED PLAN)
- Single public IP (206.1.96.89). No coexistence possible on same IP/UDP53.
- netpulse-dnstt occupies UDP/53 and TCP/53 on 206.1.96.89.
- Backup created: /root/netpulse-dnstt-backup-20261023/ (root-only, includes server.key + unit).
- Migration plan: stop netpulse-dnstt, run installer (frees UDP/53), old dnstt profiles become invalid; issue new Soar profiles.
- microsocks (18080) and other services untouched.
- Rollback: systemctl stop soar-panel; systemctl start netpulse-dnstt (unit preserved in backup).

## Required DNS values (owner must create before install)
- Domain: choose a dedicated zone, e.g. soar.<yourdomain>. (Do NOT reuse t.abystral.dpdns.org or MasterDNS zones.)
- A record: ns-soar.<zone> -> 206.1.96.89 (DNS-only, proxy OFF).
- NS record: <zone> -> ns-soar.<zone>.
- Keep existing MX/mail/website/VPN records unchanged.
- UDP/53 and TCP/53 must be open in provider firewall/NAT to 206.1.96.89.

## Interactive installer prompts (what to enter)
1. [1/7] Server/existing services � review only.
2. [2/7] DNS delegation � enter the zone, ns_host, public_ip (206.1.96.89), listen_ip (206.1.96.89).
3. [3/7] Admin account � choose admin username + 12-72 char password (local, never share).
4. [4/7] Access mode � 1=direct HTTP (test), 2=SSH tunnel/HTTPS (production). Management port default 2053.
5. [5/7] Review � type INSTALL (or MIGRATE if standalone soar-server present; here netpulse-dnstt is dnstt, so INSTALL).
6. [6/7] Install + verify � installer runs checks; temporary test account created then removed.
7. [7/7] Optional HTTPS/domain setup � can defer with 'n'.

## Exact owner command (interactive SSH session)
```
cd /root/whitedns-check/soar-panel-0.6.0-linux-amd64
bash panel-install.sh
```
Keep the SSH session open. Do NOT run via non-interactive pipe.

## After install, report back (sanitized)
- Panel URL (with random path) � store securely, do not share.
- Service status: systemctl status soar-panel soar-panel-ops
- Listeners: ss -tulnp | grep ':53'
- Any errors from panel_run_checks.
- Temporary test account cleanup confirmation.
