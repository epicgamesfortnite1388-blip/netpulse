# Signed bot → Worker event leg — verification

**Date:** 2026-10-24
**Subject:** `Abystral (Telegram) bot` → `netpulse-cloud` signed event inbox
**Verdict:** the leg is **verified in production for every rejection path**, and
**verified end-to-end (accept + replay) on the real Workers runtime with a real
32-byte shared secret**. The single remaining step — a *positive* event accepted
by the **deployed** worker — is **BLOCKED** because the production secret value
is write-only. No production configuration was changed by this verification.

---

## 1. What the leg is

Both workers sign with HMAC-SHA256 over a canonical string:

```
v1 \n <ts> \n <nonce> \n <METHOD> \n <path+query> \n sha256hex(body)
```

Headers: `x-np-timestamp`, `x-np-nonce`, `x-np-request-id`, `x-np-signature`.
Clock skew ±5 min. The NetPulse side burns the nonce in D1 **before** comparing
the signature, so a duplicate insert (`nonce_replayed`) always short-circuits
verification. Implementation: [np-auth.ts](../../cloud/worker/src/np-auth.ts).
Reason codes are stable, which is what makes production verifiable without the
key.

## 2. Secret availability (why the last step is blocked)

- `wrangler secret list` on `netpulse-cloud` shows **`NETPULSE_SERVICE_SECRET` is
  set** — the deployed verifier is armed, not fail-closed-unconfigured.
- Cloudflare secrets are **write-only**: neither this machine nor the API can
  read the value back.
- The bot worker's source/deployment is **not in this repository**, so re-keying
  both sides is not something this workspace can do unilaterally (and would be a
  two-worker production change, not a verification step).

Consequence: the *accept* path can be proven locally with a real key, but an
event cannot be *signed with the production key* from here.

## 3. Evidence

### 3.1 Production probe — `node scripts/verify-signed-inbox.mjs` (5/5 PASS)

| Check | Observed |
|---|---|
| Unsigned delivery refused | `401 missing_signature_headers` |
| Well-formed HMAC under a **wrong key** refused | `401 invalid_signature` (not 503 → secret present) |
| Replay of that exact request | `401 nonce_replayed` (nonce already burned in production) |
| Stale timestamp | `401 timestamp_out_of_window` |
| Signature made for `/events` sent to `/events/ack` | `401 invalid_signature` (target is bound) |

The replay result is the important one: production returns `nonce_replayed`
**before** any signature comparison, which is the documented ordering and the
property that stops replay probing.

### 3.2 Full round trip on the real runtime — 8/8 PASS

Same script against `wrangler dev --local` (workerd + local D1) with a freshly
generated 32-byte secret:

| Check | Observed |
|---|---|
| Correctly signed request accepted | `422 unknown_event_type:__probe__` |
| Replay of the **accepted** request | `401 nonce_replayed` |
| Body altered after signing | `401 invalid_signature` |

Acceptance is proven by *reaching event validation* (422) with an unknown event
type, so the probe never writes `np_events` / `np_entitlements`. Local D1
afterwards: `probe_events = 0`, `entitlements = 0`, `service_nonces = 4`.

### 3.3 Runtime suite — 96/96 PASS

`npx vitest run` in `cloud/worker`: 5 files, 96 tests, exit 0. The suite drives
the real fetch handler against real D1 and already covered unsigned, stale,
tampered, replay, event-type/version validation, idempotent redelivery,
entitlement application, linking, rate limits, and cross-account isolation.
**Added:** a wrong-key test (a structurally valid HMAC under a different secret
must be `invalid_signature`), which previously was only covered by mutating the
signature hex.

### 3.4 Accepted event, idempotency and replay — `node scripts/smoke-signed-event.mjs` (4/4 PASS)

Against the local worker with a real event (`subscription.activated`, unlinked
account):

| Check | Observed |
|---|---|
| First delivery | `200 {duplicate:false}`, parked `processed_status = no_link` |
| Same eventId, fresh nonce | `200 {duplicate:true}` |
| Byte-identical request (same nonce) | `401 nonce_replayed` |
| Redelivery after the replay attempt | `200 {duplicate:true}` |

Local D1 afterwards: **exactly one** `np_events` row for that eventId, all four
accepted events `no_link`, **0** `np_entitlements` rows. A run that reused a
nonce from an earlier run was refused (`nonce_replayed`), which is the guard
working across processes, not just within one.

The script is loopback-only by construction: given a public base it exits 2 and
writes nothing, because an accepted event does write `np_events` rows.

## 4. Files

- `scripts/verify-signed-inbox.mjs` — new. Runs against production in
  armed-verifier mode, or against any base with a supplied secret.
- `scripts/smoke-signed-event.mjs` — new. Accepted-event, idempotency and replay
  smoke; refuses any non-loopback base.
- `cloud/worker/test/netpulse-integration.test.ts` — one new test (wrong key).
- This report.

No Worker code, secret, or host configuration changed.

## 5. Final step, when the secret is available

```bash
NP_SERVICE_SECRET_FILE=/secure/path/to/netpulse-service-secret \
  node scripts/verify-signed-inbox.mjs
```

Expected: 8/8, including `correctly signed request accepted — 422
unknown_event_type:__probe__` and `replay of an ACCEPTED request refused — 401
nonce_replayed`. The same file can feed `npm run e2e:telegram:cloud` for the
full bot-side drain (signed `/plans`, event enqueue, link/claim).

## 6. Limitations

- The bot's canonical-string implementation cannot be read from this repo, so
  **byte-identity across the two workers is only provable by that final positive
  run**. Everything short of it is verified.
- The local run used a throwaway secret; the value was discarded with the
  process and its log. Nothing was committed.
- Production D1 gained one `service_nonces` row per accepted request; the
  worker sweeps them after 15 minutes by design. No entitlement or event rows
  were created by any probe.

## 7. Rollback

None required — read-only against production apart from those self-expiring
nonce rows. To re-run, repeat the command; nonces are unique per request.

## 8. Run log

| When (UTC) | What | Result |
|---|---|---|
| 2026-10-24 ~23:05 | `verify-signed-inbox.mjs` vs production | 5/5 — every rejection path |
| 2026-10-24 ~23:10 | `verify-signed-inbox.mjs` vs `wrangler dev --local`, throwaway secret | 8/8 incl. accepted 422 + replay |
| 2026-10-24 ~23:25 | `verify-signed-inbox.mjs` vs local, secret supplied via `NP_SERVICE_SECRET_FILE` | 8/8 — exercises the file path the production run will use |
| 2026-10-24 ~23:30 | `smoke-signed-event.mjs` vs local | 4/4; 1 D1 row per eventId, 0 entitlements |
| — | `verify-signed-inbox.mjs` accepted path vs **production** | **BLOCKED** — secret value is write-only |
| — | `smoke-signed-event.mjs` vs **production** | **NOT RUN BY DESIGN** — refuses non-loopback (writes `np_events`) |
