# Bulk node-test benchmark — findings

**Date:** 2026-10-26
**Tool:** `npx tsx scripts/bench-bulk-probe.ts` (`npm run bench:bulk-probe`)
**Core:** xray `26.3.27` (installed) and xray `26.10.21` (fresh install, for the
download leg)
**Node source:** the installed app's own database + encrypted vault
(52,573 nodes) and a share-link file built from it

The benchmark times the two production paths — `proxyProbeWithEngine` (one core
spawned, readied, probed and torn down per node: what the pre-batching bulk
runner did for every node) against `proxyProbeManyWithEngine` (several nodes in
one core).

## What it measured

| Run | Nodes | per-node ×8 | batched | Spawns per-node vs batched |
|---|---|---|---|---|
| app DB sample | 12 | 13,412 ms | 12,107 ms | 12 vs 2 |
| share-link file (recently reached nodes) | 12 | 13,408 ms | 12,213 ms | 12 vs 2 |
| app DB sample (4) | 4 | 12,097 ms | 12,097 ms | 4 vs 2 |

**No sampled node carried traffic at the time of measurement** — every probe
ended in `probe timed out`, `read ECONNRESET`, or a TLS disconnect, on both
paths. Both columns are therefore dominated by the 12 s probe timeout, and the
wall-time advantage of the batched path is **not** demonstrated by these
numbers; the benchmark prints that caveat itself. What the numbers do show is
the spawn count: 12 core spawns + teardowns versus 2.

The mechanism the batched path exists to exploit is real and separately
measured (`scripts/bench-engine-start.ts`): a core spawn + readiness costs
~300 ms, which is charged once per group instead of once per node.

## Defect 1 — one node's config aborted a whole batch (CONFIRMED, fixed)

Measured, not inferred: a group of 8 real nodes whose configs the shared core
rejected **all 8** at startup (`xray (batch of 8) exited during startup (code
23)`), even though 7 of them started fine on their own. Reproduced by growing a
batch one node at a time — the 8th node is the one that poisons it, and that
node fails alone too:

```
-- each node on its own --
  STARTED  vless 27.50.48.8:443
  STARTED  vmess 185.143.233.213:80
  STARTED  trojan 77.239.98.141:8443
  STARTED  shadowsocks 77.83.246.74:443
  STARTED  vless 138.128.224.100:80
  STARTED  vmess 185.143.233.114:80
  STARTED  trojan 198.12.144.253:443
  DIED(23) vless 104.17.72.206:443          <-- the poison node
  STARTED  vmess 188.114.98.0:8080
  ...
-- the batch, growing one node at a time --
  STARTED  first 7: vless,vmess,trojan,shadowsocks,vless,vmess,trojan
  DIED(23) first 8: ... + the node above
```

With 5.4% of the stored nodes (2,856 of 52,573) holding no credential at all —
and a shared core refusing to start on a credential-less config — roughly a third
of 8-node groups were exposed to this.

**Fixed** in two layers:

- `proxyEngineRunner.ts` — a node with no credential is never placed in a shared
  core (its config cannot start one, so it would take its siblings with it); it
  takes the single-node path, where the failure stays its own.
- `proxyCores.ts` — `engineSupportsConfig` now refuses the v2ray family for a TLS
  node that sets `allowInsecure` (defect 2), so such a node is never handed to a
  core that cannot load it.

After the fix, the same 12-node list produced **per-node outcomes for all 12**
(`probe timed out` / `read ECONNRESET` / TLS disconnect) instead of 7 of them
inheriting one sibling's startup failure.

Tests: `apps/api/test/bulkProbeRunner.test.ts`,
`apps/api/test/proxyCores.test.ts` (75 tests across the three affected files,
plus the full `@netpulse/api` suite: 97 files / 1057 tests green).

## Defect 2 — `allowInsecure` is gone from xray (CONFIRMED, worked around)

The config builder emitted `tlsSettings.allowInsecure` for every TLS node. xray
26.3.27 refuses the **entire config file** when it is `true`:

```
Failed to start: main: failed to load config files: [...] > infra/conf: failed
to build outbound config with tag np-node > infra/conf: failed to build stream
settings for outbound detour > infra/conf: Failed to build TLS config. >
common/errors: The feature "allowInsecure" has been removed and migrated to
"pinnedPeerCertSha256". Please update your config(s) according to release note
and documentation.
```

1 node in 12 sampled real nodes hit this, and it was the node that poisoned its
batch. The same node's config **starts on sing-box** (`tls.insecure: true` is
still accepted there — verified by running it), so the node is now routed to
sing-box, and a machine without sing-box gets a specific reason instead of a bare
exit code.

**Not fixed, and worth deciding:** `allowInsecure: true` cannot be honoured by
the v2ray family any more. Pinning the peer certificate
(`pinnedPeerCertSha256`) is the supported replacement and would need the app to
fetch and hash the node's leaf certificate; until then such nodes depend on
sing-box being installed.

## Unresolved observation

A freshly installed xray `26.10.21` (what `installEngine` fetches today,
checksum verified, 5.2 s) rejected at startup the same vless config that the
installed `26.3.27` loaded, on two synthetic links. It is **not** the probe
inbound: both versions accept `http` and `socks` inbounds. Two synthetic links
are not a faithful node sample, so this is recorded as an open question, not a
defect claim. Worth re-testing against real nodes with a fresh core, because a
default engine install that rejects the app's own configs would break proxy
testing and the local proxy tunnel outright.

## Verification performed

- `npm run test -w @netpulse/api` → 97 files, 1057 tests pass.
- Benchmark run against the real 52,573-node database (isolated xray + real
  vault) and against a share-link file.
- Download leg: empty cores dir + scratch data dir → real release fetched,
  `checksum verified: true`, installed, used (`Xray 26.10.21`).
- A real xray server was started locally to sanity-check the probe inbound, then
  stopped; nothing was left running and no temporary files remain.
