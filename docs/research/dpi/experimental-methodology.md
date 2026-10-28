# Experimental Methodology

## 1. Safety boundaries

- Use only owned/authorized VPSes, domains, and test clients.
- Do not scan or stress government filtering infrastructure, unrelated
  networks, or arbitrary public ranges.
- Do not run a test that restarts production Xray/Hysteria/SOCKS/Soar without
  a reviewed change plan and rollback.
- Keep DNS tests low-volume. Do not use a tunnel for bulk traffic.
- Never print or commit keys, panel paths, full profiles, or subscription URLs.
- Stop if the test affects unrelated services, users, or data.

## 2. Vantage hygiene

A measurement is only as good as its vantage. Record:

- timestamp and timezone
- hostname/role (dev workstation, VPS, external node)
- ASN/ISP and access type (fixed/mobile), if known
- local TUN/proxy state, default route, resolver
- client and server versions
- exact endpoint, port, transport, SNI, and DNS server
- whether the path is direct, proxied, or inside a TUN

The current Windows host is behind `happ-xray` TUN. Its DNS answers are not a
valid Iranian-ISP measurement. Use the VPS or an external node for DNS-path
tests until the TUN is accounted for.

## 3. Stage model

Every attempt is classified at the highest proven stage:

1. DNS resolution
2. TCP/UDP reachability
3. TLS/QUIC handshake
4. authenticated tunnel
5. HTTP response through the tunnel
6. content/egress verification

A later stage is never inferred from an earlier one. A DNS answer does not
prove a tunnel; a TLS handshake does not prove the proxy authenticated; a
200 does not prove the origin unless the content is controlled.

## 4. WhiteDNS/Soar procedure

### VPS-side (authorized)

```bash
/usr/local/bin/soar-check -version
/usr/local/bin/soar-check \
  -zone "$ZONE" -pubkey "$PUBKEY" \
  -resolver '1.1.1.1:53,8.8.8.8:53,9.9.9.9:53' \
  -tcp auto -url 'https://example.com/' -timeout 45s -json
```

Repeat with `-tcp off`, `-tcp only`, and `-tcp auto`. A wrong key must fail.
Capture only the JSON result, not the key.

### Windows-side

Build a client from a pinned source (e.g. `getlantern/soar` v0.2.3) or use a
tested external client. Run it only when no conflicting TUN owns the route.
If it times out while the VPS succeeds, classify `BLOCKED_ENVIRONMENT` and
record the route/DNS evidence; do not call the server broken.

### NetPulse API-side

`WhitednsService` now:

- requires `AA=1` and NS/SOA for the exact zone over UDP; an ancestor SOA is
  accepted with a non-conformance label, not as a clean exact-zone answer;
- repeats the check with a real TCP/53 DNS query;
- uses `WHITEDNS_PUBKEY` when the UI omits the key;
- uses `WHITEDNS_SOAR_CHECK` for a non-default binary;
- uses `WHITEDNS_PROXY` (HTTP CONNECT) for TCP/53 when a local TUN forges UDP
  answers, and labels the fallback;
- skips the tunnel stage honestly when the binary is absent or when a proxy
  is configured (because `soar-check` has no proxy transport).

It does not claim a tunnel if the tool is missing. For a full Windows tunnel
test on a TUN host, use a proxy-capable client and record that the path went
through the local proxy, not direct.

## 5. Controlled endpoint

Use a NetPulse-owned endpoint that returns a random nonce or a fixed known
body over HTTPS. Do not use a random third-party site as the only proof.
Verify:

- TLS certificate/chain and SNI
- HTTP status and body/nonce
- server-side source IP or an independent egress observation
- DNS resolver/path used

## 6. Sample size and reporting

- At least 20 attempts per path where safe; report the actual number if fewer.
- Separate handshake latency, DNS latency, and first HTTPS byte.
- Report median and p95, not only the best run.
- Include failures and their stage; do not hide them in an aggregate.
- Repeat on at least two vantages before a product claim.
- Record known confounders (TUN, proxy, cache, resolver, time of day).

## 7. Result record template

```text
Experiment:
Date/time (UTC):
Vantage / ASN / access:
Client / server versions:
Transport / endpoint / SNI:
DNS server / resolver:
Local route / TUN / proxy:
Attempts / successes:
DNS timing:
Handshake timing:
First HTTPS byte:
HTTP status / nonce:
Egress observation:
Failure stages:
Confounders:
Label:
Conclusion / confidence:
```

## 8. Negative controls

Every positive test should have at least one:

- wrong public key or credential
- expired/revoked entitlement
- blocked port/transport
- wrong SNI or certificate
- DNS server that is not authoritative for the zone
- tunnel tool absent

A test suite that cannot fail is not evidence.
