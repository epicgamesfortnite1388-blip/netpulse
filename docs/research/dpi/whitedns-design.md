# WhiteDNS Design and Integration

## 1. What is actually running

| Item | Observed state |
|---|---|
| VPS | `206.1.96.89`, Ubuntu 24.04, authorized root SSH |
| Panel bundle | `soar-panel-0.6.0-linux-amd64` under `/root/whitedns-check/` |
| Services | `soar-panel.service`, `soar-panel-ops.service` active |
| Listeners | `206.1.96.89:53` UDP and TCP; `127.0.0.1:12053` TCP panel |
| Diagnostic | `/usr/local/bin/soar-check` → `soar-check 0.1.0; Soar v0.2.2` |
| Tunnel zone | `gb6ysaxnm3z4r7ffwzbn5.soar.abystral.dpdns.org` |
| Delegation | `soar` NS → `ns-soar.abystral.dpdns.org`; child zone served, but NS/SOA authority is the parent (`soar.`) SOA |
| Old service | `netpulse-dnstt` disabled because Soar owns port 53 |
| Panel HTTPS | pending; 443 is owned by Xray |
| Panel path | randomized; exposed during troubleshooting; **must be rotated** |

The panel is not the tunnel. It manages accounts/subscriptions and starts the
Soar/Cotten/MasterDNS engines. The actual tunnel is a DNS protocol between a
client and the authoritative server.

## 2. Engines and licensing

| Component | Role | License / reuse rule |
|---|---|---|
| Lantern Soar | DNS tunnel engine | Apache-2.0 (S07) |
| WhiteDNS Soar-Server panel | installer/management | Apache-2.0 (S08) |
| CottenDNS | DNS tunnel, Normal + CottenMax | MIT lineage; aggregate license needs review (S12) |
| MasterDNS | upstream tunnel lineage | MIT (S27) |
| StormDNS | fork/lineage | license unresolved by API (S28) |
| WhiteDNS Android | Android client | source-available **proprietary**; no copying/redistribution (S10) |
| WhiteVPN | Mihomo Android client | GPL-3.0; **not** the DNS tunnel (S11) |

Do not copy WhiteDNS Android code or package its APK. Do not describe a
Mihomo/WhiteVPN connection as "WhiteDNS connected".

## 3. Compatibility table

| Question | Answer | Evidence |
|---|---|---|
| What runs as `netpulse-dnstt`? | Disabled; Soar panel now owns 53 | live VPS units |
| Is it the official WhiteDNS Soar/Cotten stack? | Yes, Soar panel 0.6.0 with Soar v0.2.2 | bundle + `soar-check -version` |
| Which DNS protocol? | Soar DNS tunnel over recursive resolvers; UDP/TCP 53 | Soar design + live test |
| Which client can connect? | `soar-check` on Linux; a pinned Soar v0.2.3 Go client on Windows via the local proxy; CottenDNS has Windows/Linux/macOS clients; WhiteDNS Android is Android-only | live test + READMEs |
| Profile format? | zone + server + base64 public key; panel also issues subscriptions | Worker profile + panel docs |
| DNS records required? | A for nameserver, NS delegation for tunnel zone; do not proxy | Soar/Cotten setup docs |
| What traffic is carried? | TCP streams (HTTPS tested) through DNS; not UDP/QUIC/general VPN | live HTTPS 200 |
| Windows NetPulse integration? | **Partial**: TCP DNS can go through `WHITEDNS_PROXY`; the tunnel stage still needs a proxy-capable Windows client or a VPS diagnostic, because `soar-check` has no proxy mode | code + local proxy test |
| Issue/expire/revoke clients? | Panel supports accounts/quotas/expiry; NetPulse D1 binding not implemented for WhiteDNS | panel README; no E2E |
| Licensing satisfied? | Soar/panel Apache-2.0; Android proprietary; Cotten aggregate needs review | licenses above |

