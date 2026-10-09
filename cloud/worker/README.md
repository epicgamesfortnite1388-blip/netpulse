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

and set the sender address as a var in `wrangler.toml`:

```toml
[vars]
MAIL_FROM = "NetPulse <no-reply@yourdomain.com>"
```

`yourdomain.com` must be a verified domain in your Resend account. Delivery
outcomes are audited honestly: `mail_sent`, `mail_http_<status>`,
`mail_from_missing`, `mail_error`, `mail_unconfigured` — the audit log never
carries the token itself (it used to carry `token:<raw>`; that leak is closed).

The reset email links to `https://<worker>/reset?token=...`, a page served by
this Worker with a locked-down CSP. The token is never interpolated
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
npm test        # vitest-pool-workers against real D1 (miniflare)
npx tsc --noEmit
```

## Known limitations

- Password reset requires email delivery to be configured (or operator
  recovery above) — there is no other completion path, by design.
- Email/password auth only; no OAuth or 2FA yet.
