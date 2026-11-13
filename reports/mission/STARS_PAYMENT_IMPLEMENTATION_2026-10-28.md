# Telegram Stars (XTR) payment leg — implementation, test evidence, go/no-go

**Mission:** `NETPULSE_PAYMENT_AND_FINAL_ACCEPTANCE` (phases 1–6)
**Date:** 2026-10-28 · **Repos:** `E:\Code\Project\Abystral` (commerce authority —
`workers/src/telegram`), `E:\Code\Project\Vpn_app` (control plane + evidence).
**Baseline:** [FULL_STACK_ACCEPTANCE_2026-10-27](FULL_STACK_ACCEPTANCE_2026-10-27.md)
(steps 3–6 and the provider half of 16 were **BLOCKED**: no payment provider
existed anywhere).
**Verdict summary:** the Stars lifecycle is **implemented and tested against the
real pipeline (code complete, PASS on mocks/test doubles)**; the parts that need
Telegram's servers, a real merchant account, or an owner-resident payout are
**BLOCKED / NOT TESTED**, and production checkout stays **disabled**
(`XTR_ENABLED` unset → the button is hidden and pre-checkout refuses). The
decision is **NO-GO for live payments** until §6's dependencies are met.

A second pass on the same day re-audited the recovery and replay edges and found
four real gaps (retry recovery never told NetPulse; a crash between the paid
claim and activation was silently ignored on redelivery; paid orders answered
identity/price checks after the duplicate branch; an exhausted paid Stars order
raised no alert). They are fixed in §4 items 5–8 and covered by the suite, now
**26/26**.

---

## 1. Why Stars, and what the platform actually requires (Phase 1)

Read from the official sources on 2026-10-28:

