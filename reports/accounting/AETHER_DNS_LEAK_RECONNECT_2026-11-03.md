# Aether — DNS inside the tunnel, leak checks, recovery

**Date:** 2026-11-03 · **Vantage:** non-Iranian lab network (direct v4 egress `83.229.87.141`, AS204548)
**Workstreams:** Iran-ready requirement 2 (staged behaviour, DNS) and requirement 4 (negative controls, fallback/recovery)
**Artifacts:** `DNS_TUNNEL_PROOF_2026-11-03.json`, `LEAK_TEST_2026-11-03.json`, `RECONNECT_TEST_2026-11-03.json`

Three claims were tested here, and one of them closes a defect this project had documented rather than fixed.

---

## 1. DNS now resolves inside the tunnel — the leak is closed

**Why it leaked.** Aether's SOCKS5 refuses hostname-form CONNECT (ATYP 0x03). Every name therefore had to be resolved before asking for a socket, and the only resolver available at that point was the machine's own — outside the tunnel. `TUNNEL_STAGES_2026-11-03.json` recorded this as a 1 ms DNS stage: cheap because it never left the host.

**What changed.** `resolveThroughTunnel()` in `apps/api/src/vpn/aetherProvider.ts` speaks DNS itself: a hand-encoded A query, DNS-over-TCP framing (RFC 7766), sent through a SOCKS5 CONNECT to `1.1.1.1:53`. The query crosses the tunnel and is answered on the far side.

Measured, 5 rounds × 3 names = 15 lookups:

| | Local resolver (before) | Through the tunnel (now) |
|---|---|---|
| Resolved | 15/15 | **15/15** |
| Median | 0–1 ms | **80 ms** |
| Same address returned | — | 15/15 |

The 80 ms is the point, not a regression. A lookup that costs nothing was not travelling; one that costs a round trip through Frankfurt is.

**End-to-end, not just a lookup:** the in-tunnel answer for `api.ipify.org` was used for a SOCKS5 CONNECT and the request came back from `104.28.197.9` — the tunnel's exit. Resolution on the far side still reaches the right destination.

**What this does not fix:** Aether still refuses hostname CONNECT, so every caller must opt into this resolver. A code path that calls `dns.lookup` and then `socks5Connect` reopens the leak. Only A records are parsed; AAAA is not implemented. Requirement 2 is now **PARTIAL-to-closed at lab level**, not "DNS is solved everywhere".

---

## 2. Leak checks — IPv6 is carried, and there is no v6 path to leak onto

| Check | Result |
|---|---|
| Direct IPv6 egress from this host | **none** (`fetch failed`) |
| SOCKS5 CONNECT to an IPv6 literal (`2606:4700:4700::1111:443`) | **accepted** (`rep 0`) |
| TLS handshake over that IPv6 socket through the tunnel | **completed**, cert `CN=cloudflare-dns.com` |
| IPv4 exit through the tunnel | `104.28.197.9` |

Two things follow. First, **IPv6 is genuinely tunnelled** — a TLS session with a valid certificate is bytes, not a handshake reply. Second, on this machine there is no direct v6 path, so there was never a v6 route for traffic to escape by.

The honest caveat: a host *without* IPv6 cannot demonstrate the absence of an IPv6 leak on a dual-stack network. What this run does show is that the tunnel accepts v6 targets, so a dual-stack user would have their v6 inside the tunnel rather than beside it — provided the client routes v6 through SOCKS, which this build's helper does via the ATYP 0x04 path.

Not covered: UDP/QUIC leak behaviour (the listener here is TCP-only), and OS-level resolver changes.

---

## 3. Recovery — killed hard, back in 3.0 s, same exit

The tunnel process was stopped with `taskkill /PID … /F` (hard kill, not a graceful shutdown), then restarted exactly as the app starts it.

| Measurement | Value |
|---|---|
| Relay before | true, exit `104.28.197.9` |
| Down state observed | **93 ms** after the kill |
| Back up | **3,032 ms** after spawn |
| Total outage | **3,125 ms** |
| Exit after recovery | `104.28.197.9` (unchanged) |

**Verdict: PASS** for this failure mode. Caveats: recovery used the cached identity and gateway, so a cold start is slower and unmeasured; and this is one cycle, not a soak — repeated failures, gateway rotation and mid-transfer interruption are not covered.

---

## What these three runs change

- Requirement 2 moves from "measured, and it leaks" to "measured, DNS inside the tunnel, leak closed at client level".
- Requirement 4 gains recovery evidence alongside the four negative controls.
- The dashboard's evidence ledger gains three rows (`dns-in-tunnel`, `leaks`, `reconnect`), each citing its artifact.

## Reproduce

```bash
# tunnel up on 1819 first
npx tsx scripts/dns-tunnel-proof.ts 1819
npx tsx scripts/leak-test.ts 1819
npx tsx scripts/reconnect-test.ts <aether-pid> 1819
```
