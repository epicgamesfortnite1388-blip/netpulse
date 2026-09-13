# Networking — how measurements actually work

NetPulse's cardinal rule: **every number shown in the UI was measured on this machine.**
This document explains where each measurement comes from and where the hard platform
limits are.

## Platform controller

All OS interaction funnels through `PlatformNetworkController`
(`apps/api/src/providers/platform/`). Implementations exist for Windows and Unix-like
systems. Every shell-out uses argv-array `spawn` (no shell, no string interpolation into
command lines) and parses typed output. Inputs to platform calls come from allowlists or
validated Zod schemas — never raw user text.

| Capability | Windows | Unix |
| --- | --- | --- |
| ICMP ping | `ping` (parsed) | `ping` (parsed) |
| Traceroute | `tracert` | `traceroute` |
| TCP probe | native `net.connect` timing | native `net.connect` timing |
| Interfaces / routes / DNS config | `netsh`, `route`, `Get-Net*` via `powershell` | `ip`, `resolv.conf` |
| MTU probe | DF-bit ping sizing where permitted | same |

## Measurement semantics

- **Latency** is reported as min/avg/median/p95 from completed probes. Non-responsive
  hops are counted as non-responsive, **not** as loss: intermediate routers commonly
  deprioritize ICMP, so route analysis distinguishes per-hop non-response from
  end-to-end degradation (loss measured against the final hop).
- **Jitter** is mean absolute difference of successive probe times (`jitterMs` in
  `packages/shared`).
- **Packet loss** = unanswered probes / sent probes for the target, not per-hop.
- **Throughput** uses Cloudflare speed endpoints (`providers/speed/cloudflare.ts`) with
  bounded parallel streams and abortable transfers; samples stream live over WS.

## Cloudflare endpoint scanning & clean-edge validation

The Cloudflare scanner (`services/endpointService.ts`, `util/cfProbe.ts`) follows the
methodology of the open-source **SenPaiScanner** project (MatinSenPai/SenPaiScanner,
MIT), which was built for unstable/filtered/high-latency networks:

1. **Discovery** probes each candidate TCP → TLS → `GET /cdn-cgi/trace` with rotating
   SNI (`speed.cloudflare.com`, `www.cloudflare.com`, …). The trace body's `colo`/`loc`
   fields (with `CF-Ray` fallback) reveal *which Cloudflare datacenter the IP routes
   to*, so every result answers "which region am I hitting". Discovery reachability alone
   never claims an endpoint is useful.
2. **Post-stop validation** runs on the shortlist: each endpoint is probed multiple
   times (loss = failed/tries, jitter = latency std-dev), must survive an **idle hold**
   (a fresh TLS connection left silent ~1.2 s — filtered ISPs often RST long-lived
   tunnels while allowing the initial GET), and then must carry a **real download**
   (`https://speed.cloudflare.com/__down?bytes=N` forced through the candidate IP,
   Mbps + TTFB).
