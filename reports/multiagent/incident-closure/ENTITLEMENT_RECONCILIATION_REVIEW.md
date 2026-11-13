# Entitlement Reconciliation Review — A3

**Scope:** Independently inspect `POST /api/internal/netpulse/v1/entitlement/snapshot` and its caller. Verify auth/authz, non-2xx handling, cross-account isolation, enumeration risk, reconciliation of matching/mismatched/missing/expired/revoked entitlements, idempotency, and safe recovery from partial failures. Add/improve tests for the actual defect. Demonstrate drift detection + repair without cross-account exposure.

**Verification performed this session:** 2026-10-23

---

## 1. Components inspected

| Component | File | Role |
|---|---|---|
| Bot inbound route (POST /entitlement/snapshot) | `workers/src/telegram/src/handlers/netpulse-api.ts:321-338` | Bot receives NetPulse's supplied snapshot, compares against bot's own authoritative subscriptions |
| Bot compare service | `workers/src/telegram/src/services/netpulse.ts:696-711` | `compareEntitlementSnapshot` — bot is authoritative |
| Bot push-compare caller | `workers/src/telegram/src/services/netpulse.ts:658-685` | `pushSnapshot` — bot pushes to NetPulse, interprets `inSync` |
| Cloud worker pull | `cloud/worker/src/netpulse-integration.ts:357-400` | `syncNetpulseEntitlements` — GET /entitlement/:id, replace-not-merge mirror |
| Cloud event inbox | `cloud/worker/src/netpulse-integration.ts:437-513` | `ingestNetpulseEvent` — config_updated_at ordering guard |
| Cloud integration tests | `cloud/worker/test/netpulse-integration.test.ts` | 16 tests, all pass |
| Bot unit tests (snapshot) | `workers/src/telegram/tests/netpulse-snapshot.test.ts` | 10 tests, all pass |
| Auth module | `workers/src/telegram/src/lib/netpulse-auth.ts` | HMAC-SHA256 service signing |

---

## 2. Authentication & authorization

**Finding: PASS.**

- Route is behind the signed service wall: `verifyServiceRequest(request, body, env)` — HMAC-SHA256 over canonical string binding `version · timestamp · nonce · method · path · SHA-256(body)`.
- Fail-closed: if `NETPULSE_SERVICE_SECRET` unset → 503 `service_auth_not_configured`. A half-deployed integration never degrades to unsigned trust.
- Replay protection: nonce single-use in KV with TTL (15 min), timestamp window ±5 min, signature verified before nonce is consumed.
- Stable failure reasons only (`missing_signature_headers`, `timestamp_out_of_window`, `nonce_replayed`, `signature_mismatch`); no secret or payload material logged.
- Separate token namespace from Telegram webhook secret, NetPulse user sessions, and admin `ADMIN_SECRET`.

---

## 3. Non-2xx handling & state distinction

**Finding: PASS (handler); PARTIAL (pushSnapshot caller — see Defect 1).**

Handler (`netpulse-api.ts:321-338`):
- Account supplied + linked → 200 `{ authoritative: true, inSync: <computed>, ... }`.
- Account supplied + not linked → 404 `not_linked`.
- No account → 200 `{ authoritative: false, inSync: undefined }` (backward-compat conservative shape).
- Invalid JSON → 400 `invalid_json`.
- Unknown route → 404 `not_found`.

`pushSnapshot` caller (`netpulse.ts:658-685`):
- Non-2xx response → `null` (treated as "NetPulse unreachable" → reconciliation skips drift for that link, safe side).
- 2xx with `inSync: false` → `inSync: false` → drift detected.
- **DEFECT 1:** 2xx with missing `inSync` field, or non-JSON 2xx body → `data?.inSync !== false` evaluates to `true`. A 2xx that omits `inSync` is interpreted as "in sync," which defeats drift detection when NetPulse returns an unparseable or field-absent 2xx.

---

## 4. Cross-account isolation

**Finding: PASS.**

- Bot side: `compareEntitlementSnapshot` looks up the link by `netpulseAccountId`, then `listSubscriptionsByUser(link.user_id)`. Only that user's subscriptions are compared. Account A's entitlements never visible to account B.
- Cloud side: `syncNetpulseEntitlements` and `ingestNetpulseEvent` are scoped by `user_id` / `netpulse_account_id`; inserts use `ON CONFLICT(subscription_id)` guarded by `config_updated_at`; `np_events` parked as `no_link` when no active link exists.
- Cloud integration tests confirm: an entitlement event addressed to A lands only in A's mirror; B's session API never sees A's entitlement (tests at `netpulse-integration.test.ts:377-398`).

---

## 5. Enumeration / account-existence leakage

**Finding: ACCEPTABLE for service channel, noted.**

- `GET /entitlement/:id` and `DELETE /link/:id` return 404 `not_linked` when the account is unknown. `POST /entitlement/snapshot` with an unknown account returns 404 `not_linked`.
- This distinguishes "account exists" from "account does not exist" to signed service callers only (bot↔cloud service channel, HMAC-protected). Not exposed to end users.
- Timing/audit rows: events audited (`np_events`, `np_outbound_log`, audit rows carry action/path/status/error only — no secret material). Status-code distinction (404 vs 401) may leak account existence to signed callers only. Acceptable for the service channel; document as a noted residual.

---

## 6. Reconciliation correctness (matching / mismatched / missing / expired / revoked)

