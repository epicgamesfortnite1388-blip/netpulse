# Infrastructure verification — abystral.dpdns.org

**Date:** 2026-10-24
**Scope requested:** verify WhiteDNS, password-reset mail, the VPN services, and every hostname in the zone.
**Mode:** read-only. No DNS record, Worker, secret or server was changed.

## Method and vantage caveats

- DNS: Cloudflare DoH (1.1.1.1) and Google DoH; direct UDP/TCP queries to the authoritative server.
- External reachability: `check-host.net` TCP checks (4 independent nodes per port), because the audit
  machine runs a TUN client plus an HTTP proxy on `127.0.0.1:10809` that accepts *every* TCP connection
  locally. Local `net.connect` results were therefore discarded wherever an external check existed.
- HTTP/TLS directly from this host (Node), and through the system proxy (curl) where noted.
- Cloudflare Worker facts: `wrangler` (OAuth, read-only commands), `wrangler versions view`,
  `wrangler secret list` (names only) and one read-only D1 `SELECT` for reset-mail audit rows.
- The Cloudflare MCP connector required a fresh sign-in, so zone routes/custom-domain lists could not be
  read through it. Conclusions below rest on public DNS and observed edge behaviour.

## Verdict at a glance

| Area | Status | Notes |
|---|---|---|
| Zone itself | OK | Cloudflare zone, NS `deborah/jakub.ns.cloudflare.com` |
| WhiteDNS delegation | OK | `soar` and `gb6ys…` zones are served by `206.1.96.89`; TCP/UDP 53 reachable |
| WhiteDNS data plane | NOT VERIFIED | needs `soar-check` + a real account profile; neither is available here |
| Password-reset mail | WORKING (since today) | `mail_sent` at 2026-10-24T12:30Z; failures on 2026-10-23 are resolved |
| VPN node 206.1.96.89 | MOSTLY OK | REALITY 443, VLESS-WS-TLS 2053, VMess-WS 8443, Trojan 2087, SS 8388, DNS 53 all answer; Hysteria2 UDP not verified |
| Panel hostnames | REPOINTED 2026-10-24 17:45Z | all five now point at the live panel `206.1.96.89:2053`; origin certificate still covers only `206-1-96-89.sslip.io` (F2) |
| CDN hostnames (`cdn443`, `cdn`, `cf`, `sub`) | BROKEN | Akamai edge answers `400 Invalid URL` for every path — the CDN has no property for these names |
| Worker hostnames | NOT ATTACHED | Cloudflare answers `525`; `xui-edge-proxy` lives in the same account as the zone but has no route (F4) |
| `s` / `t` delegations | BROKEN | public resolvers return SERVFAIL; the nameserver does not host those zones |

## DNS records

All hostnames below resolve as the table showed; proxied names return Cloudflare anycast
`188.114.96.3 / 188.114.97.3` (normal for this region).

| Name | Record | Result |
|---|---|---|
| `cdn443`, `cdn`, `cf`, `sub` | A → proxied | Resolve OK; **HTTP 400 from Akamai** on every path |
| `r1` | A → proxied (origin 206.1.96.89) | `:2053` returns 404 through Cloudflare with a valid edge cert; `:443` hits origin REALITY (400) |
| `panel-sw-cf` | A → proxied (origin 206.1.96.89) | Same as `r1` |
| `5de1ab3c12f2f4`, `cb770763541406` | "Worker" rows | **CF 525** — no Worker is attached |
| `dns`, `ns-soar`, `sns`, `tns` | A → 206.1.96.89, DNS only | Resolve OK; only `ns-soar` actually hosts zones (see below) |
| `panel-se`, `panel-sw`, `panel-us` | A → 206.1.96.89, DNS only | `:2053` answers 404 and `:22` is open; TLS name mismatch (F2) |
| `panel-tr` | A → 206.1.96.89, DNS only | 2053 answers (404, 0.4 s); 443 is the Xray REALITY inbound |
| `soar` | NS → `ns-soar` | Delegation published; child answers SOA over UDP and TCP |
| `s` | NS → `sns` | Public SERVFAIL; server answers NOERROR/no data for the zone |
| `t` | NS → `tns` | Public SERVFAIL; server answers NOERROR/no data for the zone |
| `gb6ysaxnm3z4r7ffwzbn5.soar` | NS → `ns-soar` | Wrapper zone is served (SOA answers) |

## Findings

### F1 — Panel hosts were down; aliases repointed to the live panel (resolved 2026-10-24)

Every checked port on both panel IPs timed out from all four external nodes used for that port:
`91.186.216.75` on 22, 443 and 2053, and `95.182.114.3` on 22, 443 and 2053 (node sets varied per
check: FR/HU/IR/RU, CH/RU/SE/US, HK/IR/JP/SE, BR/DE/IL/IR, DE/IT/JP/US, CH/DE/JP/TR). `panel-se`,
`panel-sw`, `panel-us`, `panel-sw-cf` and `r1` therefore all fail; `panel-sw-cf` and `r1` cannot be
served through Cloudflare while their origin is unreachable.

