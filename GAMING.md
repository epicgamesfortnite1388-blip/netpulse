# Gaming Network Intelligence

The Gaming section measures **service-endpoint latency**: TCP-connect and TLS-handshake
RTT to documented publisher service front doors (login, API, status, matchmaking hosts).
These are deliberate, low-volume probes of documented hostnames — never scans, never
arbitrary port sweeps. In-game UDP routing to a dynamically allocated match server can
differ, so every score is labeled "service-endpoint latency" and reachability is reported
per protocol rather than as a single "ping".

## Catalog rules

- All bundled endpoints live in `apps/api/src/services/gameCatalog.ts` as data-driven
  definitions (`GameDefinition` / `GameEndpoint` in `packages/shared/src/models/gaming.ts`).
- Endpoints come from **official publisher documentation, official status/service
  infrastructure, or documented hostnames** — never scraped IP lists from unknown sites.
- Each endpoint records `verified` (bool), `verifiedAt` (ms timestamp), `source` (URL)
  and an optional `note`. Entries that could not be re-verified against a primary
  source on 2026-09-04 remain in the catalog but are flagged `verified: false` (some
  carry a `note` recording that they were DNS-verified live on that date) so the UI
  never pretends stale endpoints are permanent.
- **Region coverage**: games with documented regional fronts carry per-region endpoints
  so region ranking compares several servers per region — e.g. Blizzard titles and the
  Battle.net platform add the per-region login service (`us/eu/kr.actual.battle.net`)
  and the China gateway (`gateway.battlenet.com.cn`, `oauth.battlenet.com.cn`), Riot
  titles add per-region client platform-data hosts (`pd.<region>.a.pvp.net`), and Final
  Fantasy XIV now covers the official NA/EU/JP Lodestone fronts (live-verified).
  Games whose operators publish no regional hostnames (Valve, Epic, Mojang) stay
  global rather than inventing servers.
- The catalog is extensible: add entries without touching UI logic.

## Reachability semantics

| Classification | Meaning |
| --- | --- |
| Reachable | DNS resolution + at least one probe succeeded |
| ICMP blocked | DNS + TCP/TLS fine, ICMP unanswered |
| Partially reachable | Some endpoints respond, others not |
| Timeout / Connection refused / DNS failure / Unreachable | As observed |
| Unknown | No endpoint produced usable evidence |

A failed ICMP echo alone **never** marks a service offline.

## Region ranking

Regions are scored with configurable weights (defaults): latency 30%, packet loss 25%,
jitter 20%, route stability 15%, reachability 10%. Output is `BEST` / `SECOND BEST` /
`UNSTABLE` / `NOT RECOMMENDED` with a plain-language explanation of each ranking.

## Gaming score (0–100)

Combines latency, jitter, packet loss, stability, bufferbloat, and route quality. Each
component carries its own grade (Excellent / Good / Fair / Poor) and the score is
reported with its component breakdown — never an unexplained magic number. Scores are
only computed from measurements actually obtained in this run or the current session.

## Session monitor

`POST /gaming/session` starts low-impact periodic probes (interval ≥ 5 s, configurable).
The monitor tracks latency, jitter, loss, public IP, VPN state, gateway, DNS, and route
changes and emits typed events (spike, jitter burst, loss burst, disconnect, recovery,
VPN reconnect, IP change). It deliberately does not flood game servers.

## Direct vs VPN

`POST /gaming/compare` captures the same probe set labeled `direct` or `vpn` (with the
VPN server name). The UI only claims a VPN improved routing when measurements
demonstrate it — differences within jitter/noise are reported as inconclusive.