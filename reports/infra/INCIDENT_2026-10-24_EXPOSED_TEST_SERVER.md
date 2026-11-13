# Incident: exposed test HTTP server on the VPN host (2026-10-24)

**Severity:** High (live VPN credentials publicly reachable) — contained and rotated.
**Status:** CLOSED. All exposed credentials are invalid; every protocol re-verified end to end.
**Author:** mission agent (`NETPULSE_AUTONOMOUS_V1`).

## What happened

While checking the host's public attack surface, `206.1.96.89:8080` answered
HTTP from the public internet. It was a leftover static file server started in
an earlier verification session, bound to `0.0.0.0`, serving `/tmp` — which
held the generated **client** configurations for every Xray inbound plus the
Hysteria client config.

Exposed material (now rotated and inert):

| Protocol | Credential exposed |
|---|---|
| VLESS Reality (:443) | client UUID |
| VMess WS (:8443) | client UUID |
| VLESS WS+TLS (:2053) | client UUID |
| Trojan TLS (:2087) | password |
| Shadowsocks 2022 (:8388) | pre-shared key |
| Hysteria 2 (:8443/udp) | auth password + salamander obfs password |

The Worker's `/api/v1/provision` also carried the same shared values as source
literals (`cloud/worker/src/index.ts`), so they were in the working tree and in
the deployed bundle as well.

## Timeline (UTC)

- 18:19 — port 8080 found answering publicly; process killed and port checked closed.
- 18:27 — external confirmation via check-host.net: **Connection refused** from DE and IR nodes.
- 18:28 — every Xray inbound client identity/password and both Hysteria passwords rotated on the host. Config validated with `xray -test`, services restarted, all listeners up.
- 18:31 — six protocols proven with a real client on the host: each SOCKS session fetched `https://api.ipify.org` and returned **206.1.96.89** (Reality, VMess-WS, VLESS-WS+TLS, Trojan, SS2022, Hysteria 2).
- 18:36 — Worker credentials moved to secrets; stale Reality public key and Hysteria SNI fixed; deployed `33b611f2`.
- 18:42 — `/api/v1/provision` returned connectable configs for the same six protocols, each verified through a real client.
- 18:51 — re-provisioning made idempotent (unique-index conflict), deployed `88e42ea7`.
- 18:59 — unreachable SOCKS profile removed from the generator, deployed `5b0ce44f`; test account and D1 rows removed; `/tmp` client configs deleted on host.

## Root causes

1. **Ad-hoc test server bound to all interfaces.** A verification helper served
   a directory of generated secrets. It should have bound `127.0.0.1` and been
   torn down by its harness.
2. **Shared VPN credentials in Worker source.** `/provision` interpolated
   literal UUIDs/passwords. Moving to Worker secrets removes the source copy.
3. **Stale Reality public key.** The hard-coded key did not match the server's
   private key, so *every* Reality profile the Worker issued failed its
   handshake (found while validating the rotation). Replaced with the key
   derived from the live private key (`xray x25519 -i`).
4. **Wrong Hysteria SNI.** Profiles used `www.microsoft.com` + `insecure:true`;
   the QUIC handshake only completes with the certificate's name
   (`206-1-96-89.sslip.io`). Fixed and verified.
5. **Non-idempotent provisioning.** `INSERT … ON CONFLICT(id)` collided with the
   partial unique index `(user_id, name) WHERE deleted_at IS NULL` on the second
   call, so retries returned errors. Now upserts on that index and returns the
   surviving row id; covered by `test/provision.test.ts`.

## Verification evidence

| Check | Result |
|---|---|
| 8080 externally reachable | **No** — check-host DE/IR: connection refused |
| 8080 listening on host | No |
| Xray config after rotation | `xray -test` valid, service active |
| Six protocols with rotated creds | All egress `206.1.96.89` |
| Worker `/provision` (deployed) | 200, six profiles, zero errors, repeat call also 200 |
| Those provisioned configs, real client | All six egress `206.1.96.89` |
| Worker tests / typecheck | 95/95 pass; `tsc --noEmit` clean |
| Old literals in `cloud/`, `apps/`, `packages/`, docs | none outside dead build caches (removed) |

## Rollback

Backups of the pre-rotation configs are root-only at
`/root/netpulse-rotate-1792866520/` on the host (`xray.config.bak.json`,
`hysteria.config.bak.yaml`). Rolling them back would restore **revoked**
credentials and break the deployed Worker's secrets, so restore only together
with a new secret rotation.

## Residual risk / follow-ups

- `netpulse-socks.service` (microsocks) binds `127.0.0.1:18080` but was started
  with empty arguments while `MICROSOCKS_USER` / `MICROSOCKS_PASS` sit unused in
  its environment — loopback only, so not remotely reachable, but the unit
  should pass the credentials explicitly or drop auth deliberately. Not changed
  here because dnstt depends on it and that needs its own restart test.
- Rotated values remain in git history. They are revoked, so the exposure is
  inert; no history rewrite is warranted.
- Any user who imported a pre-rotation profile must re-provision.