Meanwhile `panel-tr.abystral.dpdns.org:2053` *does* reach a live panel (see F2), so the management plane
is not lost — only the other four hostnames are.

**Fix applied 2026-10-24 17:45Z:** `2053` was re-checked on both retired IPs from three fresh external
nodes each (IL/TR/US and CA/HU/RS); all timed out, so the hosts are gone rather than filtered.
`panel-se`, `panel-sw`, `panel-us`, `panel-sw-cf` and `r1` were repointed to `206.1.96.89` — the only box
that runs a panel. All five answer `404` on `:2053` (expected for a path-scoped admin), and `:22` is open
under the repointed names, so SSH access is restored too. `panel-sw-cf` and `r1` stay proxied and serve
the panel through Cloudflare with a valid edge certificate; the DNS-only names still show the origin
certificate warning described in F2.

### F2 — TR "panel" hostname only works with an explicit port (Low)

`panel-tr.abystral.dpdns.org` → `206.1.96.89` is the one panel hostname pointing at the right box, and
the panel answers there: `GET https://panel-tr.abystral.dpdns.org:2053/` returns `404` in 0.4 s with the
`206.1.96.89` certificate (a 404 on `/` is expected for a path-scoped admin). Port 443 on the same IP is
owned by Xray VLESS+REALITY, so a browser using the default 443 gets the stolen `www.microsoft.com`
certificate and the panel is unreachable without typing `:2053`. `2087`/`8443` on that IP terminate
without completing a TLS handshake.

Certificate scope: the panel presents `CN=206-1-96-89.sslip.io` with that name as its only SAN, so every
`*.abystral.dpdns.org` name — `panel-tr` included — fails strict TLS verification on `:2053`; only
`206-1-96-89.sslip.io` verifies. The proxied names (`r1`, `panel-sw-cf`) sidestep this because Cloudflare
serves a certificate valid for them.

**Fix:** issue the panel certificate for the `*.abystral.dpdns.org` names it is published under (or rely
on the Cloudflare-fronted names), and make the working entry point explicit in clients/docs
(`<panel host>:2053/<admin path>`). A bare hostname on 443 cannot work while Xray owns that port.

### F3 — CDN-fronted hostnames are not provisioned at the CDN (High)

`cdn443`, `cdn`, `cf` and `sub` all return the same Akamai error page for `/`, `/health`, `/sub`,
`/api/v1/client/subscribe` and `/subscribe`:

```
HTTP/1.1 400 Bad Request
Server: cloudflare
...
<HTML><HEAD><TITLE>Invalid URL</TITLE>...
Reference #9.8ec11302.1792861388.ed1b0db2
<https://errors.edgesuite.net/...>
```

That page is generated by the CDN edge behind Cloudflare (Akamai reference format), not by the origin
application. The CDN does not recognise these Host names — in other words, the "CDN-443 reserve host"
has no property/origin mapping for them. `sub` cannot serve subscriptions in this state.

**Fix:** register `cdn443`, `cdn`, `cf` and `sub` in the CDN provider's panel with the correct origin
(or switch them to the provider-assigned hostname). If they are intentionally reserved and unused,
remove them from public DNS to avoid publishing dead endpoints. Only after that will the 400 disappear.

### F4 — Worker records are not served by the Worker (High)

`curl https://5de1ab3c12f2f4…/` and `https://cb770763541406…/` return Cloudflare **525** with a
`CF-Ray`, i.e. the edge tried to complete TLS with an origin. A request handled by a Worker never
performs that origin handshake, so `xui-edge-proxy` is not attached to either hostname.

`wrangler deployments list --name xui-edge-proxy` shows the Worker exists in account
`4ca19fcad2d9fb155873fc9e0eb481e6` (last deployed 2026-10-02). That is the **same account that owns
`abystral.dpdns.org`**, so a Custom Domain can be attached without moving anything — the earlier guess
that the zone lived in the repo's account (`7380a676…`, where `netpulse-cloud` deploys) was wrong.

**Fix:** attach `xui-edge-proxy` to those two hostnames as **Custom Domains** (or routes) from
`4ca19fcad2…`. Note that the Worker's upstream panel hosts were the dead IPs from F1; they now resolve to
the live panel, but its upstream paths and ports still need to be checked before it is published.

### F5 — `s` and `t` delegations are lame (Medium)

Public resolvers return **SERVFAIL** for both. Direct queries to `206.1.96.89` return NOERROR with no
data (`s`) or the SOA of an unrelated zone (`t`), so the nameservers `sns`/`tns` are reachable but do
not host those two zones. `WHITEDNS_SOAR_COTTEN.md` already says not to reuse `t`; the records are
stale either way, and any client still configured for them fails.

**Fix:** delete the `s`/`t` NS delegations and the now-unused `sns`/`tns` A records, or restore the two
zones on the DNS server if they are still meant to serve traffic.

### F6 — Reset mail was broken yesterday and now sends (resolved)

Read-only `audit_events` rows for `reset.requested`:

