# SNI, TLS 1.3, and ECH: What Is Actually Protected

## 1. The visible surface

| Field | TLS 1.3 without ECH | With ECH | Notes |
|---|---|---|---|
| Destination IP | visible | visible | ECH does not hide it |
| SNI | cleartext in ClientHello | inner value encrypted | outer SNI is the public name |
| ALPN | cleartext in ClientHello | inner value encrypted | outer may be innocuous |
| Certificate | encrypted after ServerHello | encrypted | issuer/chain still observable on the wire? only encrypted |
| Record sizes/timing | visible | visible | padding mitigates, does not eliminate |
| Plaintext DNS | visible | not fixed by ECH | use DoH/DoT/DoQ or a tunnel |
| Server identity | certificate/SNI | anonymity set of co-located servers | ECH requires an ECH-capable front |

Sources: RFC 8446 (S31), RFC 9849 (S34), Cloudflare explainer (S35).

## 2. ECH is not a drop-in SNI override

ECH requires:

1. A client that implements ECH and HPKE.
2. A client-facing server that publishes an ECHConfig and can decrypt the
   inner ClientHello.
3. A configuration published via HTTPS/SVCB (RFC 9460) or provisioned out of
   band.
4. Encrypted DNS or another trustworthy configuration channel; otherwise an
   on-path attacker can suppress or replace the ECHConfig.
5. An anonymity set: co-located origins with consistent TLS behavior. A
   unique server/IP still stands out.

It does **not** hide the destination IP, make the connection unblockable, or
turn a proxy into a VPN. It is not a feature of Xray REALITY, VLESS, or the
current NetPulse deployment.

## 3. REALITY versus ECH

| Property | REALITY | ECH |
|---|---|---|
| Goal | make the proxy look like a real TLS site | encrypt ClientHello metadata |
| SNI | visible (usually the cover site) | inner SNI encrypted |
| Server auth | REALITY's own handshake | certificate for public name + inner server |
| Requires ECH-capable server | no | yes |
| Hides destination IP | no | no |
| Current NetPulse support | yes (Xray) | no |

Do not describe REALITY as ECH. Do not add an ECH claim to the UI or reports
until an ECH-capable front is deployed and tested.

## 4. SNI strategies and their limits

### Authorized cover domain with a real certificate

Legitimate when NetPulse owns the domain and the server actually serves it.
The TLS certificate, HTTP behavior, and DNS must be consistent. This is a
normal HTTPS deployment, not impersonation.

### Unrelated popular domain as SNI

Usually fails because the server cannot present a valid certificate or the
cover site's routing/TLS behavior does not match. It can also be
impersonation, violate a provider's terms, and create a stable, blockable
signature. Reject this as a default.

### CDN/fronting

Legitimate only within the provider's supported routing and terms. Verify the
CDN property, origin, certificate, and WebSocket path. A CDN edge error
(e.g. "Invalid URL") is not a tunnel.

## 5. Fingerprints

TLS fingerprints include cipher-suite order, extensions, ALPN, record
boundaries, and timing. uTLS can change the client fingerprint, but:

- A different fingerprint is not automatically a better one.
- A static "Chrome" fingerprint can become its own signature.
- The server's certificate/cover behavior must remain consistent.
- PattNG adds `cipherSuites` and an "unsafe" fingerprint option (S18), but
  publishes no measured DPI-resistance result; do not copy the unsafe option.

## 6. Test matrix (authorized infrastructure only)

| Test | Controlled variable | Evidence required |
|---|---|---|
| SNI sensitivity | same IP/port, different SNI | ClientHello + server response, 20 attempts |
| IP sensitivity | same SNI, different IP | connection result + server-side source |
| TLS version | 1.2 vs 1.3 | negotiated version and data phase |
| ALPN | h2 vs http/1.1 | negotiated ALPN and HTTP result |
| Fingerprint | uTLS profiles | ClientHello capture + success rate |
| ECH | ECH-capable vs not | ECH acceptance/rejection and HTTP body |
| Cover consistency | target certificate/body | certificate chain + nonce response |

## 7. Recommendation

1. Keep REALITY/VLESS-WS-TLS as measured candidates; do not claim ECH.
2. Do not use arbitrary third-party SNI.
3. If ECH is pursued, deploy an ECH-capable front on a domain NetPulse
   controls, publish ECHConfig via HTTPS records, use encrypted DNS, and
   measure acceptance and fallback.
4. Treat fingerprint changes as hypotheses requiring a real client test, not
   as features.
