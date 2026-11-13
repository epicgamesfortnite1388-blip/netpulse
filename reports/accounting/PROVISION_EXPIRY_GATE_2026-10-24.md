# Provisioning expiry gate — root cause, fix, production evidence

**Date:** 2026-10-24
**Component:** `cloud/worker` — `POST /api/v1/provision`
**Deployed:** `99e319af-2e28-4863-8755-c88061ea72f2` (100%); first gate deploy
`aa1ad91f-d93c-47a2-bc38-c8fa816f778d`, redeployed after dropping an unused
import (no behavioural change).
**Verdict:** the gate was **not enforcing expiry for real data**. Fixed, tested,
and verified against production with a disposable account. A separate,
architectural limitation remains (see §6).

## 1. Root cause

`np_entitlements.expires_at` is a **TEXT** column, and the bot writes a
`YYYY-MM-DD HH:MM:SS` datetime into it (the integration fixtures and the
column type both say so). The gate did:

```ts
if (target.expiration_time && Number(target.expiration_time) < t) {
  return fail(403, 'entitlement_expired', 'Subscription has expired');
}
```

`Number('2020-01-01 00:00:00')` is `NaN`, and `NaN < Date.now()` is **false**.
Measured in this workspace:

```
{ Number: NaN, comparator: false }
```

So the check was equivalent to `if (false)`: any entitlement whose *status* had
not already been flipped by the bot could be provisioned after it expired. The
status check above it still worked, which is why the bug is invisible in normal
operation — until a delayed/missed `subscription.expired` event, a stale mirror,
or a bot outage leaves `status = 'active'` on an expired subscription.

## 2. Fix

`parseEntitlementExpiry(value)` in `cloud/worker/src/netpulse-integration.ts`
parses every shape the bot can write:

| Shape | Handling |
|---|---|
| `YYYY-MM-DD HH:MM:SS` (space) | pinned to **UTC** (`T…Z`) — V8's local/UTC ambiguity would otherwise make the gate host-dependent |
| ISO-8601 (with/without offset) | `Date.parse` |
| epoch as number or numeric string | seconds when `≤ 1e11`, milliseconds otherwise |
| `null` / empty | open-ended — allowed |
| anything unreadable | `null` |

The route now denies with distinct codes and audits the refusal:

- `expires_at` present and unreadable → `403 entitlement_expiry_unreadable`
  (fail closed: an unverifiable end date is not a licence to serve a paid plan);
- end date in the past → `403 entitlement_expired`;
- status not `active` → `403 entitlement_not_active` (unchanged);
- both denials write `vpn.provision.denied` to `audit_events`.

## 3. Tests

`cloud/worker/test/provision.test.ts` — 7 new cases (9 in the file):

- expired SQL datetime → 403 `entitlement_expired`, **0 profiles written**
- expired ISO → 403
- expired epoch seconds → 403
- future SQL datetime → 200, all plan protocols provisioned
- open-ended (`null`) → 200
- unreadable (`whenever`) → 403 `entitlement_expiry_unreadable`, 0 profiles
- `status = 'revoked'` with a future end date → 403 `entitlement_not_active`

Full worker suite: **103 tests / 5 files pass**; `tsc --noEmit` clean.

## 4. Production evidence (disposable account, cleaned up)

One throwaway account (`expirycheck+…@example.com`) and one entitlement row,
driven through the live Worker:

| Step | Result |
|---|---|
| `expires_at = '2020-01-01 00:00:00'`, `status = active` | `403 entitlement_expired` |
| `expires_at = '2099-01-01 00:00:00'` | `200`, 6 protocols, 0 errors |
| `status = 'revoked'`, future date | `403 entitlement_not_active` |
| `expires_at = 'whenever'` | `403 entitlement_expiry_unreadable` |

Re-verified on the final deployed version `99e319af`: expired row →
`403 entitlement_expired`.

Cleanup verified: `users = 0`, `entitlements = 0`, `vpn_profiles = 0`,
`sessions = 0`, `audit_events = 0`, no `expirycheck%` users remain.
Temporary response files (one contained real VPN configs) were overwritten with
random bytes before deletion; the access token never reached a log.

## 5. Rollback

Previous Worker version `5f03ad74-e506-4735-a117-989d24751484`
(`wrangler rollback`), or revert the two source files. No schema change.

## 6. Remaining: issued credentials survive expiry (architectural)

The gate controls **new provisioning**, not credentials already handed out. The
VPN server authenticates every user with the **same** shared UUID/passwords
(`VPN_*` secrets), so an expired user's existing config keeps working — there is
no per-user identity on the server to revoke. Rotation invalidates *everyone*,
which is the wrong tool.

Consequences:

- Acceptance C (“expiry and revocation remove the expected entitlements”) is
  **PARTIAL/FAIL**: the app stops issuing configs, but the tunnel does not stop.
- Fix direction: allocate a per-user credential at provisioning time and push
  it to the server (Xray inbounds support client lists; Hysteria 2 has
  `auth.userpass`), then remove that client on expiry/revocation. This needs a
  server-side admin channel the Worker does not have today — a separate,
  reviewable design change, recorded in the mission backlog.

No claim of revocation is made until that exists.
