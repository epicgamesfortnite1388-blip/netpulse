# NetPulse mission journal

Mission: `NETPULSE_AUTONOMOUS_V1`. This file is the durable state between
cycles. Times UTC unless stated. No secrets are recorded here.

## 2026-11-02 UTC — cycle: Mission Control surface, carried-forward failures closed

Full evidence: `reports/mission/MISSION_CONTROL_2026-11-02.md` (+ `.json`).

- **Both failures carried since 2026-10-27 are fixed, and both were real defects.** The
  `routeWiring` failure was a ternary inside a fetch template (`/adaptive/status${nodeId ? …`)
  that the gate normalized into a path no route could match — the request itself was fine,
  the gate was blind to the file. The `httpSemantics` failure was two hand-written error
  bodies in `routes/adaptive.ts` that the client drops, so the UI showed "Not Found"
  instead of the reason; both now use `replyApiError()`.
- **Mission Control shipped**: `GET /api/v1/mission/status` (`services/missionControl.ts`)
  and a `/mission` page. Every subsystem row carries an evidence class — verified /
  observed / not_tested / unavailable / blocked — and the overall state is the WEAKEST
  class present, so a blocked row cannot hide behind verified ones. Read-only: the
  endpoint never connects, scans, provisions or revokes. 6 regression tests pin the
  classification rules, including "a fresh process says not_tested, never verified" and
  "no daemon token in the snapshot".
- **Checks:** API **1113/1113** (103 files), web **461/461** (51 files), both typechecks
  clean, eslint clean on every touched file, web build pass.
- **NOT done this cycle, and not claimed:** no new live tunnel, no Iranian-ISP field run,
  no host reconciliation (SSH still lost), no WHITEDNS data-plane test, no payment test,
  no research sweep, no packaged desktop build, no deployment.

## 2026-10-28 UTC (second pass) — cycle: Stars recovery/replay hardening, Phase 3 re-audit

Report updated: `reports/mission/STARS_PAYMENT_IMPLEMENTATION_2026-10-28.md` (§3–§5).

- **Three real defects found in the existing Stars leg and fixed in Abystral**
  (`workers/src/telegram`):
  1. `cron/retry-provisioning.ts` recovered a paid subscription to `active` but
     never emitted `subscription.activated` — in either the provisioned or the
     reconciled path. A Stars purchase whose first panel call failed would work
     at the panel but be invisible to NetPulse. Both paths now emit through the
     same outbox emitter, and the permanent-failure alert now also recognises
     `xtr:` payment refs (an exhausted paid Stars order previously failed
     silently).
  2. A redelivery after the paid claim committed but before activation was
     answered `duplicate` and did nothing, so that crash window left a paid order
     permanently unfulfilled (Telegram stops retrying after our 200). The
     duplicate branch now runs an idempotent repair (order-keyed journal, only
     when no subscription row exists), with `UNIQUE(panel_email)` conflict
     handling so concurrent deliveries cannot create two panel clients.
  3. Buyer/amount checks ran AFTER the paid/duplicate branch, so a foreign buyer
     or a changed amount naming a paid order's charge id could be answered as a
     benign duplicate. Both checks now run first and are refused.
- **Tests:** `npx vitest run workers/src/telegram/tests/xtr-payments.test.ts`
  → **26/26** (real webhook → grammY → services → repositories → SQLite
  0001–0067; Bot API and panel stubbed). New coverage: crash-window repair,
  concurrent same-charge deliveries, foreign buyer/changed amount on a paid
  order, injected panel failure recovered by the real retry cron (one
  subscription, one journal, one entitlement event), and exhausted retries →
  `failed_final` + critical `wallet_anomaly`.
- **Adjacent suites:** `cron-retry-provisioning` + `provisioning-stale-recovery`
  + `money-path-event-sweep` → **44/44**. NetPulse Worker → **126/126**
  (HMAC over exact bytes, skew, nonce, event-id dedupe, account isolation,
  older-snapshot guard).
- **Not re-run:** Abystral full `test:unit` (previously 28 unrelated pre-existing
  failures) and `typecheck` (this workspace has no installed `node_modules`;
  the npm wrapper exits 0 without invoking `tsc`). Neither is claimed clean.