3. **Clean verdict** (`cfCleanVerdict`, ported from SenPaiScanner's `IsHealthy`): an
   endpoint is clean only when ≥2 of the tries succeeded, a colo answered, and — if a
   download was attempted — data actually transferred. This explicitly catches the
   Iranian-ISP failure mode SenPaiScanner documents: `/cdn-cgi/trace` succeeds but real
   transfers stall, so an IP that handshakes yet carries nothing is marked **filtered**,
   never clean. Endpoints that fail the idle hold are filtered too.
4. **Region metadata** — colo codes resolve through a shared dictionary
   (`packages/shared/src/models/colo.ts`) to city/country labels in both the API and UI,
   and `GET /cloudflare/edge` reports the datacenter this machine's own traffic exits
   from (a trace through `1.1.1.1`).

Scanning only ever touches configured CIDR ranges (SSRF-guarded against private and
reserved space) and validation downloads are bounded (1–50 MB per endpoint).

## Live global map

The Live Map (`services/mapService.ts`) is a generic target abstraction over everything
else in the app — DNS resolvers, documented game endpoints, measured Cloudflare edges,
VPN profiles and user servers — with a real measurement pipeline per target:

- **Probes are real and labeled**: TCP connect (N samples → median/jitter/loss), TLS
  handshake, HTTPS GET, and DNS query RTT through the resolver itself. Every
  measurement carries its actual method, protocol and port; nothing is assumed and TCP
  RTT is never labeled as ICMP ping.
- **Routes** reuse the traceroute pipeline (per-hop ASN via Team Cymru, reverse DNS,
  honest loss analysis). The map shows hop-by-hop latency contribution as *observed RTT
  increase* — explicitly not claimed as per-hop forward-path latency.
- **Geography is confidence-aware**: destination Cloudflare edges are probed
  (`/cdn-cgi/trace`) and pinned at the colo's city with `known-endpoint` / high
  confidence; every other hop is placed at its country-level centroid with
  `geoip` / low confidence and an "Approximate location" label; hops with no reliable
  country are left unplaced. GeoIP never proves where a router physically exists, and
  the UI says so.
- **Route change detection** diffs consecutive observations (hop IPs, ASN path,
  destination address, IP family, VPN state) and reports latency deltas with a
  measurement-noise caveat — a latency change with no route change is attributed to
  congestion/load, not a new path.
- **Active connections** read local TCP metadata via `netstat` (Windows, best-effort)
  with remote ASN enrichment; payloads are never captured and the feature degrades
  gracefully when unavailable.
- **Privacy**: history deletion is one action (`POST /map/observations/clear`); privacy
  and presentation modes redact IPs/hostnames client-side while keeping cities,
  latency, routes and ASN labels. Observations are stored locally in SQLite only.

## IP discovery

Public-address discovery is family-forced and fallback-chained
(`services/ipInfoService.ts`):

1. **Cloudflare trace** over a literal IP (`1.1.1.1` for IPv4,
   `2606:4700:4700::1111` for IPv6) — the returned `ip` is structurally the requested
   family, and the `colo` edge code is attached when available.
2. **ipify** (`api.ipify.org` / `api64.ipify.org`) — used when raw-IP HTTPS is blocked
   on the network (some ISPs/NATs reject TLS to literal addresses while DNS-resolved
   hosts work). The v4/v6 hosts force the family as well.

Geo/ASN enrichment then comes from ipwho.is for the discovered address. The source list
(`sources`) is reported with every lookup so the UI never hides where the number came
from. `/network/status` uses the same service lookup, so the dashboard IP always matches
the IP page.

## DNS lab

`providers/dns/resolver.ts` implements four transports natively (no shell-outs):
UDP, TCP, DoT (TLS), and DoH (HTTPS). DoT is a pure-Node RFC 7858 client: TLS 1.2+
handshake followed by 2-byte length-prefixed DNS frames over the connection; it requires
outbound TCP 853, which many networks block — the benchmark then honestly reports
timeouts. DoH needs only port 443.

For each provider the benchmark records min/avg/median/p95/p99 latency, jitter, timeout
rate, reliability, and a weighted score across a realistic hostname set. DNSSEC
validation is probed per transport where the flags allow.

### Resolver catalog

Resolvers come from a data-driven catalog (`services/dnsResolverCatalog.ts`) grouped by
provider with documented variants (standard / security / family / privacy). Every
address in the catalog was cross-checked against official documentation on
2026-09-04: entries that could not be verified against a primary source are marked
`verified: false` and carry a `source` URL rather than being silently trusted. Users can
add custom resolvers; the API rejects private, loopback, link-local, CGNAT, and cloud
metadata ranges.

### Benchmarking semantics

- Multiple samples per resolver across several domains; a resolver is never judged from
  one query.
- Reliability = successful probes / total; timeouts and SERVFAILs are counted separately.
- Scores are component-weighted; the per-component breakdown is returned so the UI can
  explain *why* a resolver ranked where it did.
- `GET /dns/recommend` applies a profile (fastest, reliable, privacy, security, family,
  gaming, balanced) to the latest batch and attaches a confidence level — small sample
  counts yield low confidence, never a strong claim.

### DNSSEC

DNSSEC support is probed with multiple independent signals (the AD flag on signed
records, validation behavior against an intentionally broken zone from a reputable
testing domain) and classified `supported` / `validating` / `failed` / `unknown`.
Validation is never inferred from a single unreliable signal.

### DNS leak detection

Leak detection resolves tester-controlled names through the system resolver and reports
which resolvers actually answered, with resolver IP, organization, ASN, region, and the
VPN-expected resolver when connected. Classification is conservative: `No obvious leak`,
`Possible DNS mismatch`, `Potential DNS leak`, or `Unable to determine` — never false
certainty.

## Gaming network intelligence

`services/gamingService.ts` measures latency to **documented publisher service front
doors** (login, API, status, matchmaking hosts from official docs) using TCP-connect and
TLS-handshake RTT — deliberate, low-volume probes of documented hostnames, never scans.

- **Reachability** distinguishes ICMP-blocked from genuinely unreachable: a failed ICMP
  echo alone never marks a service offline.
- **Regions** are ranked by configurable weights (latency 30%, loss 25%, jitter 20%,
  route stability 15%, reachability 10%) with best/second/unstable/not-recommended
  labels and an explanation of each ranking.
- **Gaming score** (0–100) combines latency, jitter, loss, stability, bufferbloat, and
  route quality with per-component grades — never an unexplained magic number.
- **Session monitor** runs low-impact periodic probes (configurable interval, ≥5 s) with
  spike/jitter/loss/disconnect/route-change event detection. It deliberately does not
  flood game servers.
- **Direct vs VPN** captures the same probe set before and after a VPN connect; the UI
  only claims the VPN improved routing when measurements demonstrate it.
- **Honest labeling**: game scores are always labeled "service-endpoint latency" because
  in-game RTT to a dynamically allocated match server can differ from the front-door
  measurement.

Endpoints in `services/gameCatalog.ts` are documented and carry `verified` + `source`;
unverified-but-official hostnames are flagged rather than silently treated as permanent.

## VPN-aware measurements

DNS benchmarks, gaming tests, and gaming session samples detect whether a tunnel is
connected (`services/…` → `vpn/vpnState.ts` asks every provider) and label each result
`vpnActive` (+ tunnel server name). The probes use ordinary sockets, so when the tunnel
owns the route the numbers genuinely are the tunnel path — the label just makes that
explicit and is persisted with the row, so history stays honest about what was measured.

Recommendations built from those numbers are switch-guarded:

- **DNS**: when the user has a preferred resolver (`settings.network.dnsPreference`), a
  switch to the top-ranked resolver is only *recommended* when the latency improvement
  exceeds the measured jitter of both resolvers. Within-jitter improvements mark the
  current resolver `keep-current` and explain why; the note states whether the data was
  measured direct or through the tunnel.
- **Gaming direct-vs-VPN**: each capture probes every region front door twice, so a
  jitter figure is stored with the capture; a winner is only declared when the
  direct↔VPN delta exceeds that jitter (never a sub-jitter flip-flop).

## Scheduled benchmarks

`services/scheduleService.ts` runs DNS Lab benchmarks and Gaming region tests on a
user-configured schedule (`settings.scheduling`). Both kinds default to off; when
enabled the interval is 15 minutes to 7 days. Runs are one-shot timers re-armed after
each completion: a run still in flight when its timer fires is skipped (never stacked),
a failure is recorded with its message and the next run still happens, and settings
changes re-arm immediately. Scheduled runs persist history exactly like manual runs, so
trend charts and recommendations stay current without any interaction. The UI shows
live status (running / last result / next run) on the DNS Lab, Gaming, and Settings →
Automation pages via the `schedule` WebSocket topic.

## MTU & CGNAT

- **MTU discovery** sizes probes with DF (don't-fragment) until the path drops them.
  Where the OS refuses to set DF (some Windows/privilege combinations), the API returns
  `mtu: null` with an explanation and the UI shows "Unavailable in this environment".
- **CGNAT detection** compares the RFC1918/range class of the WAN-facing address reported
  by the modem/traceroute with the public IPv4 seen by external services, plus TTL
  observations. It reports *likelihood and evidence*, never a bare assertion.

## IPv4 vs IPv6

Both families are tested independently (probes forced per family via target selection),
and route comparison scores each path from latency, stability, and hop count. A
recommendation ("IPv6 currently performs better") is only produced when the measured
delta is significant.

## Bufferbloat

Idle latency baseline is measured first; then sustained download and upload loads run
while latency is sampled continuously. The grade is based on *latency increase under
load* (not absolute latency), with the raw increases reported alongside.

## Honesty policy in code

- `DEMO_DATA=true` seeds clearly-labeled demo content; the UI shows a persistent
  **DEMO** badge. Demo rows are distinguishable from real measurements.
- Any capability that cannot run returns a structured "unavailable" result rather than
  zeros or fabricated values.
- Reputation/privacy indicators for IPs come only from the configured reputation
  providers (`providers/reputation/`); absent evidence, no "clean" label is emitted.
