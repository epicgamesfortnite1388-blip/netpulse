# Recommended Architecture

## 1. Principles

1. **Measure the path, not the brand.** A protocol is a candidate until a real
   client reaches a controlled endpoint through it.
2. **Separate control, profile, and data plane.** D1 entitlement ≠ panel
   account ≠ profile ≠ tunnel.
3. **Fail closed and say why.** A missing tool, key, or route is a typed
   failure, not a green badge.
4. **Prefer established cryptography and implementations.** No custom crypto,
   no disabled certificate checks, no shared non-revocable credentials.
5. **Keep the user's existing working path.** A new experiment must not break
   the current Xray/Hysteria/SOCKS/Soar services.

## 2. Transport ladder

| Order | Path | Use when | Required proof |
|---|---|---|---|
| 1 | REALITY/VLESS TCP/443 | default; TLS cover works | real client + HTTPS nonce + egress |
| 2 | VLESS/VMess WS+TLS on a NetPulse domain | REALITY target/IP blocked | real client + controlled endpoint |
| 3 | Hysteria2 / UDP fallback | TCP filtered, UDP survives | QUIC handshake + HTTPS through it |
| 4 | Soar/Cotten DNS tunnel | only DNS survives | authenticated tunnel + HTTPS + revocation |
| 5 | External client (WhiteDNS Desktop/CottenDNS) | NetPulse cannot embed the client | documented external workflow, no false state |

Do not run all paths simultaneously by default. Race only when bounded, and
never let a fallback bypass entitlement or leak traffic outside the intended
path.

## 3. Client state machine

```text
idle
  -> resolving (bootstrap DNS)
  -> connecting (selected transport)
  -> authenticating (server proof)
  -> verifying (controlled HTTPS nonce + egress)
  -> connected
  -> degraded (health probe fails; retry/fallback)
  -> disconnecting
  -> idle
```

Rules:

- `connected` requires stage 5, not a socket.
- A failed probe moves to `degraded`, not a silent "connected".
- Fallback is explicit; log the previous stage and reason.
- DNS/system settings are restored on every exit path.
- Revocation/expiry is checked at the server, not only in the UI.

## 4. Adaptive selection ("small AI", bounded)

A contextual bandit is acceptable only as a **policy over measured outcomes**,
not as a traffic classifier or a DPI bypass oracle.

- Context: network fingerprint hash (ASN/SSID coarse), time bucket, last
  failure stage, protocol family.
- Arms: the ladder entries.
- Reward: authenticated HTTPS success, then latency/throughput, penalize
  leaks/false positives.
- Exploration: epsilon-greedy or UCB with a hard cap; never explore during a
  user-visible sensitive session without consent.
- Persistence: local, privacy-preserving, no destination history.
- Safety: deterministic fallback, kill switch, no unbounded retries.
- Offline evaluation first; production only after measured benefit and
  security review.

Do not call this "AI discovers flaws in DPI". It learns which **already
implemented** path works on a network; it does not probe or attack the censor.

## 5. DNS architecture

- Bootstrap: a known resolver/IP, not the tunnel being established.
- Encrypted DNS: DoH/DoT/DoQ where verified; never silently downgrade.
- Tunnel DNS: explicit mode, leak-tested.
- WhiteDNS: separate profile; authoritative delegation; per-account.
- Cache: respect TTL/negative TTL; do not override with arbitrary answers.

## 6. Provisioning and entitlement

```text
D1 entitlement
  -> per-user credential (protocol-specific)
  -> server-side client record
  -> profile generation
  -> client import
  -> server-side revocation/expiry
```

- One identity per (user, protocol); never a shared UUID/password for a paid
  plan.
- Profile tokens are unguessable, scoped, short-lived, and revocable.
- A failed server provisioning must not activate a paid entitlement.
- Reconciliation compares D1 and server state; drift is repaired idempotently.
- WhiteDNS accounts/subscriptions follow the same rule.

## 7. Observability and privacy

Collect only what is needed to explain a failure:

- stage, protocol family, coarse network context, latency bucket, error code
- no destination history, no full DNS queries, no profile secrets
- no IP-to-account association beyond what billing requires
- redact panel paths, keys, subscription URLs, and tokens

## 8. Deployment sequence

1. Land the DNS validation/tcp-query/pubkey fixes (done in code).
2. Add tests and run the API suite.
3. Choose the Windows WhiteDNS client path; do not fake it.
4. Bind WhiteDNS to D1 entitlements and test expiry/revocation.
5. Add the bounded transport selector in staging; compare with static order.
6. Only then consider ECH/SNI experiments on a NetPulse-controlled front.

## 9. Rejected designs

- Arbitrary third-party SNI / impersonation.
- Custom encryption or a new tunnel protocol without review.
- Treating DoH, SOCKS, or a DNS SOA answer as a VPN.
- Shipping a shared server credential to every client.
- Auto-fallback that bypasses subscription or leaks direct traffic.
- A "connected" state based on a process or socket.