- **Decision unchanged: NO-GO for live payments**, `XTR_ENABLED` unset. Owner
  gates remain: Stars availability for Iranian buyers, payout/redemption
  eligibility, local-law position; then a real test-environment checkout, a
  deployed Worker accepting a signed `subscription.activated`, and a Stars
  purchase driving a provisioned tunnel. WHITEDNS remains **BLOCKED**
  (`no_per_user_identity`; withheld fail-closed, no DNS config issued).

## 2026-10-28 UTC — cycle: Telegram Stars payment leg implemented in Abystral, tested, go/no-go filed

Full evidence: `reports/mission/STARS_PAYMENT_IMPLEMENTATION_2026-10-28.md` (implementation,
platform-rule sources, test matrix, no-go list). Baseline: `FULL_STACK_ACCEPTANCE_2026-10-27.md`
(steps 3–6 BLOCKED: no provider).

- **Phase 1 (platform rules, read from the official docs):** digital goods sold inside Telegram are
  Stars-only (`XTR`, empty `provider_token`) per the Bot Developer Terms §6.2; `pre_checkout_query`
  has a 10 s answer deadline; `telegram_payment_charge_id` must be stored for `refundStarPayment`;
  live merchants must answer `/paysupport` and publish terms; recurring Stars billing exists but only
  through `createInvoiceLink` (`subscription_period`, 30 d, ≤10,000 Stars). **Owner-gated findings:**
  Telegram documents a regional `stars_purchase_blocked` flag (so Iranian buyer availability is
  unverified), and no official source confirms an Iran-resident owner can redeem/withdraw via
  Fragment (0.013 USD/Star, up-to-21-day hold). Third-party reporting (UK Home Office country note)
  puts VPN sale/use in Iran in criminal-law territory — recorded as a compliance warning.
- **Implemented in `E:\Code\Project\Abystral\workers\src\telegram`:** migration 0067
  (`xtr_orders`, `xtr_refunds`, integer XTR, `CHECK currency='XTR'`, partial UNIQUE on
  `telegram_payment_charge_id`), `db/xtr-repository.ts` (guarded claim/status machine),
  `services/stars.ts` (order+invoice, pre-checkout validation, payment recording, refund, expiry),
  direct-sale journals in `accounting/ledger-core.ts` + mirror in `ledger-bridge.ts`,
  `bot.ts` handlers, `/paysupport` + `/terms`, buy-screen button, EN+FA strings,
  `XTR_ENABLED` (fail-closed). Regression suite: `tests/xtr-payments.test.ts`.
- **Tests: 21/21 pass** over the real `worker.fetch` → grammY → services → repositories → real
  SQLite with the full migration chain. They prove: nothing is granted at checkout; one
  subscription + one balanced journal per order; replay is a no-op; wrong user/amount/payload/
  currency/expired/cancelled/unknown are refused with zero writes; two orders are two purchases; a
  late payment on an expired order is honoured once; refunds call the provider once, reverse the
  journal, revoke access and emit `subscription.refunded`; provisioning failure keeps the paid order.
  Abystral full suite 3398 passed / 28 pre-existing failures (SPA/broadcast files changed before this
  cycle); typecheck clean; **NetPulse worker suite re-run: 126/126**.
- **Real defects found and fixed by the tests:** the Stars handlers sat *after* the generic `message`
  fallback (grammY stops there, so `successful_payment` was swallowed — the pre-existing stub could
  never have fired); `createSubscription` returns the `DEFAULT 'active'` row, so the
  "already provisioned" check would have activated orders with no panel client; activation/refund
  NetPulse emits were fire-and-forget (now awaited, matching the durable-by-commit discipline); one
  silent `.catch(() => null)` link read.
- **Decision: NO-GO for live payments; `XTR_ENABLED` stays unset** (checkout hidden, pre-checkout
  refuses). To go live, in order: owner confirms Stars purchase availability for the audience and
  payout eligibility + resolves the local-law question → a real test-environment checkout (test bot,
  Stars balance, human tapping Pay) → the deployed Worker accepting a signed `subscription.activated`
  (`NP_SERVICE_SECRET_FILE=…`) and a Stars purchase driving a provisioned credential and a working
  tunnel → then enable. **NOT TESTED:** any real Telegram payment, the panel provisioning inside the
  Stars tests (stubbed), WHITEDNS entitlement from a Stars purchase.

