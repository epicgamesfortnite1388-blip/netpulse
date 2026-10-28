# Mission Journal â€” DPI Research and Engineering

Mission: `NETPULSE_DPI_RESEARCH_AND_ENGINEERING`
Started: 2026-10-25
State: **active, first evidence cycle complete; no Iran vantage.**
Extension (2026-10-26): the adaptive connectivity engine now consumes this
corpus. What it was allowed to conclude, and what it refuses to: failures are
classified as DNS / transport / authentication / server-outage / configuration /
local-network / not-verified, and **no single failure or repeat of one failure is
ever reported as censorship** — `censorshipHintOf` requires failures at a common
stage from at least three DIFFERENT strategies inside a short window, and even
then says "pattern, not a diagnosis". Evidence and verdicts:
`reports/adaptive/ADAPTIVE_EVIDENCE_2026-10-26.md`.

## 1. Repository state at start

- `E:\Code\Project\Vpn_app`, branch `main`, HEAD `48c1794`.
- Large pre-existing uncommitted worktree (WhiteDNS API/UI, per-user VPN
  credentials, Cloudflare worker changes, reports). **Preserved; not
  reverted.**
- The prior `reports/research/DPI_CENSORSHIP_RESEARCH_2026-10-24.md` is a
  useful summary but cites fewer sources and does not include the live
  WhiteDNS test. This lab supersedes it for engineering decisions.
- Do not commit or push unless explicitly asked. This cycle did not.

## 2. Environment facts

- Windows dev host: active `happ-xray` TUN, default route ifIndex 58;
  direct HTTPS egress `83.229.87.141`; DNS to 1.1.1.1/8.8.8.8/9.9.9.9/VPS
  returns `AA=1`, no answers in 5-9 ms. Local DNS tests are invalid.
- VPS `206.1.96.89`: Soar panel 0.6.0, Soar v0.2.2, `soar-check 0.1.0`,
  UDP/TCP 53 public, panel loopback 12053.
- A working authorized SSH key was used from `~/.ssh`; its name and material
  are intentionally not recorded. Do not print keys or `VPS-KEYS.txt` contents.

## 3. Completed this cycle

| Item | Evidence |
|---|---|
| Read mandatory Iran sources and 30+ source registry | `bibliography.md` |
| Built layered threat model | `iran-censorship-threat-model.md` |
| Separated DNS/DoH/DoT/DoQ/DNS-tunnel concepts | `dns-circumvention-analysis.md` |
| Documented ECH limits | `tls-sni-ech-analysis.md` |
| Live Soar client test on VPS | UDP/TCP/auto HTTP 200; wrong key fails |
| Windows Soar client test | built from Soar v0.2.3; timed out due TUN/DNS block |
| Fixed WhiteDNS diagnostic false positive | AA + exact-zone NS/SOA (parent SOA labeled) |
| Added real TCP DNS query | `tcpQuery` with framing/matching ID |
| Fixed pubkey omission | env fallback `WHITEDNS_PUBKEY` |
| Added configurable diagnostic path | `WHITEDNS_SOAR_CHECK`; honest skip |
| Added proxy-aware TCP DNS | `tcpQuery` HTTP CONNECT + `WHITEDNS_PROXY` fallback |
| Windows client through local proxy | HTTP 200 in 3.4 s over TCP/53 via `127.0.0.1:10808` |
| Added regression tests | 16/16 `whitednsService`; API typecheck clean |
| Documented architecture/roadmap/security | this directory |

## 4. Test results

- `npm run test -w @netpulse/api -- whitednsService.test.ts`: 16 passed.
- `npm run test -w @netpulse/api`: 97 files, 1055 tests passed.
- `npm run typecheck -w @netpulse/api`: exit 0.
- `npm run lint`: exit 0; `npm run build -w @netpulse/api`: exit 0.
- VPS `soar-check`: `tcp=off`, `tcp=only`, `tcp=auto` all
  `ok:true handshake:true http_status:200`; wrong key
  `ok:false stage:tunnel handshake:false`.
- Windows direct client: `connect_failed=context deadline exceeded`, 90 s.
- Windows client via local Happ proxy (`127.0.0.1:10808`, SOCKS5, TCP/53
  only): `http_status=200 elapsed_ms=3442`.
- No production restart, no DNS record change, no panel change.

## 5. Next actions (highest value)

1. Decide the shipping Windows WhiteDNS client path. The proxy-capable Go
   client proves the protocol, but it is a lab binary; choose a pinned
   Windows build or an external CottenDNS/WhiteDNS Desktop workflow. Do not
   ship the temp binary or fake a NetPulse-connected state.
2. Rotate the exposed panel path with owner approval; keep it loopback-only.
3. Bind WhiteDNS profiles to D1 entitlements; test expiry/revocation.
4. Fix child-zone apex NS/SOA with the vendor/zone plan.
5. Run the 20-attempt matrix from a non-TUN vantage and, if possible, a
   voluntary Iranian vantage.
6. Evaluate a bounded transport selector offline before production.

## 6. Blockers

- No Iranian consumer-network vantage; no censorship-resistance claim.
- Windows DNS/TUN prevents local Soar validation; do not disable the user's
  VPN without consent.
- Panel path rotation and DNS record changes require production approval.
- CottenDNS aggregate/WhiteDNS Desktop licenses need review.
- FOCI 2026 PDF text was not extractable with the local toolchain.

## 7. Change control

- Code changes are limited to:
  `apps/api/src/providers/dns/codec.ts`,
  `apps/api/src/providers/dns/resolver.ts`,
  `apps/api/src/services/whitednsService.ts`,
  `apps/api/test/whitednsService.test.ts`.
- Research docs are new under `docs/research/dpi/`.
- No production change was made in this cycle.

