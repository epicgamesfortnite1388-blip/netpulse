# NetPulse Cloud Worker

The security boundary between the desktop app and D1. Accounts, sessions,
sync, and password reset live here; the desktop is an untrusted client and
never holds Cloudflare credentials.

## Deploy

```bash
cd cloud/worker
npm install
npx wrangler login              # OAuth; no tokens in the repo
npx wrangler d1 create netpulse-cloud   # once; paste the id into wrangler.toml
npx wrangler d1 migrations apply netpulse-cloud --remote
npx wrangler secret put AUTH_SECRET     # >= 32 random bytes, hex/base64
npx wrangler secret put RESET_PEPPER    # >= 32 random bytes, independent of AUTH_SECRET
npx wrangler deploy
```

## Password-reset email (optional but recommended)

Without a mail transport, `POST /api/v1/auth/forgot-password` still issues a
single-use 30-minute token (hashed in D1) but **delivers nothing** — the audit
event records `mail_unconfigured` and no token exists anywhere retrievable.

To enable email delivery, configure the Resend transport:

```bash
npx wrangler secret put RESEND_API_KEY   # from resend.com/api-keys
```

and set the sender address. `MAIL_FROM` is currently held as a Worker SECRET
(`npx wrangler secret put MAIL_FROM`) in the live production Worker, so the
sender address is not in this repo; a `[vars]` entry in `wrangler.toml` works
too, but never both — a deploy-time var and a secret with the same name are an
ambiguous pair to debug. The same applies to `EXPECTED_ORIGIN` (public, so it is
a var in `wrangler.toml`, one per environment). Otherwise the value would be:

```toml
[vars]
MAIL_FROM = "NetPulse <no-reply@yourdomain.com>"
```

`yourdomain.com` must be a verified domain in your Resend account. Delivery
outcomes are audited honestly: `mail_sent`, `mail_http_<status>`,
`mail_from_missing`, `mail_error`, `mail_unconfigured` — the audit log never
carries the token itself (it used to carry `token:<raw>`; that leak is closed).

The reset email links to `https://<worker>/reset?token=...`, a page served by
this Worker with a locked-down CSP. `<worker>` is `EXPECTED_ORIGIN`, which must
be THIS environment's own Worker URL: there is no separate hosted web frontend
(the desktop bundle runs the SPA from `tauri.localhost`, which no email can link
to), and the top-level Worker — not `netpulse-cloud-production` — is the live
production endpoint the desktop app calls. The token is never interpolated
server-side, so the page cannot reflect it back into HTML.

## Operator recovery (no mail configured)

An operator with wrangler access can complete a reset manually — the token is
unrecoverable by design, so mint a fresh one:

```bash
node -e "console.log(crypto.randomBytes(32).toString('base64url'))"   # TOKEN
node -e "console.log(crypto.createHash('sha256').update(process.argv[1]+process.argv[2]).digest('hex'))" "$TOKEN" "$RESET_PEPPER"   # HASH
npx wrangler d1 execute netpulse-cloud --remote --command \
  "UPDATE password_reset_tokens SET token_hash='$HASH', expires_at=$((DATE_MS+1800000)), used_at=NULL WHERE id='<row-id>'"
```

then hand `TOKEN` to the user (or use it at `/reset` yourself).

## NetPulse <-> Telegram (Abystral) integration

The worker mirrors bot-owned subscription entitlements for linked app
accounts. The bot (Abystral) remains authoritative for purchases, payments,
and entitlements; this worker never accepts a Telegram identity from a
client - linking is verified by the bot itself.

```bash
npx wrangler secret put NETPULSE_SERVICE_SECRET   # SAME value as the bot's
npx wrangler secret put TELEGRAM_BOT_BASE_URL     # e.g. https://abystral-bot.<account>.workers.dev
npx wrangler d1 migrations apply netpulse-cloud --remote   # applies 0003 + 0004
```

- Inbound (bot -> here): `POST /api/internal/netpulse/v1/events` and
  `/events/ack`, HMAC-signed (`v1\nts\nnonce\nMETHOD\npath?query\nsha256(body)`,
  headers `x-np-*`, +/-5 min skew, single-use D1 nonces). Fail-closed when
  `NETPULSE_SERVICE_SECRET` is unset.
- Outbound (here -> bot): `/link/request`, `/link/claim`, `/link/status/:id`,
  `/link/:id`, `/entitlement/:id` - same signature scheme, every call audited
  in `np_outbound_log` (action + path + status; never signature material).