## 2026-10-27 UTC — cycle: provisioned credential rotated live, VPN surface repaired it

Full evidence: `reports/engines/03_PROVISIONED_CREDENTIAL_LIVE_REPAIR.md`. Harness:
`scripts/proof-provision-repair-live.ts` (setup/baseline/stale/verify/cleanup).

- **The whole loop ran against the deployed Worker and the live host, not a fake:** app sign-in →
  per-user credential for a disposable pro entitlement → the app's own xray core carried traffic
  through 4 protocols (VLESS WS+TLS 858 ms, Trojan 1092 ms, VLESS Reality 2453 ms, VMess WS 779 ms)
  → credential revoked server-side → **host stopped carrying the identity in 3.7 s** (second
  rotation 1.8 s, window ≤60 s) → all three profiles failed authentication → the VPN page showed
  "3 to check / failing now" → **one click replaced the stored credential (`credentialsUpdated: 4`)**
  → probes passed again (3/3: 2572 / 764 / 5775 ms; VMess 929 ms) and `consecutiveFailures` returned
  to 0. Disposable account deleted afterwards; the host returned to its pre-test identity set in
  1.9 s and the user's own account was never touched.
- **Two defects in the probe path found and fixed:** `findEngineBinary` never looked in the engine
  manager's own install directory (so a core installed through the app reported
  `available:false` next to its own version string, and every proxy test said "no core installed"),
  and the bulk runner announced only shared groups (so single-path nodes — Hysteria 2 always — were
  probed and then reported nowhere, `POST /nodes/test-batch` returning `{}`). 65 focused tests pass.
- **Open, reported not fixed:** a provisioned VMess profile loses the `NetPulse · ` marker (the
  parser reads `ps` as a host fallback, never as a name), so the repair card cannot list it even
  though a refresh still replaces its credential; and the card's immediate probe races the host's
  ≤60 s publish window, so a successful repair can read "0 of 3 now carry a probe".
- **NOT TESTED:** `POST /api/v1/ops/vpn/rotate` itself (the only `OPS_TOKEN` on this workstation is
  the value the 2026-09-30 audit revoked; the revocation step here was a direct D1 delete plus the
  product's own re-issue path) and Hysteria 2 dialing (no Hysteria client installed; a node link
  cannot carry its obfuscation settings). Two pre-existing API-suite failures remain in the adaptive
  routes (`adaptive.ts` hand-written error bodies, `AdaptiveRecoveryCard` fetch path): 1098 passed,
  2 failed, unrelated to this cycle's files.

## 2026-10-27 UTC — cycle: full-stack acceptance + reconciler failure proof

Mission `NETPULSE_FULL_STACK_IMPLEMENTATION`, first cycle. Report:
`reports/mission/FULL_STACK_ACCEPTANCE_2026-10-27.md`; proof:
`reports/mission/RECONCILER_FAILURE_PROOF_2026-10-27.md`; raw transcripts in
`reports/mission/evidence/`.

- **The paid chain is proven from the entitlement onward:** credential issue →
  host provisioning (5 published identities, four xray inbounds + hysteria2) →
  client connect (four protocols carrying real traffic) → expiry/revocation
  removal (a rotated identity left the host config in 3.7 s) → reconciliation
  after a temporary failure (**47/47** on the live host).
- **The purchase leg is BLOCKED, precisely.** Neither this repo nor Abystral
  (`E:\Code\Project\Abystral`, the Telegram commerce authority, 66 migrations)
  contains a payment-provider integration — no gateway name appears in its
  source. Missing: a provider account with sandbox credentials plus the bot-side
  invoice and verification wiring. Nothing was invented to hide the gap.