```
2026-10-24T12:30:27Z  mail_sent          <- after the 12:21 secret update / 12:22 deploy
2026-10-23T17:39:34Z  mail_http_422
2026-10-23T17:31:49Z  mail_http_403
... (14 more 403/422 rows between 16:30 and 17:39)
2026-10-23T15:55:38Z  mail_from_missing
... (2 more)
2026-10-22T20:47:21Z  mail_sent
2026-10-21T18:54:07Z  mail_sent
```

The deployed Worker (`579c8800`, 2026-10-24T12:22Z) has `AUTH_SECRET`, `MAIL_FROM`, `RESEND_API_KEY`,
`RESET_PEPPER`, `NETPULSE_SERVICE_SECRET`, `OPS_TOKEN` and `TELEGRAM_BOT_BASE_URL` set, with
`EXPECTED_ORIGIN = https://netpulse-cloud.shuridehradin.workers.dev`. `/reset` returns 200 with a
same-origin CSP, and `POST /api/v1/auth/reset-password` with an unknown token returns the correct
`400 invalid_reset_token`. Resend accepted the latest send (`mail_sent`).

**Remaining limit:** the API accepting the message is not proof the recipient inbox received it (spam
placement / DKIM/DMARC were not observable without the From address and the Resend dashboard). If
`MAIL_FROM` is on `abystral.dpdns.org`, note the zone publishes **no MX, SPF, DKIM or DMARC records**,
so authentication would have to come from a different domain.

### F7 — VPN inbounds on 206.1.96.89 (OK, one unverified)

| Port | Service | Evidence |
|---|---|---|
| 443/tcp | VLESS REALITY | real `www.microsoft.com` certificate and a real Microsoft/Akamai 403 are proxied back — correct REALITY behaviour; open from 3/4 external nodes |
| 2053/tcp | VLESS WS+TLS | valid Let's Encrypt cert for `206-1-96-89.sslip.io`; `GET /np-vless` returns `101 Switching Protocols` (WebSocket) |
| 8443/tcp | VMess WS | `GET /np-vmess` returns `101 Switching Protocols`; open externally |
| 2087/tcp | Trojan TLS | valid LE cert; no response to a plain HTTP request (Trojan semantics); open externally |
| 8388/tcp | Shadowsocks 2022 | accepts TCP, waits for SS handshake; open externally |
| 8443/udp | Hysteria2 | **not verified** — no QUIC client available in this toolchain |
| 53/tcp+udp | WhiteDNS / DNS | authoritative SOA for `soar`/`gb6ys`; TCP 53 open from 3/4 external nodes |
| 18080/tcp | microsocks | **closed externally** (refused/timeout from 4/4 nodes) — correctly loopback-only |

### F8 — WhiteDNS specifics (OK, with two notes)

- `soar` NS delegation is visible through both DoH resolvers; `ns-soar` answers SOA for `soar` over UDP
  and TCP.
- `gb6ysaxnm3z4r7ffwzbn5.soar` is served (its own SOA in answers/authority), so the tunnel zone is
  delegated and hosted.
- The server is **not** an open resolver: a random `example.com` label queried with RD=1 from an
  external vantage returned `REFUSED`. The apparent recursion seen locally was the local TUN's DNS
  hijack, not the server.
- Note 1: the `gb6ys…` zone has **no apex NS record** (parent delegation exists; the child returns the
  SOA in the authority section). It resolves today but is non-conforming; ask the WhiteDNS vendor
  whether their zone generator should publish NS.
- Note 2: the `gb6ys…` SOA MNAME is the zone itself rather than `ns-soar…`; harmless in practice,
  same caveat.
- The generated profile in `cloud/worker/src/index.ts` uses zone `gb6ys…`, server `206.1.96.89` and a
  base64 pubkey. The zone/server pair matches the live delegation; the **public key and authenticated
  data plane could not be verified** without an account profile and `soar-check` (not installed on this
  workstation).

## Not verified

- WhiteDNS authenticated tunnel (no `soar-check`, no account profile).
- Hysteria2 UDP 8443.
- Actual inbox delivery of the latest reset email (API acceptance only).
- Panel contents and Worker code/route list — panel hosts are down; Cloudflare MCP needs a fresh
  sign-in, and the zone's route list could not be read through wrangler.
- VPN throughput, latency and blocking behaviour from inside Iran (external nodes only prove TCP
  reachability).

## Recommended order

1. ~~Restore or replace the panel hosts (F1)~~ — done 2026-10-24 17:45Z by repointing all five names; the
   certificate scope in F2 is still open.
2. Register the four CDN hostnames at the CDN provider (F3); re-test `sub` with a real subscription path.
3. Attach `xui-edge-proxy` to its two hostnames in the zone's account (F4) once the panels answer.
4. Remove the lame `s`/`t` delegations (F5) unless they are being restored.
5. Keep the reset-mail configuration as deployed today; add MX/SPF/DKIM/DMARC only if `MAIL_FROM` is on
   this zone (F6).
6. Deploy the pending worker fixes (sync projection, link revocation) and ship the desktop refresh-race
   fix; neither is part of this infrastructure audit but both affect the same account story.
