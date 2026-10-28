# Censorship Mechanisms: What Is Observed and What Is Inferred

This file separates mechanism-level observations from conclusions. It is
deliberately conservative: a failure is assigned to the highest layer that is
actually proven, not to "DPI" by default.

## 1. DNS injection and poisoning

**Observation.** Iran-focused measurements report forged DNS answers and
block-page address injection (S01, S05); FOCI 2025 reports some correct but
static answers and DNS/HTTP correlations (S02).

**Layer.** DNS, before TLS.

**Symptoms.** Fast answer from every resolver, private/bogon or block-page
address, inconsistent A/AAAA by resolver, `AA`/authority mismatch.

**Competing explanations.** Local resolver hijack; stale cache; broken
authoritative zone; CDN variation.

**Discriminator.** Direct authoritative query with `RD=0`, check `AA` and
exact zone; compare resolver answers and timing; query from a non-TUN host.

**NetPulse relevance.** The WhiteDNS check now rejects non-authoritative or
zone-mismatched answers. The local Windows host demonstrates why: a local TUN
can forge an authoritative-looking empty answer.

## 2. HTTP block-page injection / transparent proxy

**Observation.** OONI and IRBlock report block pages served via DNS injection
and transparent HTTP proxies (S01, S05).

**Layer.** HTTP or TLS interception; may be reached after a successful TCP
connection.

**Symptoms.** HTTP 200 with an unexpected body, redirect to a filtering page,
TLS certificate mismatch, connection reset after ClientHello.

**Discriminator.** Fetch a controlled nonce through the path and compare it to
the origin; verify the certificate chain and SNI; compare direct vs tunneled
responses.

## 3. SNI and TLS metadata

**Observation.** TLS 1.3 still sends SNI in ClientHello; ECH is specified but
requires deployment (S31, S34, S35). REALITY is TLS camouflage, not ECH (S13,
S14).

**Layer.** TLS ClientHello and handshake shape.

**Symptoms.** TCP connects, then reset/timeout before ServerHello; failure
depends on SNI/ALPN/version; same IP works with a different name.

**Discriminator.** Vary one field at a time; capture ClientHello; compare
server certificate/cover behavior; test from another vantage.

**NetPulse relevance.** Do not claim ECH. Do not assume uTLS fingerprint
changes are effective without a real client/server experiment (PattNG S18
adds options but publishes no efficacy measurement).

## 4. Protocol whitelisting and transport fingerprints

**Observation.** FOCI 2020 documents an Iran protocol filter that permits a
small set (DNS/HTTP/HTTPS) and censors others; packet manipulation could
defeat it at the time (S03). IRBlock reports UDP disruption (S01).

**Layer.** Transport/protocol classification.

**Symptoms.** Non-standard TCP/UDP protocols fail while HTTPS works; UDP/QUIC
fails while TCP/443 works; long-lived or high-volume flows are throttled.

**Discriminator.** Same endpoint, same payload, different transport; compare
TCP/443, UDP/443, TCP/53, UDP/53; measure handshake and data phases separately.

## 5. Routing, destination, and overblocking

**Observation.** IRBlock reports TLD-wide overblocking and network variation
(S01); OONI reports non-deterministic blocking (S05).

**Layer.** IP/route/policy.

**Symptoms.** Whole TLD/subnet unreachable; one ISP works, another fails;
temporary outages; different results on mobile vs fixed.

**Discriminator.** Multiple vantages; trace the path; test a control domain
on the same IP/prefix; record ASN and time.

## 6. Local client artifacts

**Observation (this host).** `happ-xray` TUN owns the default route; every
tested resolver returns `AA=1` with no answer in 5-9 ms; direct HTTPS egress
is `83.229.87.141`; the Windows Soar client times out while the VPS client
succeeds.

**Layer.** Client routing/resolver, not the censor.

**Consequence.** Any local DNS or "direct vs VPN" claim from this host is
invalid until the TUN is accounted for. Use the VPS or an external node for
DNS-path tests.

## 7. Mechanism confidence table

| Mechanism | Existence in Iran | Current per-path applicability | Evidence |
|---|---|---|---|
| DNS injection/poisoning | Confirmed by multiple studies | Unknown without vantage | S01/S02/S05 |
| HTTP block pages | Confirmed | Unknown | S01/S05 |
| SNI-dependent filtering | Strongly supported | Unknown | S01/S03/S05 |
| Protocol whitelisting | Confirmed historically (2020) | Unknown today | S03 |
| UDP disruption | Confirmed in measurement | Unknown | S01 |
| TLD overblocking | Confirmed | Unknown | S01 |
| Local TUN/resolver hijack | Confirmed on dev host | N/A (local) | this lab |

## 8. What would change the model

- A parsed FOCI 2026 paper with reproducible automation results (S04).
- Fresh 2025-2026 OONI/IRBlock data from the user's ASN.
- A voluntary Iranian vantage with a controlled endpoint.
- Evidence that ECH is actually deployed and reachable on the target path.
- Evidence that a candidate transport survives a 20-attempt, multi-hour test.
