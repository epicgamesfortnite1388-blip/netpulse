# Iran Censorship Threat Model for NetPulse

Status: evidence-based model, **not** a claim of current Iran-wide behavior.
The only live tunnel measurement in this iteration is from the VPS itself
(see [`results/2026-10-25-soar-live.md`](results/2026-10-25-soar-live.md)).
No Iranian consumer-network vantage was available.

## 1. Model in one page

Iranian filtering is layered, inconsistent, and path-dependent. A connection
can fail at DNS, TCP/UDP transport, TLS metadata, HTTP semantics, or routing,
and different ISPs/times can expose different layers. Treat "blocked" as a
stage classification, not a boolean.

| Layer | Confirmed/strong behavior | What NetPulse must not assume | Confidence |
|---|---|---|---|
| DNS | forged/poisoned answers, block-page IP injection, resolver-specific inconsistency; IRBlock/OONI | that a DNS answer came from the delegated authoritative server | High for existence; Medium for a given path |
| HTTP | transparent proxies and block pages; IRBlock/OONI | that a TCP/TLS handshake implies the real origin | High |
| TLS metadata | cleartext SNI and ClientHello fields; TLS 1.3 leaves SNI visible; ECH is not deployed here | that TLS 1.3 or REALITY hides SNI | High |
| Transport | protocol whitelisting/fingerprinting; UDP disruption; IRBlock/FOCI 2020 | that a port is usable because it accepts a SYN | High for historical mechanisms |
| Routing | AS/ISP variation, overblocking, temporary outages | that one successful ISP result generalizes | High |
| Local client | TUN, proxy, resolver, and route policy can change the observed path | that a local test measures the ISP path | High (observed locally) |

## 2. DNS interference

### Mechanism

- On-path injection/race of forged responses, often with a block-page address
  or a private/bogon address.
- Correct but unexpected static IP answers for some names (FOCI 2025 S02).
- Resolver-specific behavior and inconsistent answers over time (OONI S05).
- Encrypted DNS can protect the client-to-resolver hop but not the resolver's
  own policy, and not the destination IP.

### Observable symptoms

- Answer arrives in single-digit milliseconds from every resolver, including
  distant ones.
- `AA=1` with no answer or an unrelated authority section.
- A/AAAA answers change by resolver or by query ID.
- TLS certificate/hostname does not match the resolved endpoint.

### Competing explanations

- A local TUN/resolver hijack, not the ISP.
- A recursive resolver returning a cached negative answer.
- A misconfigured authoritative zone (missing apex NS, as observed for the
  WhiteDNS child zone).
- Genuine CDN/anycast variation.

### Discriminating tests

1. Query the delegated authoritative server directly over UDP and TCP with
   `RD=0` and check `AA`, exact zone, NS/SOA.
2. Query multiple public resolvers and a local resolver with unique labels;
   compare transaction IDs, source ports, and timing.
3. Resolve from outside the local TUN (a VPS or external measurement node).
4. Compare the DNS answer with the TLS certificate and the observed HTTP
   origin.
5. Capture the packet on the client and at the server when authorized.

### NetPulse implication

The WhiteDNS diagnostic now requires `AA=1` **and** NS/SOA for the exact zone
(an ancestor SOA is accepted only with a non-conformance label), and performs a
real TCP DNS query. This closes a false-positive where any authority section
counted as success. It still cannot prove the tunnel; the tunnel stage is
separate.

## 3. TLS and SNI filtering

### Mechanism

- Cleartext SNI is visible in TLS 1.3 ClientHello; ECH encrypts the inner
  ClientHello but requires an ECH-capable client-facing server and a
  configuration published through HTTPS/SVCB (RFC 9849, S34).
- Cipher suites, extension order, ALPN, and record sizes create fingerprints.
- REALITY steals a real TLS handshake and is not ECH; it changes the
  authentication/camouflage story, not the fact that a TLS connection exists.

### Observable symptoms

- TCP connects, ClientHello is sent, then reset/timeout before ServerHello.
- Failure depends on SNI value, ALPN, or TLS version.
- The same IP/port works with a different hostname.
- A real certificate is returned for a cover site but the tunnel never starts.

### Competing explanations

