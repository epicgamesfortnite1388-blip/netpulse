# Per-user VPN credentials — live proof and revocation evidence

**Date:** 2026-10-25
**Mission:** `NETPULSE_OVERDRIVE_PARALLEL`
**Component:** `cloud/worker` (`vpn_credentials`, `/api/v1/provision`,
`/api/v1/internal/vpn-users`), host reconciler
`/opt/netpulse-sync/reconcile.py`, live node `206.1.96.89`.
**Deployed Worker:** `ce129ba7-2dd2-43ee-bfae-8fc7c0b83846` (100% traffic).
**Verdict:** **PASS** for issue + data path + expiry revocation on all five
provisioned protocols. One migration caveat remains (§6).

## 1. What changed before this test

Migration `0005` adds `vpn_credentials` (one secret per user+protocol).
`POST /api/v1/provision` mints a credential, stores it, and builds the client
config from it; `GET /api/v1/internal/vpn-users` (bearer `VPS_SYNC_SECRET`,
constant-time compare) returns only identities backed by an active, unexpired
entitlement on a non-disabled account. The host reconciler rewrites the Xray
`clients` arrays and the Hysteria `userpass` map to exactly that set every 60 s
and restarts a unit only when its file changed.

Before this, every client used one shared UUID/password, so an issued config
survived expiry forever. That hole is now closed for every protocol the plan
serves.

## 2. Method

Disposable account (`np-matrix-…@example.com`, deleted afterwards), one
entitlement row inserted directly in D1 (plan `pro`, `expires_at` two hours
ahead), then `POST /api/v1/provision` with the account's own access token.

The audit workstation runs a third-party TUN (`happ-xray`) that owns
`0.0.0.0/0` and terminates direct TLS to `206.1.96.89:443`
(`REALITY: received real certificate`), so the client→server leg was carried
over an SSH local forward to the node's loopback
(`ssh -L …:127.0.0.1:<port>`). Everything after that hop is the real server:
the real inbounds, the real per-user credentials, the real egress.

Real clients used: `xray` 26.10.21 (VLESS/REALITY, VMess-WS, VLESS-WS-TLS,
Trojan-TLS) and `sing-box` 1.12.14 (Hysteria 2). Egress was read from
`https://api.ipify.org` and `https://www.cloudflare.com/cdn-cgi/trace` through
each client's local SOCKS inbound.

## 3. Results — identity, data path, egress

Reconciler state after provisioning (pulled by the host from the deployed
Worker, `source: "cloud"`):

```
users=5 byProtocol: hysteria2 1, xray-trojan-tls 1, xray-vless-reality 1,
                    xray-vless-ws-tls 1, xray-vmess-ws 1
xray clients: vless-reality 1, vmess-ws 1, vless-ws-tls 1, trojan-tls 1
```

| Protocol | Handshake | Observed egress through tunnel | Result |
|---|---|---|---|
| `xray-vless-reality` (:443/tcp) | REALITY | `206.1.96.89` | PASS |
| `xray-vmess-ws` (:8443/tcp) | WS | `206.1.96.89` | PASS |
| `xray-vless-ws-tls` (:2053/tcp) | WS+TLS | `206.1.96.89` | PASS |
| `xray-trojan-tls` (:2087/tcp) | TLS | `206.1.96.89` | PASS |
| `hysteria2` (:8443/udp) | QUIC + salamander | `206.1.96.89` | PASS |

The REALITY run also resolved IPv6 through the node
(`ip=2a01:f900:11:32e::1`, `loc=TR`), i.e. the tunnel carried both families.

Per-user isolation check: the provisioned UUID differs from
`env.VPN_REALITY_UUID`, and two accounts receive different credentials (covered
by `cloud/worker/test/provision.test.ts`, 110 worker tests pass).

## 4. Results — expiry actually closes the tunnel

With the account still active, `expires_at` was moved to
`2020-01-01 00:00:00`:

| Step | Observed |
|---|---|
| `POST /api/v1/provision` | `403 {"error":{"code":"entitlement_expired",…}}` |
| next reconciler pass (≤60 s) | `users=0`; all four Xray `clients` arrays `0`; Hysteria auth reverted to an unknown password |
| new client start with the old per-user credential | `curl … --socks5` exit **35** (TLS/connection refused), no egress |

So expiry removes the identity from the server, not just from new issuance, and
the already-issued config stops authenticating.

## 5. Cleanup (verified)

All disposable rows removed: test users `0`, leftover `0`,
`vpn_credentials` `0`, entitlements back to the pre-test `1`. Server back to
deny-all (`users=0`, four inbounds with 0 clients). Test client processes and
the SSH forward were stopped. No test credential or account remains.

## 6. Remaining risk — existing profiles are stale until re-provisioned

The live D1 currently holds `22` users, `26` non-deleted profiles and one
active entitlement, with `vpn_credentials = 0`. Those 26 configs were issued
under the old shared credential; the server now authenticates nobody, so they
are dead. The Account page auto-calls `provision()` when opened and labels an
expired subscription (`apps/web/src/features/account/AccountPage.tsx:443`), but:

- the returned configs are shown for copy/import only — the app does not import
  them into the local VPN profile list automatically (`syncEngine` pulls cloud
  profile *metadata*, not configs);
- a user who connects without opening Account first keeps using a stale local
  profile and will see a failed tunnel.

This is a deploy migration cost, not a bug in the revocation model. It must be
handled explicitly: either auto-import refreshed configs into the local store,
or notify affected subscribers that one re-download is required. Recorded as
the next product item in `reports/mission/MISSION_JOURNAL.md`.

## 7. Limitations of this evidence

- No vantage inside Iran was used. This proves server-side auth, tunnel data
  path, egress and revocation; it does **not** prove reachability on any
  Iranian ISP.
- The client→server leg was SSH-forwarded because the workstation's own TUN
  intercepts direct TLS to the node. A direct-path client test from a clean
  vantage is still pending.
- Hysteria 2 was tested with `sing-box`, not the vendor client.
- Operator note: `wrangler d1 execute --command` silently runs only the first
  statement of a multi-statement string (observed: a batch reported `changes: 5`
  from the first `DELETE` while later deletes did not run). Run one statement
  per invocation.