- Signed-in devices (bot -> here, NEW): `GET /api/internal/netpulse/v1/session
  ?netpulseAccountId=<npa_…>` lists an account's live sessions and
  `DELETE /api/internal/netpulse/v1/session/<sessionId>` (body:
  `{ netpulseAccountId }`) revokes exactly one. Same HMAC scheme, fail-closed,
  rate-limited per account, audited. The account is identified by the
  `netpulse_account_id` the bot already holds from `link/request` and that
  `np_links` indexes - never a Telegram id, never a NetPulse user id - and only
  while `np_links.status = 'active'`, so a revoked link stops answering
  identically to an unknown id. Reuses the same rows as the app's
  `/api/v1/account/sessions`; no token material crosses the boundary. "Sign out
  everywhere" is deliberately NOT exposed here: it is one mis-tap away in
  Telegram and cannot be undone from the same screen.
- App-facing routes: `GET /api/v1/account/telegram`, `POST .../link`,
  `POST .../link/confirm`, `POST .../unlink`,
  `POST /api/v1/integrations/telegram/status|sync`, `GET /api/v1/subscriptions`,
  `GET /api/v1/subscriptions/:id`.
- Events dedup on `event_id`; entitlement upserts are guarded by
  `config_updated_at`, so out-of-order deliveries never regress state.
- Full contract: `docs/netpulse-integration.md` in the Abystral repo.

## Operator status page (`/ops`)

```bash
npx wrangler secret put OPS_TOKEN   # >= 16 chars; not committed
```

`GET /ops` serves a public, no-data HTML shell (locked-down CSP, same trust
split as `/reset`). The operator pastes the token; the page calls
`GET /api/v1/ops/netpulse` (`Authorization: Bearer <token>`), which is
fail-closed when `OPS_TOKEN` is unset, and shows:

- link counts (active / pending / unlinked) + last entitlement pull-sync age
- inbox health: `np_events` processed-status breakdown + the 10 newest events
- outbound-call health: 24h ok-rate, per-action totals/failures, recent errors

## VPN identities: per-user credentials + host reconciliation

Migration `0005` adds `vpn_credentials`. Before it, every client authenticated
with the same `VPN_*` Worker secrets, so expiry could only refuse **new**
provisioning — a config already on a laptop stayed valid forever. Now
`POST /api/v1/provision` mints one secret per (user, protocol), stores it, and
builds the client config from it; the VPN host pulls the identities it may
authenticate and writes exactly those into the server configs.

```bash
npx wrangler d1 migrations apply netpulse-cloud --remote
npx wrangler secret put VPS_SYNC_SECRET   # >= 32 random bytes; same value on the host
```

`GET /api/v1/internal/vpn-users` (`Authorization: Bearer <VPS_SYNC_SECRET>`,
constant-time compare, `503` when unset) returns
`{ ok, version, users: [{ id, protocol, username, secret, expiresAt }] }` for
credentials that are `active` **and** belong to an `active`, unexpired
entitlement on a non-disabled account. `version` is a hash of the user list, so
the host can skip work it has already applied. Nothing account-identifying is in
the payload beyond an opaque `usr_…` id and a hashed `u_…` login name.

On the VPN host the reconciler (`scripts/vps-sync-vpn-users.py`, installed as
`/opt/netpulse-sync/reconcile.py`, timer `netpulse-sync-vpn.timer`, every 60s)
rewrites the Xray `clients` arrays and the Hysteria `userpass` map to exactly
that set and restarts the unit only when a file changed:

- expiry/revocation/refund → the identity disappears from the config on the next
  pass (≤ 1 min) and the next handshake is refused, even if the config was
  already copied elsewhere;
- `expiresAt` travels with the identity, so the host prunes it locally at that
  instant instead of depending on a reachable Worker;
- a failed pull keeps the last known-good set (a network blip is not a reason to
  disconnect everyone); a malformed payload applies nothing; an empty, valid set
  is applied (deny all);- state, the last run and one generation of backups live in `/opt/netpulse-sync`
  (`state.json`, `last-run.json`, `backup/`, `reconcile.log`). `--print` shows
  what would be written and changes nothing.

That last point is the one a leak depends on, so it is checked rather than
assumed: `scripts/verify-vps-reconciler-removal.py` drives the reconciler in
`--print` mode with a rotated secret, a revoked identity and an already-expired
one, prints the config diff, and fails if the old secret or the revoked identity
survives. Run it with `--from-live` on the host to diff against the real configs
(read-only). Evidence: `reports/accounting/VPS_RECONCILER_REMOVAL_DRYRUN_2026-10-26.md`.