- **Real defect found and fixed in the host reconciler.** In apply mode the
  last-known-good cache was written *before* the xray validation gate, so a
  rejected config still became the fallback state. Now written only after
  validation; deployed (md5 `1a444ffb…`, backup `reconcile.py.bak-2026-10-27`),
  first production pass green (`applied source=cloud users=5 pruned=0`,
  `ExecMainStatus=0`).
- **Checks run this cycle:** worker **126/126** + `tsc --noEmit` clean; new
  failure verifier **40/40** local and **47/47** on the host (apply mode, real
  `xray -test`, both live configs byte-identical); removal verifier **20/20**
  after the edit; **86** DNS/routing/leak tests green.

## 2026-10-27 UTC — cycle: adaptive field measurement on a real Iranian access network

Mission `NETPULSE_ADAPTIVE_INTELLIGENCE`, field phase. Evidence:
`reports/adaptive/ADAPTIVE_EVIDENCE_2026-10-26.md` (§2, new subsection),
`reports/adaptive/RAW_PATH_IR_ISP.txt`; corpora `REPLAY_LIVE_IR_ISP.json`,
`REPLAY_LIVE_IR_ISP_RUN2.json`, `REPLAY_LIVE_TUNNEL_CONTROL.json`.

- **Measured on the real thing.** The same 15-link corpus, dialled out of this
  machine **through the ISP itself** — two `ActiveStore` /32 host routes
  (`scripts/rawpath-bypass.ps1`) bypassed the user's Happ tunnel for the corpus
  host and one IP echo while the tunnel kept the default route. Egress proven
  `ip=46.167.134.165 loc=IR`, holder **AS16322 Parsan Lin Co. PJS, Tehran**.
- **Replay verdicts: PASS in both field runs.** Baseline reached a working core
  on 8/15 (53.3%) and 10/15 (66.7%) episodes; adaptive equal on both, first-try
  40.0% → **46.7%** in run 1 with 1 win / 0 losses and 8 → 7 wasted attempts.
- **Same-hour control** (bypass removed, identical corpus through the tunnel):
  80% baseline, exact parity with adaptive — so that 80% is a property of the
  tunnelled path, not of the cores.
- **The old `xray 0/15` did not reproduce** on either path (13/15 through the
  tunnel, 13/15 on the ISP path two minutes apart). The recorded-corpus
  improvement figure stays corpus-specific; §5 says so.
- **Field finding worth keeping:** this ISP filters **intermittently per port**
  (2053 stalled at 13:07Z while 443/2087/8443 answered; 443 stalled at 13:15:47Z
  while 2053 answered in 69 ms). That is the environment the policy exists for,
  and the reason a single measurement settles nothing.
- **Machine restored:** routes removed (verified egress back to
  `83.229.87.141`), marker file deleted, tunnel never stopped.
- **Two acceptance criteria closed in the same cycle.** Criterion 7 went from
  PARTIAL to **PASS**: the six pre-existing DNS/routing/leak suites were re-run
  — `killSwitch` 29, `socksEgress` 11, `egressThroughProxy` 5,
  `nodeEndpointLeak` 22, `cloudEgressRoute` 7, `dnsRecommendation` 12 — **86
  tests, 0 failed**. Criterion 11 went from PARTIAL to **PASS (measured)**: new
  [bench-adaptive-cost.ts](../../scripts/bench-adaptive-cost.ts) drives the
  shipped policy to its maximum state (32 contexts × 8 strategies = 256 entries,
  200 observations, 79 481 B persisted) and measures `rankStrategies` p50 4.0 µs
  / p95 6.8 µs, `applyObservation` 54.9 / 70.7 µs, startup decode 320 / 444 µs,
  120 KiB retained heap (forced GC), +27 B per observation at the cap, 0 network
  calls — [ADAPTIVE_COST.json](../../reports/adaptive/ADAPTIVE_COST.json).

## 2026-10-26 UTC — cycle: adaptive connectivity intelligence

Mission `NETPULSE_ADAPTIVE_INTELLIGENCE` implemented and verified as far as this
machine allows. Full evidence: `reports/adaptive/ADAPTIVE_EVIDENCE_2026-10-26.md`;
raw corpus: `reports/adaptive/REPLAY_LIVE_REALITY.json`.

