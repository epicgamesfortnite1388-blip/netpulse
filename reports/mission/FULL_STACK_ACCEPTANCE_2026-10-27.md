# NetPulse full-stack acceptance — end-to-end workflow, step by step

**Mission:** `NETPULSE_FULL_STACK_IMPLEMENTATION`
**Date:** 2026-10-27 · **Repos inspected:** `E:\Code\Project\Vpn_app` (this repo),
`E:\Code\Project\Abystral` (Telegram commerce authority), host `206.1.96.89`.
**Verdict summary:** the paid-access chain is **proven end to end from the
entitlement onward** — credential issue → host provisioning → client connect →
real traffic → expiry/revocation removal → reconciliation. The **purchase** leg
(steps 3–6) is **BLOCKED**: neither repository contains a payment-provider
integration, and there are no sandbox credentials to test against.

> **Update, 2026-10-28 — the purchase leg now exists in code.** Abystral
> implements the Telegram **Stars (`XTR`)** lifecycle and its **26 tests** pass
> over the real webhook pipeline and real SQLite; NetPulse's suite is unchanged
> at 126/126. Steps 3–6 and the provider half of 16 are therefore **PASS against
> test doubles**, and step 16's recovery half is now proven through the real
> retry worker (paid order kept, one journal, one entitlement event). A real
> test-environment checkout and live merchant enablement remain **BLOCKED / NOT
> TESTED** on owner-side setup. Full evidence, the Phase 1 platform findings and
> the **NO-GO** decision:
> [STARS_PAYMENT_IMPLEMENTATION_2026-10-28](STARS_PAYMENT_IMPLEMENTATION_2026-10-28.md).
> The rows below are kept as the 2026-10-27 snapshot they were.

Verdicts use PASS / FAIL / BLOCKED / NOT TESTED, and every PASS names the file,
command or report that carries it. Nothing here is claimed from a successful
build alone.

---

## 1. Where each subsystem actually lives

| Subsystem | Location | State |
| --- | --- | --- |
| Control plane (auth, sessions, entitlements mirror, provisioning, ops) | [cloud/worker/src](../../cloud/worker/src) — `api.ts`, `netpulse-integration.ts`, `vpn-users.ts`, `vpn-config.ts`, `ops-vpn.ts`, `np-auth.ts`, `auth.ts`, `mail.ts` | working; **126 tests / 6 files pass**, `tsc --noEmit` clean |
| D1 schema | `cloud/worker/migrations/0001…0005` — users, sessions, `vpn_profiles`, `audit_events`, `np_links`, `np_events`, `np_entitlements`, `np_outbound_log`, plans | working; migrations replay in every worker test run |
| Identity, plans, wallet/ledger, subscription events | **`E:\Code\Project\Abystral`** (`workers/src/telegram`, migrations up to 0066 incl. `0061_netpulse_integration.sql`, `0065_ledger_double_entry.sql`) | ledger + idempotency present per that repo's own reports; **no payment gateway** |
| VPN data plane | host `206.1.96.89`: xray inbounds `vless-reality:443`, `vmess-ws:8443`, `vless-ws-tls:2053`, `trojan-tls:2087`; hysteria2 `userpass` | live, 5 published identities at 13:48Z |
| Host reconciler | [scripts/vps-sync-vpn-users.py](../../scripts/vps-sync-vpn-users.py) installed as `/opt/netpulse-sync/reconcile.py`, `netpulse-sync-vpn.timer` (60 s) | **updated today** (defect fix, §4) |
| Client (backend + UI) | [apps/api](../../apps/api), [apps/web](../../apps/web) | working; API suite 1098 passed / 2 pre-existing failures (adaptive routes) |
| Adaptive intelligence | [packages/shared/src/adaptive](../../packages/shared/src/adaptive), [apps/api/src/services/adaptiveEngine.ts](../../apps/api/src/services/adaptiveEngine.ts) | 14/14 acceptance criteria PASS incl. a field run on AS16322 — [ADAPTIVE_EVIDENCE](../adaptive/ADAPTIVE_EVIDENCE_2026-10-26.md) |
| WHITEDNS | [apps/api/src/services/whitednsService.ts](../../apps/api/src/services/whitednsService.ts), [packages/shared/src/schemas/whitedns.ts](../../packages/shared/src/schemas/whitedns.ts) | service + schemas + 12 DNS-recommendation tests; not part of today's live run |

## 2. The §13 workflow, step by step

