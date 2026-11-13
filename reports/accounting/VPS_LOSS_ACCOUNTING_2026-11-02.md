# VPS loss — final accounting

**Date:** 2026-11-02 · **Event:** the single provider host (`206.1.96.89`) is no longer
available. This closes the accounting that the previous cycles left open by assuming the
host would come back.

This is deliberately not a post-mortem of *why* it went away. It is the ledger: what the
host carried, what is now permanently unverifiable, what still works, and what the
product can and cannot deliver.

---

## 1. What the host carried

Reconstructed from `reports/accounting/PER_USER_CREDENTIAL_LIVE_PROOF_2026-10-25.md`,
`reports/infra/INFRA_VERIFICATION_2026-10-24.md`, `reports/mission/MISSION_JOURNAL.md`
and `docs/research/dpi/whitedns-design.md`:

| Asset | Where it lived | Live evidence on record |
| --- | --- | --- |
| VLESS Reality inbound `:443` | xray on the host | 2,453 ms, proven 2026-10-25 |
| VMess WS `:8443` | xray | 779 ms |
| VLESS WS+TLS `:2053` | xray | 858 ms |
| Trojan TLS `:2087` | xray | 1,092 ms |
| Hysteria2 inbound | hysteria | live |
| Per-user credential issuance | `np_entitlements` → host config | 5 protocols live-proven |
| Revocation / expiry | `/opt/netpulse-sync/reconcile.py`, 60 s timer | removal propagated in 3.7 s |
| WhiteDNS Soar panel + zone delegation | panel + authoritative DNS on `:53` | panel bundle verified; tunnel data plane never proven |
| dnstt service | host | distinct from WhiteDNS |

## 2. Status of every accounting item, after the loss

| # | Item | Verdict | Why |
| --- | --- | --- | --- |
| A1 | Entitlement **mirror** (signed event inbox → `np_entitlements`) | **PASS (code + tests)** | `cloud/worker` suite green; D1 live state **NOT TESTED** from here |
| A2 | Provision → **config issuance** | **BLOCKED** | configs were generated for that host. There is no host to issue against, so a "successful" provision would hand out a dead endpoint |
| A3 | Revocation / expiry reconciliation | **BLOCKED** | the reconciler ran on the host. Off-host dry-run still passes (`VPS_RECONCILER_REMOVAL_DRYRUN_2026-10-26.md`), but nothing is being revoked now |
| A4 | Per-user credential live proof (DPI-15) | **HISTORICAL PASS, non-reproducible** | the 2026-10-25 run can never be repeated against this host. It stays valid as a record of what the code did, not as current evidence |
| A5 | Payment / Stars checkout | **BLOCKED** | externally owned; unchanged by the host loss |
| A6 | WhiteDNS issuance | **BLOCKED — now permanent** | the tunnel server and its zone delegation were *on this host*. This is no longer "waiting on a per-user identity"; the server is gone |
| A7 | Free-source config delivery | **PASS (measured today)** | 9/9 enabled sources, 34,150 parseable configs — `FREE_CONFIG_INVENTORY_2026-11-02.md` |
| A8 | Aether (no-server engine) | **PASS (channel) / NOT TESTED (connect)** | release `v2.4.0` (2026-10-24) publishes `aether-windows-x86_64.zip` + `.sha256`, exactly the asset `engineManager` expects. No binary is installed on this machine, so no connect was attempted |
| A9 | Mission Control ledger reflects reality | **PASS** | host row is `unavailable` ("provider host retired"), WhiteDNS notes the stale delegation, 1113/1113 API tests |

## 3. The product consequence (the part that matters commercially)

The subscription half of NetPulse has **no delivery path** right now. A paid plan issues
credentials — but the only server those credentials pointed at is gone, so provisioning
would produce configs that cannot connect. Until a replacement host exists, the honest
position is:

- **Free-source catalog** — works today (34k configs), no server required.
- **Aether** — works with no server at all; it discovers its own route. This is the only
  tunnel path that survives the loss *by design*.
- **Paid subscriptions** — cannot deliver. Not "degraded": undeliverable.
- **WhiteDNS** — gone with its host, not merely withheld.

## 4. What remains reproducible off-host

These do not need the VPS and still pass:

- the full API suite — **1113/1113** (103 files), web **461/461** (51 files);
- `scripts/verify-vps-reconciler-removal.py` in `--print` mode (revocation logic without a host);
- `scripts/free-config-probe.ts` (this cycle's addition);
- the Aether install channel, verified against the live release index.

## 5. Re-plan, in order

1. **Make Aether the default path** and prove it end to end on Windows: install from the
   verified asset, connect, confirm the SOCKS5 exit IP. This is the only route to
   connectivity that needs no server, so it must not depend on one.
2. **Decide the hosting question explicitly** — replace the host, or formally drop paid
   per-user configs and sell the free-source + Aether experience instead. Both are
   defensible; pretending the paid path still works is not.
3. **WhiteDNS**: resurrect only with a new server *and* per-user zones; otherwise mark the
   feature withdrawn. Do not leave a panel path or a zone claim in the docs as if live.
4. **Keep the free catalog honest**: run `npm run probe:sources` before trusting any count;
   two of eleven built-ins were already dead when this was written.

## 6. What this accounting does not claim

- No cost figure is asserted here: the repository holds no billing records, and inventing
  one would be worse than leaving it out.
- The historical latency numbers in §1 are **not** re-verified. They describe a host that
  no longer exists.
- Nothing was deleted, migrated, or rotated as part of this close-out.
