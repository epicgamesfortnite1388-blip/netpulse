# Provisioned-credential repair — evidence record

Date: 2026-10-26
Scope: subscription (provisioned) profiles whose credential the control plane re-issued, and the
VPN surfaces that must repair them without the user opening Account.

## The defect this closed

A node's fingerprint deliberately ignores the credential, so a re-issued credential produces the
**same** node. `importParsedConfigs` therefore treated the new config as a duplicate, and the
duplicate branch wrote the vault **only when it was empty**:

```ts
if (item.parsed.secret && this.deps.nodeVault?.get(existing.id) == null) { set(...) }
```

Consequences, both silent:

1. Once a credential rotated, the retired secret stayed in the vault forever. Every proxy probe
   failed authentication, honestly and permanently, and **no import could ever repair the node** —
   the node was a duplicate on every subsequent import by construction.
2. The only place that could re-issue a working credential was the Account page's refresh.
   A subscriber who never opens Account had no path back: the profile still looked healthy in
   every list (same endpoint, same protocol, same name), while Connect died with no explanation.

## The change

**Mechanism (`apps/api/src/services/nodesService.ts`)** — a duplicate import may now **replace** a
stored credential, and reports how many it replaced:

- `importParsedConfigs(..., { replaceExistingSecret })` — a differing incoming credential replaces
  the vaulted one; the new `credentialsUpdated` count is returned (and recorded on the
  `node.duplicate` / `node.manual-import` events).
- `importManualConfigs` passes `replaceExistingSecret: true`. **Only** that path does: a subscription
  feed carrying the same host with a *shared* credential must never overwrite a per-user one, so
  sources keep the backfill-only rule.
- An empty/missing incoming secret never clears anything; a vault write failure is reported as
  "not replaced", never as a successful refresh.

**Surfaces (`apps/web`)** — `ProvisionedRepairCard`, mounted once in the VPN shell
(`VpnPage`), so it is visible from every engine surface, plus `provisionedRepair.ts`:

- Detects provisioned profiles (`NetPulse · ` marker) that have never passed, or stopped passing,
  a probe — and says that, not "your credential expired", because a failing probe has several
  causes the app cannot tell apart locally.
- One-click refresh: `cloudApi.provision()` → `toShareLink` per profile → `POST /nodes/import`
  (the replacing path) → `POST /nodes/test-batch {type:'proxy'}` on the affected nodes.
- The verdict is evidence-based: `credentialsUpdated > 0` proves the stored credential was stale;
  `0` says the server issued the same credential and the cause is elsewhere. The probe result is
  reported when it ran and omitted (not implied) when it did not.

**Account-page call site** — `AccountPage.tsx` still called `importProvisionedProfiles`, which an
in-flight share-link refactor had renamed to `importProvisionedConfigs`; the web app did not
typecheck (`TS2724`). Renamed that one call site. The refactor's own
`apps/web/test/provisionProfiles.test.ts` still tests the removed sing-box API
(`toSingboxOutbound`, `toImportRequest`) and fails — left to its author, see below.

## Evidence

| Check | Command | Result |
| --- | --- | --- |
| Rotation rule (service level) | `npx vitest run test/importCredentialRefresh.test.ts` (`apps/api`) | 7 passed |
| Rotation end to end (real HTTP route, real encrypted vault file, real share links) | `npx vitest run test/provisionedCredentialRotation.test.ts` | 4 passed |
| API regression | `npm test -w @netpulse/api` | 98 files, 1064 tests, all passed |
| Web regression | `npm test -w @netpulse/web` | 48/49 files, 431 passed; 1 pre-existing failing file |
| Types | `npx tsc --noEmit` in `apps/api` and `apps/web` | 0 errors (web was 1 before the call-site fix) |

The end-to-end test asserts the vault's **contents**, not just a count, because "the server stopped
publishing the retired credential" is a weaker claim than "the app no longer holds it":

1. import link A → `imported: 1`; vault holds A.
2. import link B (same endpoint/params, new credential) → `duplicates: 1`, `credentialsUpdated: 1`;
   vault holds **B**.
3. import link B again → `credentialsUpdated: 0` (settled).
4. import link A again (a stale saved link) → `credentialsUpdated: 1` (the difference is detected
   in both directions, not silently ignored).
5. `GET /nodes?search=NetPulse · ` returns that node with the marker the card filters on.

## Not verified

- **Against the live control plane.** No Cloud session/entitlement was available in this
  environment, so `POST /api/v1/provision` was never exercised for real: the refresh is proven
  against the app's own API and vault, not against the Worker.
- **Against the installed app's data.** The live database holds 52,573 nodes and **0** with the
  provisioned marker, so detection was proven on an app instance built in a temporary data
  directory. The card has never rendered against a real subscription profile on this machine.
- **The Worker's rotation policy.** When the control plane re-issues a credential (expiry,
  revocation, plan change) is not tested here; the app now repairs whatever it is handed.
- **Web suite is not fully green** — `apps/web/test/provisionProfiles.test.ts` (13 tests) targets
  the pre-refactor sing-box import API that no longer exists. Pre-existing, unrelated to this
  work, and owned by that refactor; it was failing identically before any change here.
