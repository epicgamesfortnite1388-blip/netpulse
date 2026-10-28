# DNS Circumvention and WhiteDNS Data Plane

## 1. Four different things called "DNS"

| Thing | What it does | What it proves |
|---|---|---|
| Plain DNS (UDP/TCP 53) | resolves names | nothing about integrity; vulnerable to on-path injection |
| DoH / DoT / DoQ | encrypts client-to-resolver DNS | protects that hop; resolver policy and destination IP remain visible |
| DNS through a proxy/tunnel | sends resolver queries inside an encrypted tunnel | protects the query path; not a DNS tunnel protocol |
| DNS tunnel (Soar/Cotten/MasterDNS) | carries arbitrary TCP streams inside DNS queries/responses | a data plane over DNS, if authenticated and actually tested |

NetPulse must not conflate these. A DoH URL in settings is not a DNS tunnel;
a successful `dig` is not a working tunnel.

## 2. Authoritative delegation

A DNS tunnel needs:

1. An authoritative zone delegated with NS (e.g. `t.example.com`).
2. A nameserver hostname with an A/AAAA record (e.g. `ns.example.com`).
3. UDP/53 and TCP/53 reachable at the authoritative server.
4. The server configured for the exact zone and key.
5. A client profile containing the zone, server, and public key.

The WhiteDNS VPS currently has a `soar` delegation and a child zone
`gb6ysaxnm3z4r7ffwzbn5.soar.abystral.dpdns.org`. A real Soar client completed
an authenticated tunnel and fetched HTTPS 200 from the VPS vantage. The child
zone lacks an apex NS record in some queries; it resolves today but is
non-conforming and should be fixed by the panel vendor or zone generator.

## 3. What the NetPulse diagnostic now verifies

`apps/api/src/services/whitednsService.ts`:

1. **Input** — zone, IPv4 server, base64 pubkey.
2. **DNS/UDP** — `AA=1` and NS or SOA for the **exact** zone; a parent-zone
   SOA is accepted but labeled non-conforming (the live Soar zone currently
   returns this shape). A referral, unrelated authority, empty answer, or
   non-NOERROR response fails.
3. **Reachability/TCP** — a real length-prefixed DNS query over TCP/53 with
   the same authoritative check, not just a TCP connect.
4. **Tunnel** — if a public key and `soar-check` are available, run an
   authenticated client that fetches an HTTPS URL. If the binary is absent,
   the stage is explicitly skipped; it never reports success.

The public key can come from `WHITEDNS_PUBKEY`; the binary path can come from
`WHITEDNS_SOAR_CHECK`. On Windows the API host usually does **not** have the
Linux `soar-check`; the tunnel stage will be skipped unless a Windows build is
provided. This is honest but means the current Windows UI cannot prove the
tunnel by itself.

`WHITEDNS_PROXY` (HTTP CONNECT, e.g. `http://127.0.0.1:10808`) makes the TCP
DNS checks usable on a host whose TUN forges UDP answers: the UDP stage falls
back to TCP/53 through the proxy and labels it. The tunnel stage is still
skipped because `soar-check` has no proxy transport. A separate Windows
client with a SOCKS5 `DialTCP` proved the full tunnel through the same local
proxy (HTTP 200, 3.4 s); see the result record.

## 4. Local observation that changed the test design

On the Windows development host:

- `happ-xray` TUN owns the default route (ifIndex 58).
- UDP DNS to `1.1.1.1`, `8.8.8.8`, `9.9.9.9`, and the VPS returned `AA=1`
  with zero answers in 5-9 ms.
- The Windows Soar client timed out after 90 s.
- The VPS `soar-check` succeeded over the same protocol.

This is a local resolver/TUN interception, not an Iranian-ISP measurement.
It is exactly why the old "any authority section" check was unsafe: a forged
empty authoritative answer would have passed the old stage.

## 5. Resolver selection and bootstrap

- A DoH/DoT/DoQ endpoint must be reachable before the VPN connects; bootstrap
  cannot depend on the tunnel it is trying to establish.
- DoH protects the HTTP hop but not the resolver's policy. Verify the resolver
  identity and DNSSEC AD where applicable.
- DoQ is UDP/853; it is not a bypass if UDP is blocked, and RFC 9250
  explicitly does not try to evade middlebox classification.
- Never silently fall back from encrypted DNS to plaintext. If fallback is
  allowed, expose it as a user-visible policy and test it.

## 6. DNS leak tests

For each mode (system DNS, tunnel DNS, DoH, DoT, DNS tunnel):

1. Resolve a unique controlled name from inside and outside the tunnel.
2. Observe which resolver/server receives the query (authorized capture).
3. Verify the answer is authoritative and matches the expected record.
4. Check A/AAAA behavior and fallback.
5. Disconnect and confirm the system resolver is restored.
6. Reconnect and repeat.

A resolver identity test is not a leak test unless the query path is actually
observed; `resolvectl status` alone is insufficient.

## 7. WhiteDNS profile and account model

The Soar panel issues per-account profiles/subscriptions; the current
NetPulse Worker has a test profile with a zone/server/pubkey. Do not treat
that shared test profile as a customer entitlement. The integration must:

- Bind a profile to the D1 entitlement and the user.
- Keep protocol-specific formats separate (Soar profile ≠ Xray URI ≠ WG conf).
- Revoke/expire at the server/account layer, not only in the client UI.
- Avoid putting panel paths, admin passwords, or shared keys in logs.

## 8. Acceptance criteria

- `PASS_DNS_PATH_VERIFIED`: UDP and TCP authoritative checks pass for the
  exact zone from an external, non-TUN vantage.
- `PASS_WHITEDNS_REAL_CLIENT`: a real compatible client authenticates and
  carries HTTPS through the tunnel.
- `PASS_SUBSCRIPTION_E2E`: a fresh entitlement produces a profile, the tunnel
  works, and revocation stops it.
- DNS SOA/NS alone: **not** any of the above.