- **Shipped in the working tree (not deployed):** pure policy core
  (`packages/shared/src/adaptive`), engine service + Ed25519 trust anchor
  (`apps/api/src/services/adaptive*`), connect-path integration in
  `quickConnectCore`, adaptive routes (`/adaptive/status|plan|reset|policy`), VPN
  UI card with learned strategies and **clear local learning data**, and a replay
  harness (`scripts/bench-adaptive-replay.ts`).
- **Measured:** a real local Xray REALITY server + the machine's real cores via
  the app's own probe path — 24 real attempts, 12 comparable episodes. Baseline
  and adaptive both reached a working core 100% of the time on the first core
  tried (p50 933 ms, p95 1045 ms). **Parity, no regression**; superiority is
  **NOT TESTED** because no corpus available here has a first-in-fixed-order core
  that fails while another works (the app's public node list carried no traffic
  in 24/24 attempts).
- **Two real defects found by the new tests and fixed:** `plan()` compared engine
  ids against strategy ids, so a fresh install would have been reordered
  alphabetically; and a failed learned core abandoned the node instead of trying
  one more approved core.
- Exploration remains **off by default**; policy updates are refused unless a
  pinned signing key is configured (this build ships none).
- Re-open for measurement, not implementation: criterion 12 (baseline vs
  adaptive benefit) needs a differentiating corpus — real Iranian access
  networks, or a controlled staging path where one transport is blocked and
  another passes. `NODES_FILE=<share links>` is the entry point.

## Current state (2026-10-26 UTC)

Cycle close-out below the 2026-10-25 table: the auto-import product item is
finished, and WhiteDNS issuance is now withheld on purpose (guarded by a test)
because its tunnel identity is still shared. Both are recorded here so no later
cycle re-opens them by accident.

- Cloud Worker `netpulse-cloud`: version `ce129ba7-2dd2-43ee-bfae-8fc7c0b83846`,
  100% traffic (per-user VPN credentials + `/api/v1/internal/vpn-users`).
- D1 `netpulse-cloud`: migrations 0001–0005 applied, no pending. Live data:
  22 users, 0 `vpn_credentials` (no active user has re-provisioned yet),
  1 active entitlement, 26 non-deleted profiles.
- Host reconciler `/opt/netpulse-sync/reconcile.py` installed, timer every 60 s,
  `source: cloud`, applying to `/opt/netpulse-xray/config.json` and
  `/opt/netpulse-hysteria/config.yaml`. Current set: deny-all (correct: no
  entitled account holds a credential).
- VPN host `206.1.96.89`: Xray (Reality :443, VMess-WS :8443, VLESS-WS+TLS :2053,
  Trojan-TLS :2087, SS2022 :8388), Hysteria 2 (:8443/udp), x-ui, microsocks
  (`127.0.0.1:18080`) all active. Credentials rotated this cycle.
- `plan_pro.default_profiles` now lists the six protocols that exist on the
  server (was `[]`, so provisioning previously produced nothing).
- **SSH access to the VPN host is lost from this workstation.** As of
  2026-10-26 the audit box has no key that authenticates on `206.1.96.89:22`
  (root/ubuntu/
  netpulse/admin/debian all `Permission denied (publickey)`), the `abyssal-*`
  aliases point at another host (`153.52.92.193`) whose key file is missing, and
  the untracked `VPS-KEYS.txt` earlier cycles used is gone. Anything that must
  run *on* the host is BLOCKED until a key is supplied; repository-side work
  continues and is not blocked by this.
- Worker secrets hold the shared server credentials (`VPN_*`), not source.
- Worker tests: 126/126 pass and `tsc --noEmit` clean (re-run 2026-10-26).
  Live D1/host figures above are as observed 2026-10-25 and were not
  re-queried this cycle; do not treat them as a fresh reading.

## Done this cycle (with evidence)

