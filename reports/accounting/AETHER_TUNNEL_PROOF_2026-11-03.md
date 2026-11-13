# Aether Tunnel Proof — 2026-11-03

**Workstream:** W1 (Aether Engine — serverless tunnel)
**Verdict:** **PASS at the lab level** — real binary installed, SOCKS5 tunnel relayed, exit IP differs from baseline.
**Scope limit:** measured from a **non-Iranian** network (Windows host behind an existing VPN). This is not evidence of behaviour on an Iranian ISP. Iran-ready remains **0/5**.

---

## 1. Install (PASS)

Ran the app's own pipeline, not a hand-install:

```
npx tsx -e "import {installAether} from './apps/api/src/services/engineManager.js'; ..."
```

```json
{
  "status": "installed",
  "version": "v2.4.0",
  "path": "E:\\Code\\Project\\Vpn_app\\aether\\aether.exe",
  "checksumVerified": true,
  "versionOutput": "2.4.0",
  "error": null,
  "tookMs": 6480
}
```

- Release channel: `CluvexStudio/Aether` v2.4.0, asset `aether-windows-x86_64.zip` (25,573,679 bytes).
- SHA256 sidecar matched before extraction; `aether.exe -v` self-check printed `Aether v2.4.0`.
- Earlier blocker (GitHub unauthenticated API at 60/hr) cleared when the quota window reset (`/rate_limit` → 60/60). The API path is therefore workable again; no bypass was needed.
- The direct `releases/latest/download/...` URL also answers `200` with the same byte count, so an API-free install path exists if the quota is exhausted again.

---

## 2. Tunnel bring-up (PASS after three failed configurations)

All runs used the app's argv shape: `--bind 127.0.0.1:1819 --config aether/aether.toml --log-level info` plus profile flags.

| Attempt | Flags | Outcome |
|---|---|---|
| 1 | `--masque --scan balanced` (default noize `firewall`) | Found candidate `162.159.199.1:443` (rtt 1.75 s), then `MASQUE tunnel ended: tunnel startup timed out after 30s`. SOCKS5 port bound early but **relay check false**. |
| 2 | `--masque --h2 --fragment --scan balanced` | Repeated `scan deadline reached with no gateway` (3 full 120 s scans). No tunnel. |
| 3 | `--masque --h2 --fragment --peer 162.159.199.1:443` | TLS + h2 established, then `connect-ip status: 400`; tunnel failed before validation. |
| 4 | `--masque --noize gfw --startup-secs 90 --validate-secs 30` | **Success.** Cached gateway verified, QUIC h3 handshake, `connect-ip status: 200`, data-plane validated, socks5 exposed. |

The winning log tail:

```
[*] verifying cached gateway 162.159.199.1:443 before reuse
[+] cached gateway 162.159.199.1:443 still works; skipping scan
[+] [masque] MASQUE transport: HTTP/3 (QUIC) to 162.159.199.1:443 (inner mtu 1280, datagram 1350)
quic handshake established; alpn=h3
[*] validating masque data-plane before exposing socks5
connect-ip status: 200
[+] masque tunnel validated (end-to-end data confirmed); exposing socks5
[+] socks5 server listening on 127.0.0.1:1819
[+] masque exit: 104.28.197.9, DE via FRA, 276ms to cloudflare, warp on
```

**Takeaway for the roadmap:** on this network the default `firewall` noize profile is not sufficient; `--noize gfw` with a longer startup/validation budget is what carried traffic. `--h2` was *worse* here (400 on connect-ip), contrary to the usual "QUIC is blocked, use TCP" heuristic.

---

## 3. Exit-IP proof (PASS)

Repo helpers, unmodified:

| Check | Function | Result |
|---|---|---|
| SOCKS5 greeting + CONNECT + relay | `socks5RelayCheck(1819)` | `true` |
| Egress address through relay | `fetchExitIpThroughSocks(1819)` → `api.ipify.org` | `104.28.197.9` |
| Baseline, direct (same moment) | Node `fetch` → `api.ipify.org` | `83.229.87.141` |
| Differing exit? | — | **Yes** |

Repeatability (5/5 sequential probes through the relay returned the same exit):

```
ips:      104.28.197.9 ×5
timesMs:  283, 265, 281, 268, 274
stable:   true
```

Address attribution (ipinfo.io, for context only):

| Address | Org | City / Country |
|---|---|---|
| 83.229.87.141 (baseline) | AS204548 Kamatera Inc | Frankfurt am Main, DE |
| 104.28.197.9 (Aether) | AS13335 Cloudflare, Inc | Frankfurt am Main, DE |

Both egresses are in Germany, so this proves a **different AS and a different network path**, not a different country. Traceroute-level path divergence was not measured.

---

## 4. What this does and does not prove

Proved:
- The Aether install pipeline works end to end on this machine (checksum + self-check + extract).
- Aether v2.4.0 opens a real tunnel from a filtered-network *simulation* context and relays TCP through SOCKS5 — traffic leaves from an address that is not the host's.
- The repo's ground-truth helpers (`socks5RelayCheck`, `fetchExitIpThroughSocks`) correctly distinguish "port open" from "tunnel relaying": attempts 1–3 had the port listening while relay stayed false.

Not proved:
- Anything about Iranian ISPs, DPI behaviour, throttling or blocking windows. No Iranian vantage was used.
- Free-config (W2/F-05) tunnel behaviour — this test used Aether's own WARP path, not the 34,150 harvested configs.
- Long-run stability, reconnection under blocking, or bandwidth/throughput.
- Country change: exit and baseline are both DE.

Iran-ready status: **unchanged at 0/5.** Requirement 3 (real client + independent egress observation) is now partially instrumented on a lab network, but requirement 1 (voluntary Iranian vantage with timestamp/ASN/ISP/consent) is still unmet, so no claim can be promoted.

---

## 5. Reproduce

```bash
# install (needs GitHub API quota, or use releases/latest/download directly)
npx tsx -e "import('./apps/api/src/services/engineManager.js').then(async m => console.log(await m.installAether()))"

# run the tunnel
./aether/aether.exe --bind 127.0.0.1:1819 --config "$(pwd)/aether/aether.toml" \
  --log-level info --masque --noize gfw --startup-secs 90 --validate-secs 30

# prove it
npx tsx -e "import('./apps/api/src/vpn/aetherProvider.js').then(async m => {
  console.log('relay', await m.socks5RelayCheck(1819));
  console.log('exit', await m.fetchExitIpThroughSocks(1819));
})"
```

`curl` remains unusable on this machine (debug build hardwired to a dead `127.0.0.1:10809` proxy) — every probe above used Node `fetch`.
