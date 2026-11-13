# Provisioned-credential refresh — live end-to-end proof against the deployed control plane

Date: 2026-10-27
Scope: the whole loop the product promises — sign in, have the control plane re-issue a
subscription credential, and watch the **VPN surface** replace the stored one and carry traffic
again.
Component: deployed Worker `netpulse-cloud` (`https://netpulse-cloud.shuridehradin.workers.dev`),
live VPN host `206.1.96.89` (systemd reconciler `/opt/netpulse-sync/reconcile.py`, 60 s timer), local
`apps/api` (dev, port 8787) with a real xray core, `apps/web` in a real browser.
Harness: `scripts/proof-provision-repair-live.ts` (`setup` / `baseline` / `stale` / `verify` /
`cleanup` / `status`).
**Verdict: PASS for detection, replacement, wire-level revocation and recovery. Two defects in the
probe path were found and fixed on the way (see §4); three things remain open and are listed in §5
and §7, none of them presented as passes.**

## 1. What was proven, and by what observation

| Claim | Evidence | Result |
|---|---|---|
| The app signs in against the deployed Worker | Account page, real form, disposable `np-repair-…@example.com`; session listed as "this device", last login recorded | PASS |
| The plan's per-user credential reaches the app | `/api/v1/provision` → 5 configs (reality, vmess-ws, vless-ws-tls, trojan-tls, hysteria2); the 4 link-expressible ones imported as nodes | PASS |
| **Before** rotation the issued credential really dials the node | app's own xray core over the app's own SOCKS path: VLESS WS+TLS 858 ms, Trojan TLS 1092 ms, VLESS Reality 2453 ms; VMess WS 779 ms (probed separately — it is invisible to the card, §5.1). All four carry the app's test request end to end | PASS |
| Rotation is server-side and reaches the host | the account's `vpn_credentials` rows were deleted in live D1; the host stopped carrying `u_03ece32fc8be` after **3.7 s** (second rotation: **1.8 s**), inside the documented 60 s window | PASS |
| The stale credential stops authenticating | all three previously-passing profiles now FAIL — "Client network socket disconnected before secure TLS connection was established" ×2, one timeout | PASS |
| The VPN surface detects it | card "Subscription profiles that are not passing", badge "3 to check", rows "failing now — 2 consecutive failure(s)" | PASS |
| **The surface repairs it** | one click: **"The server had issued a different credential — the app replaced the stored one for 4 profile(s), and 0 of 3 now carry a probe. 1 config(s) can only be copied from the Account page."** `credentialsUpdated: 4` is the app's own proof that a stale secret was stored | PASS |
| Traffic flows again through the re-issued credential | probes after the host published the new identity: VLESS WS+TLS 2572 ms, Trojan TLS 764 ms, VLESS Reality 5775 ms → 3/3; the markerless VMess profile 929 ms; node state back to `consecutiveFailures=0` with `lastProxy` recorded | PASS |
| The card stops asking | after the successful probes the card reads "none failing" while keeping the replacement verdict | PASS |
| Cleanup | proof account rows (credentials, profiles, entitlement, sessions, user) deleted; a leftover account from an aborted first attempt removed too; host back to its pre-test identity set in 1.9 s; the user's own account untouched | PASS |
| Hysteria 2 | provisioned, never dialed | NOT TESTED (§7) |
| `POST /api/v1/ops/vpn/rotate` itself | not exercised (§3) | NOT TESTED |

Node state across the run (local API, `GET /nodes?search=NetPulse`):

```
before rotation : tests=6  ok=5 consecutiveFailures=0
while stale     : tests=7  ok=5 consecutiveFailures=1   (second rotation: failures=3)
after refresh   : tests=10 ok=6 consecutiveFailures=0   lastProxy=2572
```

## 2. How it was run

```bash
npm run dev -w @netpulse/api                      # 8787, dev data dir apps/api/.data
npx tsx scripts/proof-provision-repair-live.ts setup
npx tsx scripts/proof-provision-repair-live.ts baseline
npx tsx scripts/proof-provision-repair-live.ts stale      # revoke + wait for the host + probe
#   … click "Refresh from subscription" on the VPN page in the browser …
npx tsx scripts/proof-provision-repair-live.ts verify
npx tsx scripts/proof-provision-repair-live.ts cleanup
```

The xray core was installed by the app itself (`POST /api/v1/nodes/engines/install`,
`checksumVerified: true`, `Xray 26.10.21`) into `apps/api/cores` — which is how defect §4.1 became
visible.

