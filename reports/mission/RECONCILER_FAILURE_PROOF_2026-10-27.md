# Host reconciler — temporary-failure and recovery proof

**Date:** 2026-10-27 · **Component:** `scripts/vps-sync-vpn-users.py`, installed
as `/opt/netpulse-sync/reconcile.py` on `206.1.96.89`, driven by
`netpulse-sync-vpn.timer` (60 s) · **Harness:**
[verify-vps-reconciler-failure.py](../../scripts/verify-vps-reconciler-failure.py)
(same shape as the removal verifier)
**Verdict:** **PASS** — 40/40 locally and **47/47 on the live host**, with a real
defect found and fixed on the way (§4).

Raw transcripts: [local](evidence/reconciler-failure-local-2026-10-27.txt) ·
[host](evidence/reconciler-failure-host-2026-10-27.txt).

## 1. The question

The reconciler documents an asymmetric failure policy — a failed pull keeps the
last known-good identity set, a malformed payload is a hard error, an empty but
well-formed set is applied, and `expiresAt` is enforced on every pass. Until now
that was code plus prose. Acceptance step 18 asks whether reconciliation
*restores the correct state after a simulated temporary provisioning failure*,
so the policy needs to be falsifiable: what exactly happens to the server config
and to the cache when the Worker returns 500, disappears, or answers garbage —
and what happens on the pass after that?

## 2. Method

The real reconciler, unmodified apart from the §4 fix, run in a sandbox with
`NETPULSE_*` paths redirected: a loopback stand-in for
`GET /api/v1/internal/vpn-users` that answers **200 / 500 / garbage / nothing**
on command, plus a seeded "before" state. Two modes:

- `--print` everywhere (read-only), which is what the host decides from;
- `--apply` on the host only, where the real `xray` binary can validate the
  generated config and the real `systemctl` exists. In apply runs the unit names
  are overridden to `np-proof-noop-*`, so no live service is bounced; the checks
  are about what is written and what is cached.

Safety: the host run seeds the sandbox from the **real** configs and passes
`--live-guard /opt/netpulse-xray/config.json /opt/netpulse-hysteria/config.yaml`;
the harness hashes them before and after and fails if either changed. The
`--print` passes are hash-checked too.

## 3. What the 47 host checks establish

| Scenario | Established |
| --- | --- |
| Healthy pull | `source: cloud`; an identical set rewrites nothing (byte-identical config) |
| HTTP 500, cache present | `source: state`; config **byte-identical** to the last known-good one (no wipe, no self-inflicted outage); the failure is logged, not swallowed |
| Endpoint gone (connection refused) | `source: state`; config unchanged — no fail-open, no fail-wipe |
| Malformed payload (unknown protocol, illegal secret) | treated as a failed pull; the rejection says why; **the malformed identity never reaches the config** |
| Expiry during an outage | an identity whose `expiresAt` passed is pruned **locally** on the next pass: access ends on time without the Worker; the still-valid identities are untouched |
| Recovery | `source: cloud` again; the rotated identity carries its new secrets on all five protocols; the rotated-away secret, the revoked identity and the expired one are gone; the newly entitled identity is written |
| Post-recovery outage | the cache now holds the fresh set, so the **revoked identity is not resurrected** and the new secrets stay in place |
| Validation gate (apply) | an unusable `xray` binary → exit 2, `xray config invalid; nothing applied`, **neither config nor cache written** |
| Real apply (host) | the new set is written to disk, the file no longer authenticates the revoked identity and does authenticate the added one, the cache advances to the fresh set |
| No cache + no endpoint | exit 1, no config emitted, the existing config untouched, `last-run.json` says `no state, pull failed`, and **no empty set is cached** (so a later outage still cannot wipe anyone) |
| Live guard | both live configs byte-identical after the whole run |

The generated config in the host apply run was accepted by the real
`xray -test`, so the file this proof wrote is a file xray itself considers valid.

## 4. Defect found by this proof, and fixed

In apply mode the last-known-good cache was written **before** the xray
validation gate:

```
summary = {...}
if fresh is not None and not dry_run:
    write_atomic(STATE_FILE, ...)      # <-- before validation
...
if not xray_config_is_valid(xray_text):
    return 2                            # config rejected, cache already advanced
```

Consequence: a config the host refused to apply still became the state it would
fall back to during a Worker outage — a set the server had never received. The
harness failed the claim `apply: the refusal wrote neither config nor state
cache (fail-closed)` on the first run; the cache write now happens only after
validation passes, immediately before the files are rewritten.

Deployed to the host: `/opt/netpulse-sync/reconcile.py`, md5
`1a444ffbadea7cea62a55d29598f48b5` (identical to the source), backup
`/opt/netpulse-sync/reconcile.py.bak-2026-10-27`.
First production pass after the deploy: `applied source=cloud users=5 pruned=0
xray=same hysteria=same`, `ExecMainStatus=0`, `Result=success`.
Rollback: `install -m 700 /opt/netpulse-sync/reconcile.py.bak-2026-10-27 /opt/netpulse-sync/reconcile.py`.

## 5. Limits (read before quoting)

- `--print` never writes the state cache, so the harness seeds it the way an
  applied pass leaves it; that seeding is stated in the run's notes.
- The unit-restart half (`systemctl restart` + `is-active`) is **NOT TESTED** on
  live units — the proof targets nonexistent units on purpose. The apply checks
  cover the file writes, the cache, and the validation gate.
- The temporary failure was simulated at the endpoint (500 / refused / garbage).
  A failure of the *host's own network* mid-write (disk full, power loss) is not
  simulated; the atomic-write + backup path is the same one the removal proof
  covers.
- One run each per scenario, on one host; the identity sets are synthetic
  (`u_…` names, generated secrets). No live identity was touched.