- Destination IP blocking.
- MTU/PMTU black hole.
- Server-side certificate/target mismatch.
- Active probing or a middlebox that only permits a protocol shape.

### Discriminating tests

- Same IP/port, vary only SNI; record ClientHello and server response.
- Same SNI, vary destination IP; compare.
- TLS 1.2 vs 1.3, ALPN h2/http1.1, uTLS fingerprint variations.
- Compare direct vs proxied path with a timestamped controlled endpoint.
- Check whether the server's certificate/cover behavior is consistent.

### NetPulse implication

Do not advertise ECH. Keep REALITY/VLESS-WS-TLS as candidates; measure the
actual pair. Do not use an unrelated popular domain as arbitrary SNI without
authorization and a real certificate/route; that is impersonation, not
fronting.

## 4. HTTP interference

- Block pages can be injected at the HTTP layer even when DNS/TCP works.
- HTTP/2/3 parsing differences can produce different outcomes than HTTP/1.1.
- A response can be a valid-looking block page, not the origin.

NetPulse test rule: a 200 from a tunnel is not enough; compare a known body
or a random nonce from a controlled endpoint, and verify the TLS certificate
and expected content.

## 5. Transport and protocol classification

- FOCI 2020 documents a protocol whitelister that permits DNS/HTTP/HTTPS and
  censors other protocols; packet manipulation could defeat it at the time.
- UDP/QUIC may be blocked or degraded independently of TCP.
- Long-lived connections, packet sizes, and handshake timing are observable.
- A port accepting a TCP connection can be a local interceptor (observed on
  the Windows host: every tested DNS server returned an immediate empty
  authoritative answer).

NetPulse test rule: require an application-level success through the actual
tunnel, with a server-side or independent egress observation. A socket open,
a DNS response, or a process `active` is not enough.

## 6. Routing and network variation

- AS/ISP, mobile vs fixed, and time of day can change the result.
- Overblocking of entire TLDs/subnets is documented (IRBlock).
- A VPS-side test proves the server, not the Iranian path.
- The development Windows host is behind an active `happ-xray` TUN
  (`ifIndex 58` default route). Direct HTTPS egress reported
  `83.229.87.141`; DNS to four resolvers returned `AA=1`, no answers in
  5-9 ms. This is a **local environment** result and invalidates local DNS
  measurements.

## 7. Local client failure modes (observed)

| Observation | Evidence | Consequence |
|---|---|---|
| `happ-xray` TUN owns default route | `Get-NetRoute 0.0.0.0/0` → ifIndex 58 metric 0 | local direct path is already tunneled |
| all DNS resolvers answer immediately, empty, `AA=1` | Node UDP probes to 1.1.1.1/8.8.8.8/9.9.9.9/VPS | DNS-based tests from this host are invalid |
| Windows Soar client times out | `connect_failed=context deadline exceeded` after 90 s | `BLOCKED_ENVIRONMENT`, not server failure |
| VPS Soar client succeeds | `soar-check` HTTP 200 over UDP/TCP/auto | server and protocol are live |

## 8. Confidence summary

- **Confirmed:** the VPS Soar server authenticates a real client and carries
  HTTPS over UDP and TCP DNS paths from the VPS vantage.
- **Strongly supported:** DNS interception is common in Iran; TLS metadata and
  protocol shape matter; local TUN/DNS hijack can invalidate measurements.
- **Unverified:** current behavior on any specific Iranian ISP; ECH
  availability in Iranian networks; whether a given REALITY target survives
  active probing; WhiteDNS performance under Iranian loss/rate limits.
- **Speculation to reject:** "one SNI fixes blocking", "ECH hides the IP",
  "DNS tunnel equals a full VPN", "the VPS test proves Iran reachability".

## 9. Required evidence before any Iran-readiness claim

1. A voluntary Iranian vantage, with timestamp, ASN/ISP, access type, and
   consent.
2. Separate DNS, TCP, TLS, and HTTP stage results, repeated at least 20 times
   per path where safe.
3. A real client, not a synthetic packet, and a server-side or independent
   egress observation.
4. Negative controls (wrong key, expired profile, blocked port) and a
   fallback path.
5. A documented failure taxonomy, not a single success rate.
