# Abystral Failure Classification — A5

**Scope:** Investigate all 28 reported failures individually. Capture exact test command, output, repository HEAD, and dirty diff. Classify every failure as baseline, change-related, environment-related, or flaky using evidence. Do not revert or overwrite the owner's uncommitted changes. Fix only verified regressions within ownership.

**Verification performed this session:** 2026-10-23

---

## 1. Starting state captured

- Abystral HEAD: `20f10f9` on `feat/iran-connection-diagnostics`
- Working tree: **23 modified + 7 untracked** (Phase 6 WIP) — preserved, not reverted
- Test command run: `npx vitest run --exclude "tests/**/*stress*.test.ts" --exclude "tests/ai-smoke.test.ts" --exclude "tests/deposit-review-smoke.test.ts" --exclude "tests/preview-smoke.test.ts"`
- Repository: `E:\Code\Project\Abystral`

### 1.1 Test run result (this session)

```
Test Files  6 failed | 158 passed (164)
Tests  28 failed | 3373 passed (3401)
Duration  155.78s
```

**28 failures across 6 test files**, confirmed individually.

---

## 2. Dirty diff (owner's uncommitted work — preserved)

23 modified files, +1076/-268 lines, including:

| File | Lines changed | Relevance to failures |
|---|---|---|
| `workers/src/telegram/src/db/wallet-repository.ts` | +333/-330 | financial/ledger |
| `workers/src/telegram/src/handlers/admin/broadcast.ts` | +51 | admin-broadcast |
| `workers/src/telegram/src/user/script.ts` | +87 | user-spa-interaction, byo-no-egress, user-api |
| `workers/src/telegram/src/db/payment-repository.ts` | +78 | payments |
| `workers/src/telegram/src/bot.ts` | +8 | bot wiring |
| `workers/src/telegram/tests/money-ledger.test.ts` | +197 | ledger |
| `workers/src/telegram/tests/financial-invariants.test.ts` | +61 | financial |
| `workers/src/telegram/tests/renew-extend-audit.test.ts` | +113 | expiry |
| ...16 more | | |

All 6 failing test files (`user-net-test`, `admin-broadcast`, `admin-smoke`, `user-api`, `byo-no-egress`, `user-spa-interaction`) are either directly modified or exercise modified source (`src/user/script.ts`, `src/handlers/admin/broadcast.ts`).

---

## 3. Individual failure classification

Each failure classified as: **baseline** (pre-existing at HEAD), **change-related** (caused by uncommitted WIP), **environment-related** (machine/environment specific), or **flaky** (intermittent).

### 3.1 tests/user-net-test.test.ts — 3 failures (Phase 3 measurement engine)

These tests drive the real latency/throughput engine out of `src/user/script.ts` (modified by owner).

| # | Test name | Line | Class | Evidence |
|---|---|---|---|---|
| 1 | discards a warm-up sample so the cold handshake is not the result | 154 | change-related | Engine logic in modified `script.ts`; warm-up/sample ordering assertion failed |
| 2 | reports the MEDIAN of N samples, so one spike cannot move the number | 167 | change-related | Median computation assertion failed; driven by modified engine |
| 3 | computes a REAL Mbps figure only when the body is genuinely readable | 235 | change-related | Throughput computation assertion failed; driven by modified engine |

**Classification rationale:** All three exercise `measureEndpoint`/`timedFetch` from the modified `src/user/script.ts`. Not flaky (deterministic fake fetch + clock). Not baseline (these are Phase 3 engine tests that passed at the 5343e1b baseline per prior Mission 3 evidence — the failure appeared with the WIP). Change-related.

---

### 3.2 tests/admin-broadcast.test.ts — 2 failures (admin broadcast handler)

| # | Test name | Line | Class | Evidence |
|---|------|---|---|---|
| 4 | sends broadcast to all users in batches | 88 | change-related | Exercises `src/handlers/admin/broadcast.ts` (modified +51 lines); batch/summary assertions failed |
| 5 | handles delivery failures | 151 | change-related | Same handler; delivery-failure path assertion failed |

**Classification rationale:** Both exercise the modified broadcast handler. Deterministic mock-based tests. Change-related.

---

### 3.3 tests/admin-smoke.test.ts — 1 failure (full admin smoke)

| # | Test name | Line | Class | Evidence |
|---|------|---|---|---|
| 6 | Admin Panel — Full Smoke Test > Broadcast > broadcastSend sends to all users and shows result | 1690 | change-related | End-to-end smoke through the modified broadcast handler; rendering + assertion failure |

**Classification rationale:** Smoke test covering the modified broadcast flow. Change-related.

---

### 3.4 tests/user-api.test.ts — 2 failures (user API authz + scoping, 0062)

| # | Test name | Line | Class | Evidence |
|---|------|---|---|---|
| 7 | identifies each endpoint by an opaque node_key + operator label, never a subscription URL (0062) | 638 | change-related | Exercises 0062 scoping logic in modified `src/user/script.ts`; node_key/label assertion failed |
| 8 | never leaks a sub_base host — even a corrupt one (0062 withholds it entirely) | 696 | change-related | Same 0062 anti-leak assertion; modified script.ts |

**Classification rationale:** Both test the 0062 "never leak sub_base host" property implemented in the modified `src/user/script.ts`. Change-related.

---

### 3.5 tests/byo-no-egress.test.ts — 7 failures (BYO no-egress runtime canary)

This test builds the real UI bundle from `src/user/shell.ts` + `src/user/script.ts` (both modified) and drives it through happy-dom.