| Rule | Source |
| --- | --- |
| Digital goods sold **inside Telegram** must be paid in Telegram Stars (`XTR`); other currencies/providers are prohibited for bots *and* mini apps | [Bot Platform Developer Terms §6.2](https://telegram.org/tos/bot-developers#6-2-digital-goods-and-services), [Stars FAQ](https://core.telegram.org/bots/payments-stars) |
| `sendInvoice` with `currency: "XTR"`, empty `provider_token`, one price item | [payments-stars](https://core.telegram.org/bots/payments-stars) |
| `pre_checkout_query` must be answered within **10 seconds** or the transaction is cancelled | [answerPreCheckoutQuery](https://core.telegram.org/bots/api/methods/answerprecheckoutquery.md) |
| Deliver only after `successful_payment`; store `telegram_payment_charge_id` for refunds | [payments-stars](https://core.telegram.org/bots/payments-stars) |
| Refunds: `refundStarPayment` (full refund, no partial amount) | [refundStarPayment](https://core.telegram.org/bots/api/methods/refundstarpayment.md) |
| Live merchants must answer `/paysupport` and expose terms | [payments-stars live checklist](https://core.telegram.org/bots/payments-stars) |
| Recurring subscriptions exist but only via `createInvoiceLink` (`subscription_period` = 2,592,000 s = 30 days, ≤ 10,000 Stars/period) | [createInvoiceLink](https://core.telegram.org/bots/api/methods/createinvoicelink.md), [Bot API 8.0 changelog](https://core.telegram.org/bots/api-changelog.md) |
| Testing happens against Telegram's dedicated test environment (`https://api.telegram.org/bot<token>/test/METHOD_NAME`) | [payments-stars](https://core.telegram.org/bots/payments-stars) |

### 1.1 Findings that gate *live* payments (not code)

- **Buyer-side availability in Iran is NOT guaranteed.** Telegram's own Stars API
  documents a regional block flag: *"Clients should disable Telegram Stars
  support for the current user if the `stars_purchase_blocked` field is equal to
  true due to regional limitations."* ([core.telegram.org/api/stars](https://core.telegram.org/api/stars)).
  There is no official statement that Stars can be bought from Iran.
- **Payout/redemption for an owner in Iran is UNVERIFIED.** Developers are paid
  *"an equivalent of 0.013 USD worth of rewards for each Telegram Star"* and
  Stars may *"not become available for advertising credits or rewards for up to
  21 days"* ([Developer Terms §6.2.4](https://telegram.org/tos/bot-developers#6-2-4-rewards-for-stars)).
  Redemption flows through Fragment, whose terms allow country/service limits
  ([Fragment Terms](https://fragment.com/terms)); **no official source confirms
  an Iran-resident owner can redeem and withdraw**. The often-quoted 1,000-Star
  withdrawal minimum is not in the official sources I read.
- **Local-law risk, recorded not resolved.** Telegram does not ban VPN bots by
  category, but requires compliance with local law (§§5.2(h), 9). Third-party
  reporting (UK Home Office country note, April 2025) states VPN *sale* in Iran
  was criminalised and unlicensed VPN *use* was criminalised in Feb 2024. This is
  a compliance warning for the owner, not legal advice.
- **Consequence:** successful sandbox/tests prove the *software*, never that a
  customer can buy or that the owner can be paid. Both remain owner-gated.

---

## 2. What was built (Abystral `workers/src/telegram`)

| File | Role |
| --- | --- |
| [migrations/0067_xtr_payments.sql](../../../Abystral/workers/src/telegram/migrations/0067_xtr_payments.sql) | `xtr_orders` (integer `amount_xtr`, `CHECK currency='XTR'`, order-time price snapshot `usd_cents` + `xtr_usd_rate`) and `xtr_refunds`; **partial UNIQUE index on `telegram_payment_charge_id`** so a replayed `successful_payment` cannot be recorded twice |
| [src/db/xtr-repository.ts](../../../Abystral/workers/src/telegram/src/db/xtr-repository.ts) | Guarded state machine: `claimPaid` (single `UPDATE … WHERE telegram_payment_charge_id IS NULL AND status IN (…)`), `markInvoiced`, `cancelOrder`, `markRefunded`, `expireOrders`, `recordRefund` |
| [src/services/stars.ts](../../../Abystral/workers/src/telegram/src/services/stars.ts) | The lifecycle: pricing, order+invoice, pre-checkout validation, payment recording + activation, refund, cancel, expiry sweep |
| [src/accounting/ledger-core.ts](../../../Abystral/workers/src/telegram/src/accounting/ledger-core.ts) | `directSaleJournal` (Dr Cash / Cr Deferred revenue — **no wallet line**) + `directSaleReversalJournal` |
| [src/accounting/ledger-bridge.ts](../../../Abystral/workers/src/telegram/src/accounting/ledger-bridge.ts) | `mirrorXtrSale` / `mirrorXtrRefund`, idempotency keys `xtr-sale:<order_ref>` / `xtr-refund:<order_ref>`, XTR amount + rate in `rate_snapshot` |
| [src/bot.ts](../../../Abystral/workers/src/telegram/src/bot.ts) | `pre_checkout_query` + `message:successful_payment` handlers, `/paysupport` and `/terms` commands |
| [src/handlers/buy.ts](../../../Abystral/workers/src/telegram/src/handlers/buy.ts), [src/lib/keyboard.ts](../../../Abystral/workers/src/telegram/src/lib/keyboard.ts) | “⭐ Pay with Stars” on the plan screen (only when enabled and the plan is priced) → `buy:stars:<code>` → order + `sendInvoice` |
| [src/services/i18n.ts](../../../Abystral/workers/src/telegram/src/services/i18n.ts), [src/types.ts](../../../Abystral/workers/src/telegram/src/types.ts) | EN + FA strings; `XTR_ENABLED` (**fail-closed**) and `XTR_USD_RATE` |
| [tests/xtr-payments.test.ts](../../../Abystral/workers/src/telegram/tests/xtr-payments.test.ts) | 26 tests over the real webhook pipeline and the guard matrix |

### 2.1 The documented flow, implemented literally

1. **Order first, price fixed there.** `createStarsCheckout` writes a unique
   row with `amount_xtr = ceil(price_cents / 100 / rate)` (default rate 0.013 =
   Telegram's reward rate; configurable, **recorded per order**). The invoice is
   built from the row, never recomputed.
2. **Invoice.** `sendInvoice(currency='XTR', one price)`; the order turns
   `invoiced` with the invoice message id.
3. **Pre-checkout (≤10 s).** `validateStarsPreCheckout` re-reads the order and
   checks switch → currency → amount shape → payload prefix+UUID → existence →
   status → expiry → **buyer identity** → **amount equality with the recorded
   order** → plan still `is_active`. Every refusal is a user-readable reason.
   **It grants nothing and writes nothing.**
4. **`successful_payment`.** `recordStarsPayment` re-checks currency, amount,
   buyer and payload, then **claims** the order (guard UPDATE) — a redelivered
   charge is a no-op, a *different* charge on a paid order is refused loudly.
   Then: **one** ledger journal → subscription row (`pending_retry`) → provision
   → `active` + `subscription_id` on the order → **`subscription.activated`** in
   the same NetPulse outbox the wallet purchase uses → receipt with the
   subscription link.
5. **Failure keeps the money truth.** A panel failure leaves the order `paid`
   and the subscription `pending_retry`; the existing retry worker owns recovery
   (per `src/services/provision_queue.ts`: purchases provision synchronously
   with the retry cron as the fallback — the queue producer is deliberately dead
   code). The payment is never rolled back.
6. **Refund.** `refundStarsPayment` calls `refundStarPayment` (injected, so the
   provider call is explicit), then marks the order, writes an `xtr_refunds`
   row, posts a **reversing** journal, revokes the subscription and emits
   `subscription.refunded`. A provider refusal books nothing.
7. **Expiry.** Unpaid orders lapse (`expireStarsOrders` + `expires_at` checked at
   pre-checkout). A payment that still lands on a lapsed order is **honoured
   once** and logged as a late claim — the money was genuinely taken.

**Denomination discipline:** Stars are integer quantities in their own table
with a `CHECK currency='XTR'`. Nothing credits a wallet; the ledger’s single
base unit stays USD cents with the raw `amount_xtr` + rate in `rate_snapshot`.
Recurring Stars subscriptions (`createInvoiceLink` + `subscription_period`) are
**not implemented** — the product sells one-off plan periods, and recurring
billing would need its own period/cancellation lifecycle (noted, not built).

### 2.2 Entitlement contract trace (Phase 3)

There is **one** contract, already used by the wallet purchase; the Stars leg
calls the same emitter (`emitNetpulseSubEventByPanelEmail` → `NetpulseService`),
not a parallel webhook:

- **Outbox payload** — `{ eventId, eventType, version, occurredAt,
  telegramUserId, netpulseAccountId, payload }` where `payload.subscription` is
  `{ subscriptionId, planCode, status, startedAt, expiresAt, autoRenew,
  totalGb, usedGb, ipLimit, configUpdatedAt }` (`toEntitlement`).
- **Delivery** — `deliverOne` HMAC-signs `POST /api/internal/netpulse/v1/events`
  over the exact body with `NETPULSE_SERVICE_SECRET`; the Worker verifies the
  signature over the raw bytes **before** parsing, then checks timestamp skew and
  a single-use nonce (`np-auth.ts`).
- **Application** — `INSERT OR IGNORE np_events (event_id)` makes a replay a 200
  no-op; the entitlement upsert is guarded by `config_updated_at` so an older
  snapshot never regresses a newer one; the account is resolved from
  `np_links` and the event's `netpulseAccountId`, never from a client-supplied
  id; `link.revoked` clears the mirror. All of this is asserted in
  `cloud/worker/test/netpulse-integration.test.ts` (126/126 with the rest of the
  Worker suite).
- **Identity** — the order snapshots the linked `netpulse_account_id` at
  checkout; the emitter resolves the **current** active link by the bot user at
  delivery time, so a user who links after paying still receives the entitlement,
  and an entitlement is never written into another account's mirror.
- **Failure semantics** — the entitlement event is persisted **after** the
  authoritative commerce commit; a failed delivery stays in the outbox for the
  retry cadence, and commerce never rolls back because sync failed. A panel
  failure leaves the order `paid` for the retry worker, which now also emits the
  event on recovery (this cycle's fix).
- **Cross-repo primitive check** — `npx tsx tmp/verify-signature-contract.ts`
  imported the bot's signer primitives and the Worker's verifier primitives and
  compared them on three fixtures (ordinary event, path + query, non-ASCII JSON):
  body hash **match**, canonical string **match**, `CONTRACT OK`, exit 0. This
  does not replace a signed delivery to the deployed Worker, but it proves the
  two implementations cannot silently disagree on the signed bytes.

---

## 3. Test evidence (real vs stubbed, labelled)

| Command | Result |
| --- | --- |
| `npx vitest run workers/src/telegram/tests/xtr-payments.test.ts` (Abystral) | **26/26 PASS** — real `worker.fetch` → grammY → handlers → services → repositories → **real SQLite with the full migration chain (0001–0067)**, including the ledger's balance triggers |
| `npx vitest run tests/cron-retry-provisioning.test.ts tests/provisioning-stale-recovery.test.ts tests/money-path-event-sweep.test.ts` (Abystral) | **44/44 PASS** — the retry worker this cycle changed, plus the permanent-failure alert path |
| `npm test -w @netpulse/cloud-worker` (NetPulse) | **126/126 PASS** — signed inbox: HMAC over the exact body bytes, timestamp skew, single-use nonce, event-id dedupe, account isolation, older-snapshot guard |
| Abystral full `test:unit` | **not re-run this cycle.** The previous run was 3398 passed / 28 pre-existing failures in six unrelated SPA/broadcast files; this cycle touched none of them |
| `npm run typecheck` (Abystral) | **NOT RUN** — this workspace has no installed `node_modules`, and `npm run typecheck` resolves to a wrapper that exits 0 without invoking `tsc`. The earlier clean result is not re-asserted |

Both Abystral runs used the ad-hoc `npx vitest` (v5.0.5) because the package's pinned `^3` is not installed here. The suite passed unchanged; this is a tooling caveat, not a claim that CI's pinned runner was exercised.

**What the 26 tests establish** (each labelled by *what it runs*):

- *Real handlers + real SQL:* invoice is `XTR` with one price equal to the recorded
  order; the order is `invoiced`; **nothing** is granted at checkout or at
  pre-checkout (no subscription, no journal, no wallet movement).
- *Real handlers + real SQL + stubbed panel:* activation creates **one**
  subscription (`active`, sub id recorded), **one balanced journal**, and queues
  **one** `subscription.activated` NetPulse event with the order linked to the
  right NetPulse account.
- *Real handlers + real SQL:* a redelivered `successful_payment` provisions
  nothing again and answers “already processed”; a **different** charge for a
  paid order is refused and changes nothing.
- *Real handlers + real SQL:* if the first delivery claimed the order and died
  before activation, the next redelivery **repairs** it — one subscription, one
  journal, one event — and a further replay changes nothing.
- *Real SQL, guard matrix:* wrong currency / non-amount / foreign payload /
  disabled switch / **wrong user** / changed amount / unknown order / expired /
  cancelled / missing charge id / amount mismatch — all refused, with **zero**
  subscriptions and **zero** journals written. Buyer identity and amount are
  checked **before** the paid/duplicate branch, so a foreign buyer or changed
  amount is never answered as a benign duplicate.
- *Real SQL:* two orders for one buyer are two legitimate purchases (two
  subscriptions, two journals); a payment landing on an expired order is honoured
  once and the replay is a no-op; refunds call the provider exactly once, post a
  reversal (original journal untouched), revoke access, emit
  `subscription.refunded`, and refuse replays and unknown charges; a provider
  failure books nothing.
- *Real service + real SQL + the real retry cron, panel stubbed:* an injected
  provisioning failure leaves the order `paid` and the subscription
  `pending_retry`; the retry worker then provisions it, marks it `active`, and
  emits **exactly one** `subscription.activated` — without re-booking the sale.
- *Real service + real SQL:* concurrent deliveries of one charge produce one
  panel client, one subscription and one journal; an exhausted paid Stars order
  ends `failed_final` and leaves a **critical `wallet_anomaly` security event**.

**STUBBED, and therefore not proof of:** Telegram's own servers (the Bot API
transport is recorded/asserted) and the 3X-UI panel panel-client (the bot's
behaviour *around* the panel call is asserted). **No live Telegram
test-environment transaction was run** — see §6.

---

## 4. Defects found by this work (all fixed in the same cycle)

1. **The Stars handlers were unreachable.** grammY ends the middleware chain at
   a handler that does not call `next()`, and the placeholder
   `bot.on('message:successful_payment')` sat **after** the generic
   `bot.on('message')` fallback — so `successful_payment` was swallowed and the
   pre-existing stub could never have worked. The handlers (and `/paysupport`,
   `/terms`, which are text messages) now precede the fallbacks, with the
   ordering constraint documented in the file.
2. **“Already provisioned” mis-read the table default.** `createSubscription`
   returns the row with `status DEFAULT 'active'`, so a freshly created row
   looked provisioned: the order would have gone `active` with no panel client
   at all. The check now runs only on a row that existed **before** the call.
3. **Entitlement events were fire-and-forget**, contradicting the documented
   durable-by-commit discipline; activation and refund now await the outbox write
   (failures still absorbed).
4. A silently swallowed link-read (`.catch(() => null)`) now logs.

Hardening found on re-audit (2026-10-28, second pass over the whole leg):

5. **Recovery never synced the entitlement.** `cron/retry-provisioning.ts`
   marked a recovered subscription `active` but emitted no NetPulse event — in
   both the provisioned and the reconciled path. A Stars purchase whose first
   panel call failed would therefore work at the panel while the NetPulse
   account saw no plan. Both paths now emit `subscription.activated` through the
   same outbox emitter as the synchronous path.
6. **A crash between the paid claim and activation was silently ignored.**
   `successful_payment` redelivery on a `paid` order returned `duplicate` and
   did nothing, so a paid order with no subscription row (the process died
   between the two writes) could never be fulfilled — Telegram stops retrying
   after our 200. The duplicate branch now runs an idempotent repair: it re-posts
   the order-keyed journal and activates only when **no** subscription row exists.
   An `UNIQUE(panel_email)` conflict on a concurrent delivery is caught and left
   to the winner / retry worker, so two panel clients cannot be created.
7. **Paid orders answered identity/price checks late.** The `paid → duplicate`
   branch ran before the buyer and amount comparisons, so a delivery naming a
   paid order's charge id from a different account (or with a changed amount)
   could be answered as a harmless duplicate. Identity and amount are now
   checked first and refused.
8. **Exhausted provisioning of a paid Stars order raised no alert.** The
   money-path defeat sweep only recognised `buy:` payment refs, so an `xtr:`
   order that exhausted retries went `failed_final` silently. It now covers
   `xtr:` too and records the critical `wallet_anomaly` security event.

---

## 5. Acceptance matrix — the payment leg today

| # | Step | Verdict | Evidence |
| --- | --- | --- | --- |
| 3 | Initiates a purchase (sandbox) | **PASS (test doubles)** · real test-environment checkout **NOT TESTED** | §3 invoice/order tests; real checkout needs a test bot + a human to press Pay |
| 4 | Backend verifies the payment event | **PASS** | pre-checkout re-reads the order (currency, amount, buyer, status, expiry, plan) and refuses wrong user/amount/payload |
| 5 | Accounting records the payment once | **PASS** | one journal per order (`xtr-sale:<order_ref>`), balanced by the DB trigger; replay writes nothing |
| 6 | Subscription activated exactly once | **PASS** | one subscription row per order; duplicate delivery is a no-op or a bounded repair; provisioning failure keeps the paid order |
| 16 | Duplicate payment event → no duplicate entitlements | **PASS (provider duplicate and concurrent delivery included)** | redelivery/concurrency tests + partial UNIQUE charge index + guarded claim + `UNIQUE(panel_email)` activation guard |
| — | Injected provisioning failure → retry recovery | **PASS (test doubles)** | real retry worker: order stays `paid`, journal posted once, subscription becomes `active`, one entitlement event |
| — | Paid order exhausts retries | **PASS** | `failed_final` + critical `wallet_anomaly` security event naming the panel email and payment ref |
| — | Refund | **PASS at service level**; **NOT WIRED** to an admin command | `refundStarsPayment` tests incl. provider refusal |
| — | Expiry | **PASS** | sweeper + pre-checkout refusal + honoured late claim |
| — | NetPulse entitlement from a Stars payment | **PASS (outbox + Worker contract)**; accept by the **deployed** Worker **BLOCKED** | event written by the same emitter the wallet purchase uses; the Worker suite proves signed events are HMAC-verified, replay-proof and applied idempotently; the deployed accept still needs the write-only `NETPULSE_SERVICE_SECRET` |
| — | WHITEDNS entitlement (Phase 5) | **BLOCKED** | the Worker test proves it is withheld (no DNS config; `skipped: no_per_user_identity`), so nothing can silently claim it; a per-user DNS identity needs panel access and is not delivered |

---

## 6. Production-readiness decision (Phase 6)

| Dimension | State |
| --- | --- |
| Code complete | **YES** (Stars lifecycle, guards, tests) |
| Sandbox/test-double integration | **PASS** — real pipeline over real SQLite; Bot API and panel stubbed |
| Real Telegram test-environment payment | **NOT TESTED** — needs a test bot token + a Stars balance + a human to tap Pay |
| Customer-side payment availability (Iran) | **UNVERIFIED** — Telegram documents a regional `stars_purchase_blocked` flag; nothing official says Iran buyers can buy |
| Merchant payout/redemption | **UNVERIFIED** — 0.013 USD/Star, up-to-21-day hold, Fragment may restrict countries; no official confirmation for an Iran-resident owner |
| Terms/refund operation | Code supports full refunds + `/paysupport` + `/terms`; the **business** procedures behind them are the owner's to define |
| Local-law exposure | Recorded, unresolved by us (VPN sale/use criminalised in Iran per third-party reporting) |
| Production configuration | **Not set** — `XTR_ENABLED` is unset, so checkout is hidden and pre-checkout refuses (fail-closed) |
| Provisioning-failure recovery | **PASS in tests** (real retry worker, stubbed panel); live panel **NOT TESTED** |
| Production payment actually taken | **NOT TESTED** |

**Decision: NO-GO for live payments.** Keep `XTR_ENABLED` unset. To convert to
GO, in this order:

1. **Owner:** confirm the target audience can buy Stars and that the owner account
   can receive/redeem/withdraw (test the real purchase route; check Fragment
   eligibility), and settle the local-law/compliance question.
2. **Test-environment checkout** (needs 1 + a test bot + a Stars balance): run
   invoice → pre-checkout → `successful_payment` against Telegram's test server
   with this code and attach the transcript.
3. **Deployed entitlement leg:** one signed `subscription.activated` event
   accepted by the deployed NetPulse Worker (`NP_SERVICE_SECRET_FILE=…`), then a
   Stars purchase driving a real provisioned credential and a working tunnel.
4. Only then set `XTR_ENABLED=true` on the deployment, with `/paysupport`
   staffed and a refund procedure agreed.

**After a go decision**, everything independent of owner credentials is already
done: prices, orders, idempotency, ledger, provisioning hand-off, expiry,
refunds at service level, i18n, and the tests that prove them.

---

## 7. What this report does NOT claim

- No real Stars payment was made; no real Telegram invoice was paid. The Bot API
  was stubbed in every test.
- The panel was stubbed in the activation tests: “a working tunnel from a Stars
  purchase” is **NOT TESTED** (the wallet-purchase tunnel path is proven
  elsewhere — [PER_USER_CREDENTIAL_LIVE_PROOF](../accounting/PER_USER_CREDENTIAL_LIVE_PROOF_2026-10-25.md)).
- Iranian buyer availability and owner payout eligibility are **unverified**;
  nothing here should be read as “customers in Iran can pay”.
- The full Abystral suite has 28 pre-existing failures in six unrelated SPA/queue
  files; they were not introduced by this work and were not repaired here, and
  the full suite was **not re-run** in the second pass.
- No typecheck is claimed for the second pass: dependencies are not installed in
  this workspace, so `tsc` did not actually execute.
- Live WHITEDNS issuance is not delivered: its per-user identity does not exist,
  and the product withholds it rather than sharing a tunnel identity.
