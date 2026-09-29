# NetPulse Deploy Runbook — Telegram Integration

Step-by-step deployment and verification for the NetPulse cloud worker
(`netpulse-cloud`) and its Telegram (Abystral bot) integration. Run the
whole book on a fresh account, or jump straight to Phase 5 after any code
change.

The bot side is a separate deployment (repo: Abystral, worker
`abystral-telegram`); its contract lives in
`docs/netpulse-integration.md` on the Abystral repo, and its live smoke
test in `workers/scripts/netpulse-smoke.mjs` there.

> **Account note:** this repo's `cloud/worker/wrangler.toml` targets
> account `7380a67…`. Make sure `npx wrangler whoami` shows THAT account
> before running anything — a mismatch fails with D1 errors `7403` /
> `10000` (wrong account), not a helpful "wrong login" message.

## Phase 0 — Switch and prove the account

```bash
cd cloud/worker
npx wrangler logout
npx wrangler login        # complete the browser flow with the NetPulse account
npx wrangler whoami
```

**Check:** the account table shows `7380a67667052f3a7a3b11301ce7a77b`.

## Phase 1 — Verify the D1 database exists

```bash
npx wrangler d1 list
```

**Check:** a row for `netpulse-cloud` with uuid
`31f2435b-3c23-42ad-b5b8-3b7f815d17dc` (matching `wrangler.toml`).

Fresh account? Create it and paste the new id into `wrangler.toml`:

```bash
npx wrangler d1 create netpulse-cloud
# then edit wrangler.toml: database_id = "<new uuid>"
```

## Phase 2 — Apply migrations (additive, non-destructive)

```bash
npx wrangler d1 migrations apply netpulse-cloud --remote
```

Applies 0001/0002 if the DB is fresh, plus **0003_telegram_integration.sql**
(the integration schema: `service_nonces`, `np_links`, `np_events`,
`np_entitlements`, `np_outbound_log`). All tables are new; no existing
table is altered.

**Check:**

```bash
npx wrangler d1 execute netpulse-cloud --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'np_%' OR name='service_nonces')"
```

Expected: all five tables listed.

## Phase 3 — Deploy (safe before secrets: fail-closed)

```bash
npx wrangler deploy
```

Note the printed `workers.dev` URL. Deploying before secrets is safe by
design: the signed inbox answers `503 service_auth_not_configured` and
the human API is unaffected — there is no window where the worker trusts
unsigned traffic.

## Phase 4 — Secrets

Four secrets, none committed:

```bash
npx wrangler secret put NETPULSE_SERVICE_SECRET
#   SAME 64-hex value as the bot worker's (Abystral:
#   workers/src/telegram/.netpulse-secret.local). Both sides MUST match.

npx wrangler secret put TELEGRAM_BOT_BASE_URL
#   https://abystral-telegram.radinshurideh.workers.dev   (bot's public origin)

npx wrangler secret put OPS_TOKEN
#   any random value >= 16 chars; unlocks the /ops status page

npx wrangler secret put RESET_PEPPER   # if not already set (accounts stack)
npx wrangler secret put AUTH_SECRET    # if not already set (accounts stack)
```

Secrets take effect immediately on the running version — no redeploy
needed after setting them.

## Phase 5 — Post-deploy verification

```bash
NP_URL=https://netpulse-cloud.<your-subdomain>.workers.dev   # from Phase 3 output
```

1. **Health** (public, honest D1 probe):

   ```bash
   curl -s "$NP_URL/api/v1/health"
   ```

   Expect `{"ok":true,...}`.

2. **Auth wall** (fail-closed proof):

   ```bash
   curl -s -X POST "$NP_URL/api/internal/netpulse/v1/events" \
     -H "Content-Type: application/json" \
     -d '{"eventId":"probe","eventType":"subscription.activated"}' -w '\nHTTP:%{http_code}\n'
   ```

   Expect 401 `missing_signature_headers`.

3. **Signed interop probe** — the Abystral repo's smoke script works
   against this worker too (same canonical string, same secret):

   ```bash
   cd /path/to/Abystral
   node workers/scripts/netpulse-smoke.mjs \
     --base "$NP_URL" \
     --secret-file workers/src/telegram/.netpulse-secret.local
   ```

   Expect `ALL CHECKS PASSED` (the replay check manifests as
   `401 nonce_replayed`; the bot-side label for tampering is
   `signature_mismatch`, this worker's is `invalid_signature`).

   Cleanup of the probe rows:

   ```bash
   npx wrangler d1 execute netpulse-cloud --remote --command \
     "DELETE FROM np_events WHERE event_id LIKE 'e-%' OR event_id LIKE 'probe-%'"
   ```

4. **Status page** — open `$NP_URL/ops` in a browser, paste `OPS_TOKEN`,
   press Load. Expect the four summary cards (links, last sync, inbox,
   outbound ok-rate) with zeroed counters on a fresh deploy, plus
   `401`/`503` behavior when the token is wrong/unset.

## Phase 6 — Live end-to-end smoke (the real user path)

1. Desktop app: sign in -> Account -> **Link Telegram**. The worker mints
   a bot-side code; verify the outbound audit row:

   ```bash
   npx wrangler d1 execute netpulse-cloud --remote --command \
     "SELECT action, status, ok FROM np_outbound_log ORDER BY created_at DESC LIMIT 3"
   ```

2. Open the deep link in Telegram, confirm with the bot.
3. App: paste the code -> Confirm. Status shows **linked**; the
   entitlement snapshot arrives within seconds.
4. Verify both sides:

   ```bash
   # NetPulse side (this repo):
   npx wrangler d1 execute netpulse-cloud --remote --command \
     "SELECT event_type, processed_status FROM np_events ORDER BY received_at DESC LIMIT 5"

   # Bot side (Abystral repo):
   npx wrangler d1 execute abystral-db --remote --command \
     "SELECT event_type, status, attempts FROM netpulse_sync_events ORDER BY created_at DESC LIMIT 5"
   ```

   Expect `link.confirmed` / `subscription.activated` rows with
   `applied` (NP) and `delivered` (bot).

5. Buy or renew in Telegram -> the app reflects it after the drainer pass
   (<= 5 min) or on **Refresh Subscriptions**.

## Rollback

- Worker: `npx wrangler rollback` (or redeploy the previous version) — instant.
- Bot-side kill switch without any redeploy: ops-config
  `netpulse_sync_enabled = false` (crons inert, Telegram section inert,
  integration API 503).
- Migration 0003 is purely additive; there is nothing to roll back in D1.

## Secret rotation

1. Generate a new 32-byte secret.
2. `wrangler secret put NETPULSE_SERVICE_SECRET` on the bot worker first,
   then on this worker (each takes effect immediately).
3. Between the two puts, the OTHER side's signatures fail with 401 — the
   window is seconds; the outbox retries cover any rejected deliveries.
4. Re-run the smoke script against both workers to confirm.