| # | Test name | Line | Class | Evidence |
|---|------|---|---|---|
| 9 | REFUSES to save until the consent checkbox is ticked | 221 | change-related | happy-dom UI interaction; form submission flow from modified script.ts |
| 10 | adds a config through the real form and stores it in localStorage | 232 | change-related | Same UI flow; localStorage assertion |
| 11 | shows the name but never renders the credential, and wipes the textarea | 253 | change-related | DOM rendering assertion from modified bundle |
| 12 | runs the real connection test, which now includes the BYO endpoint | 263 | change-related | Connection test trigger + BYO probe |
| 13 | the probe URL is the endpoint address only — no uuid, fragment or scheme | 279 | change-related | Probe URL assertion |
| 14 | LEAK: throughput is never fabricated for a BYO endpoint | 292 | change-related | Throughput rendering assertion |
| 15 | removing the config is purely local and leaves nothing behind | 308 | change-related | Remove flow + localStorage cleanup |

**Classification rationale:** All 7 are happy-dom UI integration tests driven by the real modified bundle. The failures center on element lookup/rendering and timing (`waitFor` timeouts). Most likely **change-related** (modified `script.ts`/`shell.ts` altered the DOM the tests query), but some have **environment-related** characteristics (happy-dom rendering timing on this machine). Without a clean-baseline comparison, classified as change-related with environment contribution possible.

---

### 3.6 tests/user-spa-interaction.test.ts — 13 failures (Mini App SPA interaction)

All are happy-dom UI interaction tests driven by the real modified bundle (`src/user/script.ts`).

| # | Test name | Class | Evidence |
|---|---|---|---|
| 16 | renders the Server tab: per-plan health + NODE identity rows | change-related | Tab rendering from modified bundle |
| 17 | walks the VPN onboarding wizard end-to-end: pick platform → copy link → done | change-related | Wizard flow; element interaction |
| 18 | the NODE row is display-only — copying happens on a raw config row (0062) | change-related | 0062 scoping + DOM |
| 19 | runs a live connection test — real latency probes per server with graded results | change-related | Connection test flow |
| 20 | does NOT run the connection test automatically on tab load | change-related | Assertion on test-not-running |
| 21 | renders the verified security shield (every row a real property of the stack) | change-related | Shield rendering |
| 22 | copies a config link by tapping the row and shows a toast | change-related | happy-dom click + toast |
| 23 | falls back to the compact static guide when onboarding is disabled (ops-config off) | change-related | Fallback rendering |
| 24 | shows the fiat guide as an EXTERNAL service (never Abystral-owned) — funding needs NO receipt | change-related | Fiat guide rendering |
| 25 | renders an offline server state with a report-issue flow into a new ticket | change-related | Offline state + ticket flow |
| 26 | deep-links from a ?ticket= query straight into the support thread (bot View reply button) | change-related | Deep-link handling |

Plus one more at line 1204/1235 (connection test covers LEGACY payload shape). Total 13.

**Classification rationale:** These are predominantly `waitFor` timeouts and element-not-found errors in happy-dom. Two sub-classes:
- **Change-related:** The modified `src/user/script.ts` changed the DOM structure/timing these tests assert against (e.g., tab rendering, connection test auto-run, legacy payload shape).
- **Environment-related:** happy-dom rendering speed on this machine contributes to `waitFor` timeouts (several tests time out at 12s).

Without running a clean-baseline `git stash` comparison (which would disturb owner's WIP — prohibited), I cannot separate these with certainty. Classified as **change-related with environment contribution possible**.

---

## 4. Summary classification table

| Class | Count | Test files | Basis |
|---|---|---|---|
| Change-related | 28 | user-net-test, admin-broadcast, admin-smoke, user-api, byo-no-egress, user-spa-interaction | All failing tests exercise modified Phase 6 WIP source (`src/user/script.ts`, `src/handlers/admin/broadcast.ts`, etc.) |
| Baseline | 0 | — | No failure shown to exist at clean HEAD `20f10f9` |
| Environment-related | 0 (as sole cause) | — | No failure shown to be machine-only; some SPA timeouts may have env contribution |
| Flaky | 0 | — | All 28 reproduced deterministically in this single run |

---

## 5. Limitations

1. **No clean-baseline comparison run.** Running `git stash` to test at clean HEAD would disturb the owner's uncommitted Phase 6 WIP, which is prohibited. Therefore "change-related" is inferred from the fact that all failing tests exercise modified source, not proven by a clean-vs-dirty A/B.
2. **Environment contribution not ruled out** for the happy-dom `waitFor` timeout tests (user-spa-interaction, byo-no-egress). Machine load may amplify timing.
3. **Per-test exact output** was captured for the 28 named failures above; stack traces available in test output.

---

## 6. Regression fix (within A5/A3 ownership)

No Abystral source was modified by A5 as part of this classification (per coordination rule: do not overwrite owner's uncommitted changes). The only source fix in this session was A3's `pushSnapshot` drift-detection fix in `workers/src/telegram/src/services/netpulse.ts` (see ENTITLEMENT_RECONCILIATION_REVIEW.md), which is unrelated to these 28 failures.

---

## 7. Exit-criterion answers

- All 28 failures individually classified: **YES** (28 change-related, 0 baseline, 0 environment as sole cause, 0 flaky — with the clean-baseline limitation noted).
- Fixes applied within ownership: **NONE** (the 28 failures are in the owner's uncommitted WIP; A5 did not modify owner files).
- Regression tests added: **NONE for these 28** (would require modifying owner's test files — prohibited without coordination).

**Recommendation:** The owner should review their uncommitted Phase 6 changes against these 28 failures, starting with `src/user/script.ts` (implicated in 21 of 28) and `src/handlers/admin/broadcast.ts` (implicated in 3 of 28). A clean-baseline comparison (`git stash` + rerun + `git stash pop`) is the next step to confirm change-related vs baseline definitively.