## 4. Live evidence

From the VPS, using the real Soar diagnostic and the production zone/key:

```text
tcp=off   {"ok":true,"stage":"complete","handshake":true,"http_status":200}
tcp=only  {"ok":true,"stage":"complete","handshake":true,"http_status":200}
tcp=auto  {"ok":true,"stage":"complete","handshake":true,"http_status":200}
wrong key {"ok":false,"stage":"tunnel","handshake":false,"error":"test timed out"}
```

Label: `PASS_WHITEDNS_REAL_CLIENT`, `PASS_REAL_HTTPS_THROUGH_TUNNEL`,
`PASS_SECURITY_TEST` (wrong-key rejection), **VPS vantage only**.

From Windows, a direct client built from `getlantern/soar` v0.2.3 timed out.
The host has an active `happ-xray` TUN and all tested resolvers return `AA=1`
with no answers. Label: `BLOCKED_ENVIRONMENT`, not a server failure.

The same Windows client, rebuilt with a SOCKS5 dialer for `DialTCP` and
`TCP: "only"`, succeeded through the user's local Happ proxy
(`127.0.0.1:10808`): `http_status=200 elapsed_ms=3442`. Label:
`PASS_REAL_CLIENT` and `PASS_REAL_HTTPS_THROUGH_TUNNEL` **via the local
proxy**, not a direct Iranian path. See
[`results/2026-10-25-soar-live.md`](results/2026-10-25-soar-live.md).

## 5. Integration design

### 5.1 Do not run the server-side diagnostic on the Windows API host

The current service looks for `soar-check` on the API host. That is correct
for a Linux deployment but wrong for the Windows sidecar. Options, in order:

1. **VPS-side diagnostic endpoint** (authenticated, restricted): run
   `soar-check` on the DNS server and return a signed, sanitized result. This
   proves the actual server path but adds a production endpoint.
2. **Bundle a Windows `soar-check`** with the app, with a pinned build and
   license review. The service now supports `WHITEDNS_SOAR_CHECK`; no binary
   is shipped yet.
3. **Use the tested external client** (CottenDNS Windows or WhiteDNS Desktop)
   for the tunnel and keep NetPulse to DNS/profile management. Do not claim
   the tunnel is connected from NetPulse unless NetPulse owns the client.
4. **Use a proxy-capable client** for validation on a TUN host. The lab Go
   client proved this over TCP/53 through `127.0.0.1:10808`; it is not a
   shipping artifact. `WHITEDNS_PROXY` lets the service validate TCP DNS
   through the same proxy, but the tunnel stage remains skipped.

Do not fake a tunnel result when the binary is missing. The current code
skips the stage and returns `ok=false`.

### 5.2 Profile and entitlement

- The panel should issue one profile/subscription per account.
- NetPulse D1 should store the entitlement and the profile reference, not a
  shared test zone/key for every user.
- Revocation/expiry must be enforced at the panel/server, not only in the UI.
- Keep `soar://` profiles distinct from Xray/WireGuard configs.
- Never log a full profile, subscription URL, panel path, or admin password.

### 5.3 UI truthfulness

- "DNS authoritative" and "tunnel authenticated" are separate states.
- If the tunnel client is unavailable, say so; do not show "connected".
- If the panel is HTTP-only on loopback, say "management via SSH tunnel"; do
  not expose the panel port.
- Rotate the exposed random path before calling the panel production-ready.

## 6. Open work

1. Rotate the panel access path (requires owner approval; production change).
2. Fix the child zone's missing apex NS / SOA MNAME (vendor/zone plan).
3. Choose Windows tunnel client path (VPS diagnostic vs bundled client vs
   external CottenDNS/WhiteDNS Desktop).
4. Bind WhiteDNS to D1 entitlements and test expiry/revocation.
5. Test from an Iranian vantage before any reachability claim.
6. Review CottenDNS aggregate license and WhiteDNS Desktop terms.
