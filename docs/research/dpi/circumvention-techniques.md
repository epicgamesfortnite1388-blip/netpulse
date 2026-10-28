# Circumvention Techniques: Prior Art and Failure Modes

The goal is not a list of magic protocols. Each entry states the problem it
addresses, the evidence, and the conditions under which it fails.

## 1. TLS camouflage: REALITY / VLESS

**Problem:** direct proxy protocols are fingerprintable; a TLS-looking
connection has a larger anonymity set.

**Mechanism:** REALITY steals a real TLS handshake from a target, authenticates
the client without a separate certificate, and otherwise behaves like the
target (S13, S14).

**Evidence:** documented by Xray/REALITY; the NetPulse VPS has a REALITY
inbound and prior live tests report successful client connections.

**Failure modes:** target changes/blocks the server IP; active probing; wrong
SNI/target; version mismatch; the server still has a stable IP and traffic
shape.

**Do not claim:** "undetectable", "ECH", or "works on every ISP".

## 2. WebSocket/TLS and CDN fronting

**Problem:** a TLS endpoint can be reached through a CDN or a real web host.

**Mechanism:** VLESS/VMess over WS+TLS behind a reverse proxy/CDN (S09, S13).

**Evidence:** WhiteDNS Wizard documents Cloudflare-proxied WS profiles;
NetPulse has WS+TLS inbounds.

**Failure modes:** CDN ToS/route restrictions; WebSocket path fingerprint;
CDN blocks the account; origin IP leaks; TLS certificate/domain mismatch.

**Authorization rule:** only use domains/endpoints NetPulse owns or is
explicitly authorized to use. Do not impersonate an unrelated site.

## 3. DNS tunnels: Soar / CottenDNS / MasterDNS / StormDNS

**Problem:** networks may permit DNS when other transports fail.

**Mechanism:** carry TCP streams in DNS queries/responses through recursive
resolvers to an authoritative delegated zone (S07, S08, S12, S27, S28).

**Evidence:** Soar v0.2.2 on the VPS passed a real `soar-check` over UDP/TCP
and carried HTTPS 200 from the VPS vantage. CottenDNS documents a Windows
client and adaptive path control. No Iran vantage.

**Failure modes:** resolver rate limits/truncation; DNS interception; long
QNAME filtering; tunnel latency; shared-key normal mode; account/zone
misconfiguration; client platform gap (WhiteDNS Android is Android-only and
proprietary).

**Do not claim:** DNS tunnel = full VPN; a DNS SOA/NS response = a working
tunnel; "WhiteDNS" = WhiteVPN/Mihomo.

## 4. QUIC/UDP: Hysteria2 / TUIC

**Problem:** TCP/TLS may be filtered while UDP survives (or the reverse).

**Mechanism:** QUIC transport with loss-tolerant congestion control and
optional obfuscation (S19, S20).

**Evidence:** documented implementations; NetPulse has Hysteria2 on the VPS.
No current Windows/Iran live test.

**Failure modes:** UDP blocked/throttled; QUIC classification; MTU/PMTU;
0-RTT replay considerations.

## 5. WireGuard and AmneziaWG

**Problem:** stock WireGuard has a stable, easily fingerprinted packet shape.

**Mechanism:** AmneziaWG adds obfuscation parameters while remaining
WireGuard-compatible (S25).

**Failure modes:** obfuscation parameters become a new signature; UDP path
blocked; key management and revocation still required.

## 6. Shadowsocks / Shadowsocks 2022

**Problem:** a lightweight TCP proxy with a large installed base.

**Mechanism:** AEAD/2022 ciphers (S22).

**Failure modes:** shared password in the current NetPulse deployment means
no per-user revocation; protocol fingerprinting; active probing.

**Required change:** per-user identity or a server-side revocation channel
before calling it subscription-enforced.

## 7. NaiveProxy / HTTP(S) front

**Problem:** make proxy traffic look like a browser's HTTPS.

**Mechanism:** Chromium network stack + real HTTPS server (S21).

**Failure modes:** requires a domain/certificate and server; traffic shape
still observable; not a generic SNI substitution.

## 8. Tor pluggable transports / Psiphon

**Problem:** direct access to circumvention infrastructure is blocked.

**Mechanism:** bridges, obfs4/Snowflake, Psiphon's adaptive tunnel selection.

**Status:** not tested in this iteration; the Psiphon GitHub API lookup failed
(404), so no repository claim is made. Treat as prior art to evaluate, not a
verified NetPulse component.

## 9. Client-side DPI evasion (ByeDPI / Geneva)

**Problem:** a local middlebox interferes with a specific handshake.

**Mechanism:** fragmentation/desync or packet-manipulation strategies (S29,
S30).

**Failure modes:** stateful filters, application breakage, target-specific
results; Geneva is a research tool, not a production client.

**Rule:** only in an authorized lab; never against third-party networks.

## 10. What not to do

- Do not use an unrelated popular domain as SNI without authorization and a
  matching certificate/route.
- Do not disable certificate validation, log full profile URIs, or embed a
  shared server key in a client.
- Do not claim a fingerprint change is effective without a real client/server
  experiment.
- Do not call a DNS resolver, DoH endpoint, or SOCKS proxy a "VPN".
- Do not treat a single successful request as a reliable path.
