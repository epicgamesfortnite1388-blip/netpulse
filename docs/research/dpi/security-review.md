# Security and Privacy Review

Scope: WhiteDNS/Soar, the NetPulse diagnostic, local Windows test environment,
and the integration path. No secrets are reproduced here.

## 1. Findings

### HIGH — exposed panel access path

The randomized Soar panel path was exposed during troubleshooting. The panel
is HTTP-only on `127.0.0.1:12053`, reached through an SSH tunnel, so it is not
publicly reachable; however, the path is a secret and must be rotated using
the supported mechanism. Do not commit it, paste it into chat, or put it in a
screenshot.

**Action:** owner-approved rotation; keep the listener loopback-only; do not
publish 12053. Do not "fix" HTTPS by taking 443 from Xray.

### HIGH — panel version and update drift

The VPS bundle is `soar-panel-0.6.0`; the repository advertises 0.8.0. Do not
blindly upgrade a live DNS server: read the release notes, back up accounts/
keys/config, and test the Soar/Cotten profiles. A binary-only upgrade may not
run the installer's DNS checks.

### HIGH — Windows host DNS is intercepted

`happ-xray` TUN owns the default route and every tested resolver returns
`AA=1` with no answers in 5-9 ms. This is a local privacy/correctness issue:
local DNS-based diagnostics are invalid, and a careless "direct" test is
actually going through the TUN. Do not disable the user's VPN; use the VPS or
an external vantage, or document the TUN state.

### MEDIUM — shared/test WhiteDNS profile

The Worker has a test profile with a zone/server/public key. A public key is
not a secret, but the zone/server pair and any shared account key are
operational assets. Do not treat the test profile as a customer entitlement.
Bind WhiteDNS to per-user D1 entitlements and revoke at the panel.

### MEDIUM — tunnel diagnostic path

The service now supports `WHITEDNS_SOAR_CHECK`, `WHITEDNS_PUBKEY`, and
`WHITEDNS_PROXY`. A misconfigured path can execute an arbitrary binary; treat
these as administrator-controlled environment values, not user input. The API
validates zone/server/pubkey and does not accept a path or proxy from the
request. `WHITEDNS_PROXY` accepts only `http://` and is intended for a local
proxy; it must not be pointed at an untrusted relay. Do not expose a generic
"run this binary" endpoint.

The Windows proxy test used the user's existing Happ proxy without changing
the TUN or system route. It is a test path, not a claim that the proxy is part
of the product.

### MEDIUM — DNS tunnel abuse surface

An authoritative DNS tunnel can be abused for arbitrary egress if the server
allows all destinations/ports. Soar defaults to public destinations and ports
80/443; verify the actual allow-list. Keep anti-flood/rate limits and account
quotas. Do not run an open resolver; the VPS correctly returns REFUSED for
unrelated recursion.

### LOW/MEDIUM — licensing

- Soar and the Soar-Server panel: Apache-2.0.
- CottenDNS: MIT lineage; GitHub API reports NOASSERTION for the aggregate;
  review before redistribution.
- WhiteDNS Android: source-available proprietary; no copying/repackaging.
- WhiteVPN: GPL-3.0; not the DNS tunnel.
- StormDNS: license unresolved; do not vendor.

### LOW — DNS zone conformance

The child tunnel zone lacks an apex NS in some responses and its SOA MNAME is
the zone itself. It resolves today but is non-conforming; fix through the
panel/zone generator. This is a reliability issue, not an immediate exploit.

### LOW — local test client

The Windows Soar client was built in a temp directory from a pinned public
source; it is not shipped. Do not commit a test binary or a profile key.

## 2. Positive controls observed

- Soar wrong-key test failed closed.
- TCP/UDP DNS tests now require `AA=1` and exact-zone NS/SOA (or a labeled
  parent SOA); a forged empty answer no longer passes.
- Panel is loopback-only; port 53 is the only public DNS surface.
- No secrets were printed in this review.
- The local TUN was documented rather than disabled.

## 3. Privacy

A DNS tunnel reveals to the recursive resolver that a client is using a
delegated zone, and reveals query timing/size. It does not hide the client IP
from the authoritative server or the resolver. ECH does not hide the
destination IP. NetPulse should:

- minimize per-user destination/DNS logs;
- avoid IP-to-account retention beyond billing/abuse needs;
- redact profile URIs, keys, panel paths, and tokens;
- disclose residual metadata honestly.

## 4. Required production change plan

Before rotating the panel path or changing DNS:

1. Record current services, listeners, panel bundle/version, and zone records.
2. Back up the panel state/accounts and DNS zone.
3. Keep SSH recovery open; do not flush firewall rules.
4. Change one thing; validate `soar-check` and an existing account profile.
5. Roll back on failure; retest DNS UDP/TCP and HTTPS through the tunnel.
6. Record the exact change and rollback artifact (without secrets).