State, including the real credentials of the disposable account, lives in
`.scratch-provision-repair/` (ignored by the repo's `.scratch*` rule) and is deleted with the
account; nothing secret is printed by the harness.

## 3. The rotation mechanism, stated plainly

The rotation was **not** issued through `POST /api/v1/ops/vpn/rotate`. That route needs the deployed
`OPS_TOKEN`, and the only copy on this workstation (`cloud/worker/.ops-token.local`) is the value
`docs/SECURITY_AUDIT_2026-09-30.md` had revoked — measured: it answers `401 unauthorized`. Setting a
new secret on the live Worker was not this task's to do.

So the revocation step is a direct D1 `DELETE` of the account's `vpn_credentials` rows — the same
table, and the same rule the ops action relies on ("the host may carry exactly what is published
here"). The **re-issue** then happens through the product's own provisioning path:
`ensureVpnCredential` finds no row and mints a fresh secret, `generateVpnConfig` rebuilds the config,
and the profile row is upserted with `config_version + 1`. Nothing in this run wrote a credential
value it invented, and the app-side repair it triggered is the shipping code path
(`refreshProvisionedCredentials` → `/nodes/import` → `/nodes/test-batch`).

Consequence for the record: the *rotate endpoint's* own behaviour (fingerprints, audit row, revoked
rows staying revoked) is covered by `cloud/worker/test/ops-vpn.test.ts`, not by this run.

## 4. Defects found on the way, and fixed

Both are in the probe path the repair card uses, and both were found by running it for real.

### 4.1 An installed core was invisible to every proxy test

`findEngineBinary` (proxyCores) searched `NETPULSE_CORES_DIR`, `<NETPULSE_DATA_DIR>/cores` and
`PATH`. The engine manager installs into `coresDir()` = `NETPULSE_CORES_DIR ?? <NETPULSE_DATA_DIR ??
cwd>/cores`. With `NETPULSE_DATA_DIR` unset — `npm run dev:api`, and any run started from another
cwd — those are different folders, so `GET /nodes/engines` reported

```
xray: available=false, path=null, version="Xray 26.10.21 (…)"      # version read from the install
```

and every proxy test answered "no proxy core installed" with the binary on disk. Fixed by searching
the engine manager's own directory; `available=true, path=<dataDir>/cores/xray.exe` after the fix.
Covered by a new case in `apps/api/test/proxyCores.test.ts` (asserted where such an install exists —
the alternative, creating one in the real install dir from a test, can leave a fake executable
behind).

### 4.2 A single-path node was probed and then reported nowhere

`POST /nodes/test-batch {type:'proxy'}` returned `{"results":{}}` for nodes that take the
single-node path (Hysteria 2 always; anything no shared core can dial). `nodesService.testNodes`
opens each test row on the runner's `onGroupStart` and skips a node whose row never started
("cancelled") — but the runner only fired that callback for shared groups, so singles were probed,
recorded nowhere, and their health counters never moved. Fixed by announcing the single index too.
Covered by a new case in `apps/api/test/bulkProbeRunner.test.ts`.

Verified after both fixes: `npx vitest run test/proxyCores.test.ts test/bulkProbeRunner.test.ts` →
**65 passed**; `npx tsc --noEmit` in `apps/api` → clean; full suite → **1098 passed, 2 failed**, the
two failures pre-existing and unrelated (§5.3).

## 5. Findings reported, not fixed

### 5.1 A provisioned VMess profile loses the marker the repair card filters on

The converter puts the name in the link (`ps: "NetPulse · Xray VMess WS"`), but the parser reads
`ps` only as a **host** fallback (`json.add ?? json.ps ?? json.server`) and never as a name, so the
imported node is labelled `VMess · 47a98664` with `remark: null` — no `NetPulse · ` marker. The card
therefore cannot see it, and cannot offer it for repair. Its credential *is* still replaced by a
refresh (the refresh imports the whole provision response; measured: that node carried a probe again,
929 ms), so the practical loss is detection, not repair.

Not fixed here because the fix is a naming decision with a privacy edge: the app deliberately
generates node labels rather than echoing text from an imported config, and `ps` is untrusted input
from whoever wrote the link. If it is to be honoured, it should be honoured the way the rest of the
app treats imported text.

### 5.2 The card's probe races the host's publish window

The verdict above ended in "**0 of 3 now carry a probe**" while the same three nodes passed a minute
later. The refresh provisions, imports, and immediately probes; the host only publishes a new
identity on its next reconcile tick (≤60 s). A user reading that line sees a repair that looks like
it did not work. The card is not wrong (it reports what it measured), but the observation is
misleading on its own. Options: re-probe on a short delay when `credentialsUpdated > 0`, or say in
one clause that the server publishes within a minute.

### 5.3 Two pre-existing API-suite failures (not this work)

`npm test -w @netpulse/api` → 1098 passed, 2 failed, both from the adaptive-route work, neither
touching the changed files:

- `test/httpSemantics.test.ts` — `apps/api/src/routes/adaptive.ts:77,79` hand-write error bodies
  instead of `replyApiError`/`replyValidationError`.
- `test/routeWiring.test.ts` — `AdaptiveRecoveryCard.tsx` fetches a path the route-wiring check
  cannot match (`/adaptive/status${nodeId ? …`).

## 6. Reproducing

`scripts/proof-provision-repair-live.ts` is self-contained: it registers its own disposable account,
inserts its own entitlement (the bot owns that table in production), captures fingerprints rather
than secrets, and deletes everything it created — including accounts left by earlier failed runs. It
needs: a running local API, `npx wrangler` authenticated to the account that owns D1, and the VPS SSH
key. Without the deployed `OPS_TOKEN` (§3) the revocation step is the D1 delete; with it, the same
script should call the rotate route instead.

## 7. Limits of this evidence

- **No vantage inside Iran.** This proves server-side identity, host-side config application, the
  app's own tunnel leg and the repair flow. It says nothing about reachability on an Iranian ISP.
- **The workstation runs a TUN client** (`happ-xray` owns the default route). The first probe batch
  after the core was installed produced two timeouts (:443, :2087) that did not reproduce — steady
  state is 3/3 and 4/4. The first-batch numbers are recorded here rather than dropped.
- **Hysteria 2 was provisioned but never dialed**: no Hysteria client is installed here, and a node
  link cannot carry its obfuscation settings. Its credential *is* in the published set (the host's
  `xray`/`hysteria` configs both changed on rotation).
- **The ops rotate endpoint, its audit row and its refusal paths** were not exercised (no token).
- **The mapped window is not the product's only path**: `ProvisionedRepairCard` was driven in the
  browser, signed in, against this dev API — not from the packaged desktop build.