| Item | Evidence |
|---|---|
| Public 8080 test server contained | Port closed on host; check-host DE/IR refuse |
| All VPN credentials rotated | `xray -test` valid; six protocols, real client, egress 206.1.96.89 |
| Worker no longer embeds credentials | 7 Worker secrets set; bundle grep clean |
| Reality profiles actually connect | Stale public key replaced with server-derived key; provisioned config connects |
| Hysteria profiles actually connect | SNI pinned to `206-1-96-89.sslip.io`; QUIC handshake succeeds |
| `/provision` idempotent | Repeat call 200 in prod; regression test added |
| Unreachable SOCKS profile removed | Source has no loopback profile; tests green |
| Test account/data removed | 0 `rotatecheck+%` users in D1 |
| Signed inbox leg (rejection paths) | Production 5/5 via `scripts/verify-signed-inbox.mjs` |
| Signed inbox accept + replay | 8/8 on workerd with a real 32-byte secret; 96/96 suite |
| Accepted event, idempotency, replay | 4/4 local smoke; 1 D1 row per eventId, 0 entitlements |
| Webview external exits | middle-click, drag-drop, raw anchors closed; 18 tests + Chromium run |
| Provision expiry gate fixed | real datetime strings were never parsed; prod `403 entitlement_expired`, future `200`/6 protocols |
| Provisioned configs auto-import (2026-10-26) | `apps/web/src/lib/cloud/provisionProfiles.ts` maps each issued config to a sing-box outbound and POSTs `/vpn/profiles` with `replace`; `VpnProfilesCard` refreshes on open, so a renewal (or the post-rotation re-download) leaves the local list holding the identity the server actually accepts. 11 tests in `apps/web/test/provisionProfiles.test.ts`, including a refusal to import a config with no credential. |
| WhiteDNS withheld, guarded (2026-10-26) | `whitedns-soar` has no per-user identity, so `/provision` returns `skipped: no_per_user_identity` and never emits the delegated zone or its public key. Pinned by a new test in `cloud/worker/test/provision.test.ts` (17/17). |
| Copy-config toast no longer prints an HTML entity (2026-10-26) | The Account page passed `&rsquo;` inside a JS string, so the toast read "app&rsquo;s". Fixed in `AccountPage.tsx`. |
| Reconciler really REMOVES a rotated identity (2026-10-26) | new `scripts/verify-vps-reconciler-removal.py` runs the real reconciler in `--print` mode against a sandbox config: rotated secret, revoked identity, past-`expiresAt` identity. 20/20 checks in three configurations (local seed, `--from-live` host-shaped, `--from-live` deny-all); diff shows the old UUID/password replaced and the revoked user deleted, `clients` arrays replaced not merged, retired `ss2022` inbound untouched, and both files byte-identical afterwards. See `reports/accounting/VPS_RECONCILER_REMOVAL_DRYRUN_2026-10-26.md` |
| Per-user credentials proven live (2026-10-25) | disposable account: 5 protocols provisioned; REALITY/VMess/VLESS-WS-TLS/Trojan/Hysteria2 all reached egress `206.1.96.89`; expiry → `403`, identity removed ≤60 s, old config refused (curl exit 35); all test rows cleaned. See `reports/accounting/PER_USER_CREDENTIAL_LIVE_PROOF_2026-10-25.md` |

## Backlog (next cycles, highest value first)

1. **Signed bot↔Worker event leg — only the production ACCEPT step is blocked.**
   Production now proven for all rejection paths (5/5: unsigned, wrong key,
   replayed nonce, stale timestamp, wrong target) and the full accept+replay
   round trip passes 8/8 on workerd with a real 32-byte secret; suite 96/96.
   The accepted-event/idempotency/replay smoke now exists too
   (`node scripts/smoke-signed-event.mjs`, loopback-only by design). Remaining:
   one signed event accepted by the *deployed* worker, which needs the write-only
   `NETPULSE_SERVICE_SECRET` value:
   `NP_SERVICE_SECRET_FILE=<path> node scripts/verify-signed-inbox.mjs`.
   See `reports/infra/SIGNED_INBOX_VERIFICATION_2026-10-24.md`.