`xray-shadowsocks-2022` is deliberately **not** provisioned: its server side
authenticates with one shared password, so it was dropped from the plan
`default_profiles` and its inbound retired. A plan that still lists it comes
back as `skipped: no_per_user_identity` rather than a config nobody can revoke
(`generateVpnConfig` no longer has a shared-secret fallback at all).

The desktop refreshes profiles from the Account page (`cloudApi.provision()`),
which is what makes a client pick up its own identity after a renewal.

### Rotating a leaked config

Revoking an entitlement takes the config away at the end of the paid period,
which is useless in an incident. `POST /api/v1/ops/vpn/rotate` kills one
account's identities **now**, without touching the subscription:

```bash
# every protocol the account was issued
curl -sS -X POST https://<worker>/api/v1/ops/vpn/rotate \
  -H "Authorization: Bearer $OPS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"email":"customer@example.com"}'

# or one protocol, by the opaque id when the email is unknown
curl -sS -X POST https://<worker>/api/v1/ops/vpn/rotate \
  -H "Authorization: Bearer $OPS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"userId":"usr_...","protocol":"xray-vmess-ws"}'
```

The same action is on the `/ops` page ("Rotate VPN credentials"), behind a
confirmation. Body: exactly one of `email` or `userId`, plus an optional
`protocol` (only the five per-user protocols; a shared-secret protocol has
nothing to rotate and answers `400 unsupported_protocol`).

What happens, in order:

1. every matching `vpn_credentials.secret` is replaced in one D1 batch (a
   partial rotation would leave some protocols on the leaked value); the
   row's `status` is left alone, so an already-revoked identity stays revoked —
   this action replaces secrets, it never re-grants access;
2. the account's stored `vpn_profiles` are rebuilt from the new secret and
   `config_version` is bumped, so the app pulls the working config instead of
   the leaked one on its next sync;
3. `vpn.credentials.rotated` lands in `audit_events` (target user id in
   `user_id`, the actor recorded as `by:ops-token`);
4. the response reports `previousFingerprint → fingerprint` per protocol and
   `syncWindowSeconds` (60) — **never** the new secret. The customer receives
   it through normal provisioning/sync; the operator does not need it and it
   must not end up in a chat log.

The old identity stops authenticating when the host's next reconcile (≤ 60s)
applies the new set, so `syncWindowSeconds` is the honest deadline for "the
leaked config is certainly dead". The account keeps its entitlement, and a
disabled account is refused with `409 account_disabled` (re-enable it first).
`email` is the fastest path; `userId` exists because the address on file may
itself have been compromised.

The customer gets the replacement from the Account page (it re-provisions on
open), but a config already imported into a third-party client has to be
replaced by hand: the old identity is dead either way, so tell them to refresh
and re-import rather than wait for a reconnect to fix itself.

## Admin: plan of record (default VPN configs and nodes)

Migration `0004` adds `users.role` and the single `plans` row. Every existing
account becomes `normal`, so a freshly migrated deployment has **zero admins**
by design and needs an explicit bootstrap. The bootstrap route only answers
while no admin exists and is rate-limited to 3 attempts/hour per IP:

```bash
# The password is chosen here and never stored in the repo.
curl -sS -X POST https://<worker>/api/v1/admin/account \
  -H 'Content-Type: application/json' \
  -d '{"email":"<admin-email>","password":"<strong-password>"}'
```

The response carries the admin's access/refresh tokens. Those tokens unlock
the admin-only routes; normal accounts get `403 admin_required` on every one
of them:

| Route | Purpose |
| --- | --- |
| `GET /api/v1/admin/plan` | read the plan of record |
| `PATCH /api/v1/admin/plan` | set `name`, `defaultProfiles` (default VPN configs), `defaultNodes` (default node keys), `defaultScanProfile`, `preferredProxyEngine`; `code` only to a code the bot has already issued |
| `GET /api/v1/admin/users` | account list with roles |
| `POST /api/v1/admin/users/:id/promote` and `.../demote` | role changes; the last admin cannot be demoted |
| `GET /api/v1/admin/events` | audit of role changes and plan edits |

`defaultProfiles` and `defaultNodes` are JSON string arrays; anything else is
rejected with `400 invalid_plan_defaults`. Normal accounts keep exactly their
own data (profiles, favorites, subscriptions) - no user-scoped route exposes
the plan defaults.

## Tests

```bash
npm test        # @cloudflare/vitest-plugin against real D1 (miniflare)
npx tsc --noEmit
```

## Known limitations

- Password reset requires email delivery to be configured (or operator
  recovery above) — there is no other completion path, by design.
- Email/password auth only; no OAuth or 2FA yet.