**Finding: PASS (compare semantics).**

`compareEntitlementSnapshot` (`netpulse.ts:696-711`):
- Filters authoritative subscriptions to `['active', 'expired', 'disabled', 'paused']` — excludes `canceled` and other non-entitlement statuses.
- Projects through `toEntitlement` into the same `NetpulseEntitlement` shape as the supplied view.
- `entitlementsMatch` (`netpulse.ts:714+`): O(n); compares counts, builds a Map by `subscriptionId`, treats duplicate/missing/extra ids as drift, compares every field (`planCode`, `status`, `startedAt`, `expiresAt`, `autoRenew`, `totalGb`, `usedGb`, `ipLimit`, `configUpdatedAt`).
- `null` = no active link (handler → 404), never "in sync."

Unit-tested 10/10 covering: identical → in sync; single drifted field → out of sync; `expiresAt` drift → out of sync; missing subscription → out of sync; extra subscription → out of sync; duplicate ids → out of sync; both empty → in sync; no link → null; excludes `canceled`; does not require delivery env.

---

## 7. Idempotency & safe recovery from partial failures

**Finding: PASS.**

- Cloud event ingest: `INSERT OR IGNORE` on `event_id`; replays are no-ops (`duplicate: true`).
- Entitlement upsert guarded by `config_updated_at` ordering: an out-of-order older snapshot must not regress newer state (`WHERE excluded.config_updated_at >= np_entitlements.config_updated_at`).
- `syncNetpulseEntitlements`: replace-not-merge in a single `db.batch` — mirror converges to the bot's view; partial failure leaves prior state intact (batch is atomic per-statement, not transactional across the whole batch, but delete+inserts are ordered and idempotent on retry).
- Initial pull after link confirm is best-effort; bot's snapshot events + reconcile pass repair any gap.

---

## 8. DEFECT 1 — `pushSnapshot` interprets field-absent 2xx as in sync (drift-detection weakness)

**File:** `workers/src/telegram/src/services/netpulse.ts:680-681`

```ts
const data = await response.json().catch((_err: unknown) => null) as { inSync?: boolean } | null;
return { inSync: data?.inSync !== false };
```

**Problem:** `data?.inSync !== false` is `true` when:
- `data` is `null` (non-JSON 2xx body), or
- `data.inSync` is `undefined` (2xx body omits the field).

So a NetPulse 2xx that does not explicitly carry `inSync: false` is treated as "in sync." Reconciliation then skips drift repair for that link. This is the regression the original stub (`inSync: undefined` → interpreted as in sync) was meant to fix, but `pushSnapshot` reintroduces the same class of error at the HTTP boundary.

**Required fix (test-first):** `pushSnapshot` should treat any 2xx that does not explicitly carry `inSync: true` as drift (or at minimum as `inSync: unknown → drift`), so reconciliation repairs rather than silently accepting. Recommended semantics: `return { inSync: data?.inSync === true }` — only an explicit `inSync: true` from NetPulse counts as agreement.

**Test to add:** `tests/netpulse-snapshot.test.ts` should add a case where the handler returns 200 without `inSync` (or a non-JSON 2xx), and assert `pushSnapshot` reports drift rather than in sync. (Integration-level: stub the bot→NetPulse fetch to return `new Response('ok', {status: 200})` and assert `inSync` is false.)

---

## 9. Controlled drift-repair demonstration (not executed live)

A live e2e drift-repair test requires a deployed bot + NetPulse worker pair and a test Telegram user; neither was available in this session (no live VPS access, no Telegram test user, purchase-flow blocked per Mission 3). The following is the test design to execute when staging is available:

1. Seed account A with active subscription S1 (status `active`, plan `plan_1`).
2. Intentionally corrupt NetPulse's mirror for S1: set status to `expired` (drift introduced).
3. Run the bot's reconcile pass (`reconcileNetpulseLinks` / snapshot compare).
4. Assert: `compareEntitlementSnapshot` returns `inSync: false` for account A (drift detected).
5. Assert: repair re-emits `subscription.activated` events for S1; NetPulse mirror converges back to `active`.
6. Assert cross-account isolation: seed account B with unrelated subscription; verify B's mirror/rows are untouched and A's data never appears in B's view.
7. Assert enumeration safety: querying an unknown account returns 404 `not_linked` with no account-confirming body beyond the stable code.

---

## 10. Tests run this session (A3 verification)

| Suite | Result |
|---|---|
| `cloud/worker/test/netpulse-integration.test.ts` | 16/16 pass (cross-account isolation, out-of-order guard, idempotency, entitlement apply) |
| `workers/src/telegram/tests/netpulse-snapshot.test.ts` | 10/10 pass (compare semantics) |
| `cloud/worker/test/ops-page.test.ts` | ops snapshot rate limit + auth (fail-closed + timing-safe) — reviewed |

---

## 11. Exit-criterion answers

- Entitlement drift detection/correction proven e2e: **NO** — code present and unit-tested; `pushSnapshot` defect (DEFECT 1) weakens detection; live drift-repair e2e not demonstrated (no staging).
- Cross-account isolation: **VERIFIED** (unit + integration tests).
- Auth/authz: **VERIFIED** (HMAC, fail-closed, nonce replay protection).
- Non-2xx / state distinction: **PARTIAL** (handler correct; `pushSnapshot` misreads field-absent 2xx as in sync).