| # | Step | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | User opens NetPulse | **PASS** | app/API/UI run locally; the account page, VPN shell and provisioning cards were driven in earlier cycles and today (`/api/v1/adaptive/status` answers on the live dev API) |
| 2 | Sees a real configured plan | **PASS** | plans live in D1 (`0004_admin_plans.sql`); `POST /api/v1/provision` builds configs from the plan's protocol list — `cloud/worker/test/provision.test.ts` asserts 6 protocols for an entitled plan |
| 3 | Initiates a **sandbox purchase** | **BLOCKED** → *2026-10-28:* **PASS (test doubles)**; real test-environment checkout **NOT TESTED** | no payment provider exists in either repo: `grep -riE "zarinpal|idpay|zibal|nextpay|nowpayments|cryptomus|stripe|\bXTR\b"` over Abystral's `src/` + 66 migrations returns **0**; this repo intentionally owns none ([ACCOUNTING_LIFECYCLE](../accounting/ACCOUNTING_LIFECYCLE_2026-10-24.md)). *Now:* Abystral orders + `XTR` invoice over the real pipeline — [STARS_PAYMENT_IMPLEMENTATION_2026-10-28](STARS_PAYMENT_IMPLEMENTATION_2026-10-28.md) §3 |
| 4 | Backend verifies the payment event | **BLOCKED** → *2026-10-28:* **PASS** (pre-checkout re-reads order/amount/buyer/expiry; `successful_payment` re-verified) | same dependency. What *does* exist and is tested is the **internal** signed event inbox (`np_events`, `NETPULSE_SERVICE_SECRET`, replay-protected) — `cloud/worker/test/netpulse-integration.test.ts` |
| 5 | Accounting records the payment once | **BLOCKED for payments**, PASS for the mirror → *2026-10-28:* **PASS** (one `xtr-sale:<order_ref>` journal per order) | Abystral's ledger + `UNIQUE(user_id, key)` idempotency per its own `reports/accounting/`; in this repo the mirror is single-write per event id (tested) |
| 6 | Subscription activated once | **PASS for the mirror** → *2026-10-28:* **PASS incl. provider duplicate** | duplicate/replayed `subscription.*` events do not double-apply (`netpulse-integration.test.ts`); the provider-duplicate case is untestable until §3 exists — *now covered by the guarded claim + partial UNIQUE charge index* |
| 7 | Provisioning job delivered securely | **PASS** | worker mints per-user credentials at `POST /api/v1/provision`; the host **pulls** `GET /api/v1/internal/vpn-users` with a bearer secret (`VPS_SYNC_SECRET`) — no inbound management port on the VPS |
| 8 | VPS creates the expected VPN access | **PASS (live)** | 5 published identities written into the four xray client lists + hysteria `userpass`; today's apply-mode proof rewrote a seeded real config and `xray -test` accepted it ([failure proof](RECONCILER_FAILURE_PROOF_2026-10-27.md) §3) |
| 9 | WHITEDNS entitlement applied where included | **PARTIAL** | service, schemas and 12 recommendation tests pass; the plan→WHITEDNS entitlement was not exercised in today's live run |
| 10 | Client receives the correct configuration | **PASS (live)** | earlier this session: provisioning returned 5 per-user configs, 4 imported as nodes, all four protocols dialled with the app's own cores |
| 11 | Adaptive AI selects an approved strategy | **PASS** | `quickConnectCore` → `adaptive.plan()`; asserted in `adaptiveConnect.test.ts`; field-measured on AS16322 |
| 12 | Client establishes a real tunnel | **PASS (live)** | xray 26.10.21 over the app's own SOCKS path: VLESS WS+TLS 858 ms, Trojan TLS 1092 ms, VLESS Reality 2453 ms, VMess WS 779 ms |
| 13 | External test traffic passes through the VPN | **PASS (live)** | real HTTPS requests fetched through each tunnel; exit IP read through the tunnel is what counts as success |
| 14 | DNS behaves as configured | **PARTIAL** | DNS classification + `dnsRecommendation` (12) and the leak/kill-switch suites pass (86 tests, §3); today's field run did not re-measure DNS on the ISP path |
| 15 | Status and telemetry reflect reality | **PASS** | "a working tunnel ≠ a completed handshake" is asserted (`active` without a verified exit IP is recorded as failure); the app's card states were read live during the repair proof |
| 16 | Duplicate payment event → no duplicate entitlements | **PASS for events**, BLOCKED for provider duplicates → *2026-10-28:* **PASS, provider duplicates included** | `netpulse-integration.test.ts` (replay/duplicate) + `provision.test.ts` (repeated click re-issues nothing new); Stars redelivery tests + `UNIQUE(telegram_payment_charge_id)` per the 2026-10-28 report |
| 17 | Expiry or revocation removes the expected access | **PASS (live)** | gate: `403 entitlement_expired` / `_not_active` / `_expiry_unreadable`, verified against production in [PROVISION_EXPIRY_GATE](../accounting/PROVISION_EXPIRY_GATE_2026-10-24.md); host: an already-expired identity is pruned locally even with the Worker unreachable (today's proof); revocation live: the host stopped carrying a rotated identity in **3.7 s** |
| 18 | Reconciliation restores correct state after a temporary provisioning failure | **PASS (new today)** | 47/47 checks on the live host (apply mode, real `xray -test`, live configs byte-identical) and 40/40 locally; found and fixed a real defect (§4) |

## 3. Commands and results (2026-10-27)

| Command | Result |
| --- | --- |
| `npm test -w @netpulse/cloud-worker` | **126 passed / 6 files** (re-run 2026-10-28 after the Stars work: still 126/126) |
| `npx vitest run tests/xtr-payments.test.ts` (Abystral, 2026-10-28) | **21 passed** — real pipeline + real SQLite (migrations 0001–0067); Bot API and panel stubbed |
| `npm run test:unit` (Abystral, 2026-10-28) | 3398 passed / 28 failed in 6 files — pre-existing SPA/broadcast failures in files modified before this cycle (unchanged by the Stars work) |
| `npm run typecheck -w @netpulse/cloud-worker` | clean |
| `python3 scripts/verify-vps-reconciler-failure.py` | **40/40** (local, `--print`) |
| `python3 scripts/verify-vps-reconciler-failure.py --apply --seed-xray … --live-guard …` on `206.1.96.89` | **47/47**, incl. real `xray -test` on the generated config and both live configs byte-identical afterwards |
| `python3 scripts/verify-vps-reconciler-removal.py` | **20/20** after the reconciler edit (no regression) |
| `systemctl show netpulse-sync-vpn.service -p ExecMainStatus -p Result` (after deploy) | `ExecMainStatus=0`, `Result=success`, log `applied source=cloud users=5 pruned=0 xray=same hysteria=same` |
| adaptive/dns/routing suites (this cycle) | 86 passed across `killSwitch`, `socksEgress`, `egressThroughProxy`, `nodeEndpointLeak`, `cloudEgressRoute`, `dnsRecommendation` |

## 4. Defect found by the new proof, and fixed

**The host cached a set it had refused to apply.** In `vps-sync-vpn-users.py`
(apply mode) the last-known-good cache was written *before* the xray validation
gate. A config that failed `xray -test` therefore still became the state the host
would fall back to during a Worker outage — a set the server had never received.
The new verifier caught it: `[FAIL] apply: the refusal wrote neither config nor
state cache (fail-closed)`.

Fix: the cache is written only after validation passes, immediately before the
files are rewritten. Re-proven afterwards: the same check passes on the host, the
removal verifier still passes 20/20, and the first production pass after deploy
is green.

Deployed: `install -m 700 -o root -g root` → `/opt/netpulse-sync/reconcile.py`,
md5 `1a444ffbadea7cea62a55d29598f48b5` (source and host identical).
Rollback: `install -m 700 /opt/netpulse-sync/reconcile.py.bak-2026-10-27 /opt/netpulse-sync/reconcile.py`.

## 5. Blockers (precise, not guessed)

1. **Payment provider — resolved in code on 2026-10-28, still owner-gated live.**
   Abystral now implements the platform-mandated Telegram **Stars (`XTR`)** flow
   (order → invoice → `pre_checkout_query` ≤10 s → `successful_payment` → ledger
   → subscription → provisioning → refund/expiry) with 21 passing tests. What
   remains **BLOCKED on owner action**: a real test-environment checkout (test
   bot + Stars balance + a human tapping Pay), confirmation that the target
   audience can buy Stars and that the owner can receive/redeem proceeds, and the
   deployed Worker accepting a signed `subscription.activated`
   (`NP_SERVICE_SECRET_FILE=…`). `XTR_ENABLED` stays unset until then, so no
   customer can be charged. Details and the go/no-go list:
   [STARS_PAYMENT_IMPLEMENTATION_2026-10-28](STARS_PAYMENT_IMPLEMENTATION_2026-10-28.md) §6.
2. **WHITEDNS live path** (step 9): the entitlement→DNS application was not part
   of today's host run; it needs a plan that includes WHITEDNS and a client
   session to observe.

## 6. What I did not do, and why

- No payment code was written: inventing a provider or a fake ledger would be
  worse than reporting the gap, and the brief forbids charging real customers as
  a test method.
- No worker changes: the control plane's suite is green and this cycle's work was
  the host side and its proof.
- The unit-restart half of the apply path was deliberately excluded from the
  host proof (`NETPULSE_*_UNIT=np-proof-noop-*`): bouncing the live VPN units is
  not a test, and the checks that matter — what is written, what is cached, and
  that the live configs are untouched — are asserted without it.
