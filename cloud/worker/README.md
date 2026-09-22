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

## Tests

```bash
npm test        # vitest-pool-workers against real D1 (miniflare)
npx tsc --noEmit
```

## Known limitations

- Password reset requires email delivery to be configured (or operator
  recovery above) — there is no other completion path, by design.
- Email/password auth only; no OAuth or 2FA yet.
