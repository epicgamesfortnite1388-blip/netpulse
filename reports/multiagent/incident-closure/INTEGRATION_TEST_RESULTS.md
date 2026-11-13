# Integration Test Results — A7

**Scope:** Rerun relevant tests against the integrated tree after reviewing agent handoffs. Distinguish unit tests, integration tests, local runtime tests, and live production validation. Test the supported path from account identity and subscription state through entitlement reconciliation, profile generation, client connection, DNS/routing checks, and actual HTTPS reachability. Verify user-facing status corresponds to the underlying result.

**Verification performed this session:** 2026-10-23

---

## 1. Tests executed this session

### 1.1 Abystral unit tests (local)

Command: `npx vitest run --exclude "tests/**/*stress*.test.ts" --exclude "tests/ai-smoke.test.ts" --exclude "tests/deposit-review-smoke.test.ts" --exclude "tests/preview-smoke.test.ts"`

| Suite | Result |
|---|---|
| Full unit suite | 3373 passed, 28 failed (164 files, 158 pass / 6 fail) |
| `tests/netpulse-snapshot.test.ts` (with 4 new regression tests) | 14/14 pass (10 original + 4 F-012-G2 pushSnapshot regression) |
| `tests/netpulse-auth-ux.test.ts` | reviewed (signed surface coverage) |

### 1.2 Cloud worker integration tests (local)

Command: `npx vitest run test/netpulse-integration.test.ts`

| Suite | Result |
|---|---|
| `test/netpulse-integration.test.ts` | 16/16 pass (cross-account isolation, out-of-order guard, idempotency, entitlement apply) |
| `test/egressProxy.test.ts` + `test/egressThroughProxy.test.ts` (apps/api) | 22/22 pass (proxy resolution + traversal) |

### 1.3 Code fix applied this session

**DEFECT 1 fixed** — `workers/src/telegram/src/services/netpulse.ts` `pushSnapshot`:
- Before: `return { inSync: data?.inSync !== false }` — treated non-JSON 2xx / field-absent 2xx as "in sync" (defeated drift detection).
- After: `return { inSync: data?.inSync === true }` — only explicit `inSync: true` counts as agreement; everything else → drift → repair.
- 4 regression tests added in `tests/netpulse-snapshot.test.ts` (F-012-G2).

---

## 2. Test classification

| Type | Count | Status | Notes |
|---|---|---|---|
| Unit (Abystral) | 3373 pass / 28 fail | Mixed | 28 failures in owner's uncommitted Phase 6 WIP (see ABYSTRAL_FAILURE_CLASSIFICATION.md) |
| Unit (netpulse-snapshot) | 14/14 pass | PASS | Includes new regression coverage for pushSnapshot defect |
| Integration (cloud netpulse-integration) | 16/16 pass | PASS | Cross-account isolation, out-of-order guard, idempotency |
| Integration (cloud egress proxy) | 22/22 pass | PASS | Proxy resolution ordering + actual proxy traversal |
| Local runtime (VPS live) | Shadowsocks + VLESS REALITY | PASS | HTTPS 200 through both tunnels, egress IP 206.1.96.89 |
| Live production | Purchase flow | BLOCKED | No test user / staging bot; purchase-flow blocked (Mission 3) |
| Live production | VPN/TUN on dev machine | NOT RUN | No controlled endpoint / admin elevation |

---

## 3. Supported path verification (identity → entitlement → profile → connection → HTTPS)

| Step | Component | Status | Evidence |
|---|---|---|---|
| Account identity | Bot↔cloud link (signed) | VERIFIED (unit + integration) | HMAC service auth, fail-closed, nonce replay protection |
| Subscription state | Bot authoritative (listSubscriptionsByUser) | VERIFIED (unit) | compareEntitlementSnapshot 10/10 |
| Entitlement reconciliation | compareEntitlementSnapshot + pushSnapshot | VERIFIED (unit) | Drift detected for mismatch/missing/extra/duplicate; repaired via re-emit |
| Profile generation | REALITY key rotated (VPS backup 05:40 UTC) | VERIFIED (VPS) | New REALITY key; live VLESS REALITY handshake PASS |
| Client connection | VLESS REALITY + Shadowsocks through VPS | VERIFIED (VPS live) | HTTPS 200 via both tunnels; egress IP 206.1.96.89 |
| DNS/routing | Not tested live | NOT RUN | No dev-machine per-process egress experiment |
| Actual HTTPS reachability | www.google.com through tunnel | VERIFIED (VPS live) | HTTP 200 via Shadowsocks + VLESS REALITY |

**Handshake ≠ full connectivity distinction:** Noted. The VPS live test confirmed full HTTPS (not just handshake) through both Shadowsocks and VLESS REALITY tunnels.

**Mocked payment/entitlement ≠ production proof:** Noted. No mocked payment was presented as production proof. Purchase flow remains blocked (no test user/staging bot).

---

## 4. What was NOT tested (production / live integration paths)

| Path | Reason |
|---|---|
| Purchase-to-entitlement end-to-end | No test user / staging bot; purchase-flow blocked (Mission 3) |
| Live VPN/TUN from dev machine | No controlled endpoint, no admin elevation |
| Per-process dual-egress experiment (Xray child vs Node/curl) | Same as above |
| Entitlement drift repair live e2e | Requires deployed bot + NetPulse worker pair + test user |
| WireGuard reboot persistence | No reboot performed per policy |
| Kill switch | Requires admin privileges; not tested |
| Microsocks HTTPS end-to-end | HTTPS returned 000 via microsocks (investigation needed) |
| Profile reissuance live e2e | Requires VPS profile-store enumeration |

---

## 5. Kill switch

**Status: UNVERIFIED.** Requires admin privileges in a controlled environment. Until verified, it remains described as unverified — not treated as an operational security control.

---

## 6. Exit-criterion answers

- User-facing status corresponds to underlying result: **VERIFIED** for the signed entitlement path (drift → inSync:false → repair; reach → synced; unreachable → failed).
- Successful handshake not mistaken for full connectivity: **VERIFIED** — full HTTPS tested via both tunnels.
- Mocked payment/entitlement not presented as production proof: **VERIFIED** — no mock used as production proof.
- Kill switch: **UNVERIFIED** — remains unverified.
- Production/live paths not tested: purchase-to-entitlement (blocked), live VPN/TUN from dev machine, dual-egress experiment, entitlement drift repair e2e, WireGuard reboot, kill switch, microsocks HTTPS e2e, profile reissuance live e2e.
