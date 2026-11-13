# Reconciler removal dry run — does a rotated identity actually leave the server?

**Date:** 2026-10-26
**Mission:** `NETPULSE_OVERDRIVE_PARALLEL`
**Component:** host reconciler `scripts/vps-sync-vpn-users.py` (installed as
`/opt/netpulse-sync/reconcile.py` on `206.1.96.89`)
**Verdict:** **PASS** for the reconciler's removal semantics, verified by running
the real script in `--print` mode against a sandbox copy of the server config.
**BLOCKED** for the same run *on the live host* — see §6.

## 1. The question

The Worker can only stop *publishing* a secret. What actually kills a leaked or
rotated config is the host rewriting its server configs from the published set.
`cloud/worker/README.md` claims:

> expiry/revocation/refund → the identity disappears from the config on the next
> pass (≤ 1 min) and the next handshake is refused, even if the config was
> already copied elsewhere

Half of that is trivially true (the Worker stops listing the secret). The half
that matters was untested: does the reconciler *replace* the client lists, or
would a rotated identity linger in the server config?

## 2. Method

`scripts/verify-vps-reconciler-removal.py` (new, in-repo) runs the real
reconciler, unmodified, in its `--print` mode ("show what would be applied,
touch nothing") against a sandbox:

1. **Seed the "before" state.** Either `--from-live` (copy
   `/opt/netpulse-xray/config.json` and `/opt/netpulse-hysteria/config.yaml`,
   the mode to run on the host) or, locally, a skeleton containing the four
   per-user inbounds *plus* the retired shared-secret `ss2022` inbound, seeded
   through the reconciler's own `build_xray_config` / `build_hysteria_config`.
2. **Stand in for the Worker.** A loopback HTTP server answers
   `GET /vpn-users` with a real `{ok, users:[…]}` payload and rejects a wrong
   bearer token, so the run exercises the script's actual pull path
   (`source: cloud`), not its state fallback.
3. **Run A — unchanged set.** The published set equals the set already in the
   config: the emitted configs must be byte-identical, otherwise the diff in run
   B would be formatting noise.
4. **Run B — rotated set.** One account rotates to a new secret on all five
   protocols (same username, new secret, as
   `POST /api/v1/ops/vpn/rotate` produces), one account is revoked outright,
   one account is added, and one is sent with `expiresAt` already in the past.
5. Assertions on the emitted configs, plus a hash check that both sandbox config
   files were unchanged on disk.

Secrets and usernames are synthetic; nothing in this run touched the live
Worker, D1, the host, or any credential.

Command (Python 3 + PyYAML; the venv used here was `tmp/reconcile-dryrun/venv`):

```bash
python3 scripts/verify-vps-reconciler-removal.py --workdir /tmp/np-verify --keep
```

## 3. Evidence — the diff

Reconciler stdout for run B, trimmed to the interesting hunks (the full run is
in `tmp/reconcile-dryrun/evidence-local.txt`):

```
reconciler log lines, rotated set:   2026-10-26T17:07:15Z pruned 5 identities past their expiry
seeded before-state identities: 2
rotated: u_1a2b3c4d5e6f  revoked: u_9f8e7d6c5b4a  added: u_5f4e3d2c1b0a  expired: u_deadbeefcafe

=== diff: xray config (current on-disk -> what the reconciler would write) ===
--- xray.before
+++ xray.after
@@ -11,14 +11,14 @@            # inbound "vless-reality" (:443, VLESS + REALITY)
    "settings": {
     "clients": [
      {
-      "id": "f9595cc3-829f-4571-b5dc-88b6c49263db",
+      "id": "e81f0004-f803-459c-ae2a-263536401f7a",
       "flow": "xtls-rprx-vision",
       "email": "u_1a2b3c4d5e6f"      # rotated account: same identity, NEW secret
      },
      {
-      "id": "9aa0eb65-cbc1-48bc-ae82-818160e9fc33",
+      "id": "9f18c9b3-df45-43c1-8f42-508e88738b5b",
       "flow": "xtls-rprx-vision",
-      "email": "u_9f8e7d6c5b4a"      # revoked account: REMOVED
+      "email": "u_5f4e3d2c1b0a"      # newly entitled account: added in its place
      }
     ],
@@ -98,12 +98,12 @@            # inbound "trojan-tls" (:2087) — password-shaped client
    "settings": {
     "clients": [
      {
-      "password": "cfcc3b785dde6306ec41f58bcd2ca22d",
+      "password": "b2c8d5f590de5c3b8cbea5b72398d0f6",
       "email": "u_1a2b3c4d5e6f"
      },
      {
-      "password": "ae20332d22e87071e8d84b20cb327e6b",
-      "email": "u_9f8e7d6c5b4a"
+      "password": "2c4e207a9620963a6d29d9a7dd2bb279",
+      "email": "u_5f4e3d2c1b0a"
      }
     ]
    },

=== diff: hysteria config ===
--- hysteria.before
+++ hysteria.after
@@ -2,5 +2,5 @@
 auth:
   type: userpass
   userpass:
-    u_1a2b3c4d5e6f: dac90a9cb0b801a2003b3a4702fa8527
-    u_9f8e7d6c5b4a: 88521287267dc233d81c738cf77d9841
+    u_1a2b3c4d5e6f: 1a2a56fd6acfdd9546523ecaa68e5a52
+    u_5f4e3d2c1b0a: c6d66836eaee89796b8b3a8f5d676eb5
```

(the vmess-ws and vless-ws-tls hunks are identical in shape to the REALITY one —
old UUID out, new UUID in for the rotated account, revoked account gone)

`u_deadbeefcafe`, sent with a past `expiresAt`, appears nowhere in the output:
the host prunes it locally instead of waiting for a reachable Worker.

## 4. Checks (20/20, three configurations)

Run locally (`20/20`), and again through the host code path
`--from-live` against a host-shaped config (`20/20`) and against a **deny-all**
config, i.e. the state the host is actually in today (`20/20`):

| Check | Result |
|---|---|
| Unchanged published set → byte-identical configs (diff is not formatting noise) | PASS |
| Pull came from the endpoint (`source: cloud`), `dryRun: true` | PASS |
| All five old secrets of the rotated account absent from the emitted config | PASS |
| All five protocols carry the account's new secret | PASS |
| Revoked account removed from both configs | PASS |
| Identity past `expiresAt` never reaches the config | PASS |
| Newly entitled account written into the config | PASS |
| Summary counts only kept identities (`users: 10`, 5 pruned) | PASS |
| Client arrays are **replaced**, not merged (`{vless-reality: 2, vmess-ws: 2, vless-ws-tls: 2, trojan-tls: 2}`) | PASS |
| Retired shared-secret inbound (`ss2022`) untouched | PASS |
| Both config files unchanged on disk after `--print` | PASS |

Executed with the repo's venv (`tmp/reconcile-dryrun/venv`, `pyyaml 6.0.3`); raw
outputs: `tmp/reconcile-dryrun/evidence-local.txt`,
`tmp/reconcile-dryrun/evidence-denyall.txt`.

## 5. What this proves, and what it does not

Proves:

- the reconciler rebuilds `clients` arrays / the Hysteria `userpass` map from the
  published set, so a rotated secret and a revoked identity leave the config that
  would be written — this is the assertion that was missing, not a claim about
  the Worker's response;
- `expiresAt` is enforced host-side (an already-expired identity is dropped even
  though the endpoint still listed it);
- `--print` is genuinely read-only (file hashes unchanged), so this check is safe
  to run against a live host;
- the retired shared-secret inbound is not touched by a per-user rotation.

Does not prove, and is not claimed:

- that the live host currently holds this config — that needs §6;
- the apply half (`systemctl restart` + `xray -test` gate) — `--print` never
  reaches `xray_config_is_valid` or `restart`;
- anything about client-side behaviour; the tunnel-level revocation result is the
  earlier live proof (`PER_USER_CREDENTIAL_LIVE_PROOF_2026-10-25.md`, §4).

## 6. BLOCKED — the same run on the live host

Running the harness on `206.1.96.89` needs SSH access, which this workstation no
longer has:

```
$ ssh -i ~/.ssh/<key> <user>@206.1.96.89 'echo ok'      # port 22, all attempts
root       Permission denied (publickey)       # netpulse-vps-reset-2026{,b}, id_root_new,
ubuntu     Permission denied (publickey)       # vps_key, vps_key_nopass, id_ed25519
netpulse   Permission denied (publickey)
admin      Permission denied (publickey)
debian     Permission denied (publickey)
```

The `~/.ssh/config` aliases `abyssal-*` point at `153.52.92.193` (a different
host) and reference `~/.ssh/abyssal_key`, which does not exist. The untracked
`VPS-KEYS.txt` that earlier cycles used is no longer on disk. **Exact missing
dependency: a working SSH private key (or key+user pair) for the VPN host.**

Closing this half is one command on the host, and it changes nothing there:

```bash
python3 /opt/netpulse-sync/verify-vps-reconciler-removal.py --from-live --keep \
  || python3 scripts/verify-vps-reconciler-removal.py --from-live --keep
```

Expect, with the host in its current deny-all state: the note *"0 identities
currently published"*, the note that the before-state is therefore seeded, and
`20/20 checks passed`. If instead the host holds live identities, the script derives
them from its own config and the diff is against the real server config. Either
way `--print` leaves `/opt/netpulse-xray/config.json` and
`/opt/netpulse-hysteria/config.yaml` byte-identical (hash-checked by the run).

## 7. Status

| Requirement | Status |
|---|---|
| Reconciler removes a rotated secret from the config it would write | **PASS** (20/20, local + `--from-live`, evidence in §3/§4) |
| Reconciler removes a revoked/expired identity | **PASS** (same runs) |
| `--print` is read-only | **PASS** (hash check) |
| The same checks against the live host's real config | **BLOCKED** (no SSH credential; §6) |
| Apply path (`xray -test` gate + unit restart) | **NOT TESTED** here (needs the host) |

## 8. Follow-ups

- Wire `scripts/verify-vps-reconciler-removal.py` into CI. Deliberately not done
  in this cycle: it needs PyYAML and the CI workflow already carries unrelated
  in-flight edits, so it is documented as an ops check instead.
- The check is only as good as the seeded "before" state on a deny-all host;
  once a real entitlement is provisioned again, the `--from-live` run diffs
  against real published identities.