2. **Per-user VPN credentials — DONE, live-proven (see above); removal half
   now checkable without the host.** `scripts/verify-vps-reconciler-removal.py`
   asserts the rotated/revoked identity leaves the config the reconciler would
   write (20/20). Re-running it on `206.1.96.89` for the live configs is blocked
   on SSH access (see Current state), not on anything in the repo.
   `reports/accounting/PER_USER_CREDENTIAL_LIVE_PROOF_2026-10-25.md`.
   New migration risk: the 26 pre-existing profiles carry the retired shared
   credential and the server is deny-all, so current subscribers must
   re-provision. **Closed 2026-10-26:** the Account page imports the refreshed
   configs into the local profile list (`provisionProfiles.ts`), so one visit
   to Account repairs a stale profile. What remains is only the notice for
   users who never open Account — not built, tracked below.
3. **Payments/accounting lifecycle (BLOCKED on provider sandbox credentials).**
   No live payment provider is configured; the plan/entitlement mirror and
   expiry checks are implemented and unit-tested.
4. Desktop client real-connection proof on Windows: needs TUN/WinTun driver and
   elevation; server side is proven.
5. WHITEDNS entitlement gating — **HALF CLOSED, remainder BLOCKED.** Issuance
   is now withheld (`no_per_user_identity`), so no plan can hand out the shared
   tunnel and no expired account can keep using it through us. Turning that
   into a real entitlement needs per-user Soar accounts created and revoked at
   the panel (loopback-only, SSH tunnel), i.e. panel API access. Until then
   WhiteDNS is not a delivered feature, and nothing in the UI claims it is.
6. UI E2E for purchase → provision → connect (depends on 3).7. Tauri-level navigation backstop — **IMPLEMENTED, unit-verified 2026-10-26.**
   The window is created in Rust (`window.rs`) so the builder can carry
   `on_navigation` / `on_new_window`; `navigation.rs::classify` is the single
   pure policy (in-app document, external https handed to the OS, everything
   else refused, no second webview ever). `cargo test navigation --offline`:
   12/12 pass. **The real-webview test now RUNS and PASSES (2026-10-26):**
   `tests/navigation_webview.rs` through tauri-driver against the built binary
   with an msedgedriver matching WebView2 155.0.4283.62 — 1/1 ok in 6.5 s. It no
   longer stops at "where did the window end up": a blocked external navigation
   must also prove the OS was asked to open the URL. That evidence became DATA
   on 2026-10-27: the app appends one JSON object per handoff (URL, layer,
   spawn outcome) to the file `NETPULSE_HANDOFF_RECORD` names — unset in every
   normal run — and the same session also clicks a raw anchor to prove the
   in-page guard in `externalNavigation.ts`, not the Rust backstop, handed that
   URL over. Evidence:
   `reports/ui-upgrade/NAVIGATION_HANDOFF_WEBVIEW_PROOF_2026-10-26.md`.
   Two things that were wrong and are now fixed: the readiness gate accepted a
   window showing `chrome-error://chromewebdata/` because WebDriver's URL is the
   *requested* one (it now requires the document itself to be the app — measured
   failing with no dev server), and a debug binary loads `devUrl` rather than
   `frontendDist`, so the CI job now serves the dev origin and the test header
   says so. One command runs the whole chain locally: `npm run e2e:navigation`
   (`scripts/verify-navigation-webview.mjs` resolves a driver matching the
   installed WebView2 runtime, serves the dev origin, builds, tests, and stops
   only a server it started).
8. Harden `netpulse-socks.service` args (see incident report residual risks).
9. Real Iranian-network vantage measurement — **BLOCKED**, requires a voluntary
   network vantage point; do not claim censorship resistance without it.

## Known limitations / risks

- Rotated credentials still appear in git history; they are revoked, so inert.
- Users with pre-rotation profiles must re-provision.
- `plan_pro.default_profiles` was empty until this cycle; treated as product
  configuration, matching what the server can actually serve.
- Password-reset email delivery is provider-dependent (`RESEND_API_KEY` set);
  delivery status is recorded in audit, not re-verified this cycle.

## Rollback

- Worker: previous versions are retained by Cloudflare; `wrangler rollback` to
  the last known-good if a deploy regresses.
- Host configs: pre-rotation backups, root-only, at
  `/root/netpulse-rotate-1792866520/`. Restoring them revives revoked
  credentials — only together with a fresh secret rotation.
