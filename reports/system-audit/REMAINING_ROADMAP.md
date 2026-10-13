# NetPulse — Remaining Roadmap

All estimates are engineering ranges, not commitments. "External wait" is time blocked on access, not coding. EST totals exclude external waits unless stated.

## Phase 0 — Baseline, Reproducibility, Architecture Inventory
**Condition:** COMPLETE (this audit). Repo map, baseline (1,655 tests green), architecture traces, and defect list are in SYSTEM_AUDIT_REPORT.md. Remaining effort: 0.

## Phase 1 — Critical Bugs and Security Fixes
**Condition:** COMPLETE. P0: none open. P1/P2 fixed in 7c2a9d9 (engine install verification, version comparison) and 578b6d7 (DPAPI secrets, PBKDF2 cap, tamper-test determinism, elevation canonicalization, updater respawn). Remaining effort: 0.

## Phase 2 — Production Deploy and Cloud Verification
**Condition: COMPLETE (2026-10-13).** Production worker deployed to https://netpulse-cloud.shuridehradin.workers.dev (version `d76fb01a-f775-4ba0-966e-96470f8dbdbd`, 100% traffic), D1 migration 0004 applied after a pre-migration backup, and the live service verified end-to-end (health, auth, revocation, cross-account isolation, bot-inbox fail-closed). Full evidence: RELEASE_GATE_REPORT.md "Phase 2 execution record", TEST_RESULTS.md rows 11–17. Remaining effort: 0.

| ID | Task | Current state | Priority | Dependencies | EST | Risk | Acceptance criteria | Blocker |
|---|---|---|---|---|---|---|---|---|
| T2.1 | Re-authenticate wrangler | COMPLETE — OAuth token refreshed; `wrangler whoami` lists both `4ca19fcad2d9fb155873fc9e0eb481e6` and `7380a67667052f3a7a3b11301ce7a77b` | P1 | operator action | 0 | Low | whoami shows the account; `wrangler d1 list` returns `netpulse-cloud` | none |
| T2.2 | Apply D1 migrations to production | COMPLETE — backup (261,852 bytes, outside repo) → 0004_admin_plans.sql applied (7 commands, 1.46ms) → verified `users.role`, `plans`/`plan_pro` seed, `d1_migrations` 4/4 | P1 | T2.1 | 0 | Medium (production DB) | migrations apply clean; list shows all applied | none |
| T2.3 | Deploy the worker and smoke production routes | COMPLETE — deployed top-level (production) environment; health 200; register/login/revoke/isolation/inbox all verified live | P1 | T2.2 | 0 | Medium | deploy succeeds; health route 200 on production origin | none |
| T2.4 | Verify staging env behaves (same D1 by design — confirm that is intended, or provision a separate D1 for true isolation) | NOT DEPLOYED — staging intentionally not deployed; same-D1-by-design is documented in `wrangler.toml`; the separate-DB decision is the operator's to make before any staging deploy | design decision | operator | 0.5–1 day | Low | documented decision; staging data isolation confirmed or accepted | operator decision |

Phase EST: 0 remaining (1.75–3.5 days were budgeted; all consumed and closed 2026-10-13). **Critical path advanced to Phase 3/4.**

## Phase 3 — Live Integration Verification (Abystral bot, payments)
**Objective:** verify the purchase→entitlement chain against the bot's sandbox.

| ID | Task | Current state | Priority | Dependencies | EST | Risk | Acceptance criteria | Blocker |
|---|---|---|---|---|---|---|---|---|
| T3.1 | Obtain Abystral bot sandbox base URL + shared NETPULSE_SERVICE_SECRET for a staging deployment | NOT AVAILABLE | P1 | external team | 0 (external wait) | — | staging worker reaches bot `/link/request` | external |
| T3.2 | End-to-end link flow: start → deep link → claim → entitlement pull → mirror rows | implemented, locally tested only | P1 | T3.1 | 1–2 days | Medium | link row `active`; entitlement rows mirror bot view; revoke event removes them | T3.1 |
| T3.3 | Purchase-event idempotency and replay against real event deliveries (duplicate event_id, out-of-order config_updated_at) | unit-tested; production inbox verified fail-closed (401 on missing/fake/empty signature) | P1 | T3.1 | 1–2 days | Medium | 100% duplicate deliveries no-op; no double-apply | T3.1 |
| T3.4 | Renewal/expiry/refund lifecycle against sandbox subscriptions | implemented, locally tested only | P2 | T3.1 | 1–2 days | Medium | each lifecycle event converges the mirror | T3.1 |

Phase EST: 3–6 days + external wait. Parallelizable with Phase 4.

## Phase 4 — Live VPN, TUN, and Connection Verification
**Objective:** prove the tunnel on a real Windows machine with administrator rights and authorized nodes.

| ID | Task | Current state | Priority | Dependencies | EST | Risk | Acceptance criteria | Blocker |
|---|---|---|---|---|---|---|---|---|
| T4.1 | Windows test machine with admin elevation | NOT AVAILABLE | P1 | environment | 0 (external wait) | — | admin shell available | environment |
| T4.2 | Live WireGuard tunnel: connect → system proxy → trace verification → disconnect cleanup | provider tested at unit level | P1 | T4.1 | 1–2 days | High | trace shows tunnel egress; proxy reset on disconnect; no stale routes | T4.1 |
| T4.3 | TUN mode: adapter creation, route claim, gateway verification trace, crash recovery (kill -9 the gateway, reap orphan) | gateway config unit-tested | P1 | T4.1 | 1–3 days | High | TUN trace succeeds; orphaned elevated gateway is reaped on next boot | T4.1 |
| T4.4 | Live node dial through xray/sing-box/hysteria with authorized test nodes | engines unit-tested | P1 | authorized nodes | 1–2 days | Medium | probe reports real latency; attribution records the engine | node access |
| T4.5 | OpenVPN provider live check (least-covered engine) | provider referenced in vpnService | P2 | T4.1 | 1–2 days | Medium | connect + verify cycle passes | T4.1 |
| T4.6 | Sleep/wake + network-transition resilience | watchdog implemented | P2 | T4.1 | 1 day | Medium | tunnel recovers or reports honestly after resume | T4.1 |

Phase EST: 5–11 days + external wait. **Critical path for any VPN-related release claim.**

## Phase 5 — Premium Enforcement Verification
**Objective:** prove non-premium users cannot reach premium functionality.

| ID | Task | Current state | Priority | Dependencies | EST | Risk | Acceptance criteria | Blocker |
|---|---|---|---|---|---|---|---|---|
| T5.1 | Map every premium-gated surface in the Abystral platform (premium nodes/configs are served there, not by NetPulse) | architectural finding | P1 | T3.1 | 0.5–1 day | Low | written inventory of premium surfaces | T3.1 |
| T5.2 | Cross-account isolation tests against staging D1 (token replay, IDOR attempts on /subscriptions, /profile-vaults) | isolation unit-tested; **production half verified live 2026-10-13** (vault IDOR delete → `removed:false`; data intact) | P1 | T2.3 (complete), T3.1 for staging | 1–2 days | Medium | all cross-account attempts 401/403 | T3.1 (staging half) |
| T5.3 | Verify stale local entitlement state cannot grant access while offline | sync policy documented | P2 | T2.3 (complete) | 0.5–1 day | Low | offline app shows last-known status only; no premium action executes offline | none |

Phase EST: 2–4 days. Parallelizable with Phase 4.

## Phase 6 — Packaging and Distribution
| ID | Task | Current state | Priority | Dependencies | EST | Risk | Acceptance criteria | Blocker |
|---|---|---|---|---|---|---|---|---|
| T6.1 | NSIS clean-install / upgrade / uninstall validation on a clean Windows VM | build verified only | P1 | T4.1 | 1–2 days | Medium | install → run → upgrade → uninstall leaves no data/routes behind | T4.1 |
| T6.2 | Updater end-to-end (signed feed → download → verify → install → respawn) | feed pipeline implemented; updater disabled in tauri.conf | P2 | T6.1, signing certs | 1–2 days | Medium | staged update installs and the app restarts on the new version | T6.1 |
| T6.3 | Code-split the 3.17 MB web bundle (dynamic imports per feature domain) | warning at build | P3 | none | 1–2 days | Low | initial chunk < 900 kB; routes load on demand | none |

Phase EST: 3–6 days.

## Phase 7 — Reliability and CI
| ID | Task | Current state | Priority | Dependencies | EST | Risk | Acceptance criteria | Blocker |
|---|---|---|---|---|---|---|---|---|
| T7.1 | CI workflows (typecheck + all test suites + cargo check on push; Windows runner for the desktop build) | NOT IMPLEMENTED | P1 | none | 2–3 days | Low | PR gate runs every suite; desktop build artifact produced | none |
| T7.2 | Repeated connect/disconnect soak (50 cycles) watching for port/process/config leaks | not measured | P2 | T4.1 | 1 day | Low | zero leaked processes/ports after soak | T4.1 |
| T7.3 | Dependency audit (`npm audit`, `cargo audit`) and lockfile review | not run this session | P2 | none | 0.5–1 day | Low | no known-vulnerable deps at warn level | none |

Phase EST: 3.5–5 days.

## Phase 8 — Alpha Release Candidate and Final Acceptance
**Objective:** internal Alpha with the conditional scope of Phase-3/4 items verified.
- Acceptance: Phases 3–5 complete (Phase 2 already complete); all P0/P1 tasks closed; soak clean; rollback path documented.
- EST: 2–3 days of verification + bugfix buffer (3–5 days).

## Totals
- **Total remaining: 14.5–27 engineering days** (midpoint ≈ 20.75; Phase 2's 1.75–3.5 days closed this session), of which ~8.75 days are blocked on external access (T3.1, T4.1, node access).
- **P0/P1 repair effort remaining: 0** (all confirmed defects fixed and regression-tested).
- **Critical path:** (T3.2/T4.2/T4.3 in parallel) → Phase 8. Phase 2 is complete.
- **Minimum viable Alpha effort:** Phases 4.2 + 4.3 + 5.2 ≈ 4.5–8.5 days (Phase 2 complete; the production isolation half of 5.2 is already verified live).
- **Largest uncertainties:** live VPN behavior on real Windows networks (T4.2–T4.4) and Abystral sandbox availability (T3.1).

## Release milestones
- M1 (Phase 2) — **REACHED 2026-10-13**: production worker deployed and healthy; internal dev against production cloud is live.
- M2 (after Phases 3–5): live entitlement + isolation verified → controlled Alpha.
- M3 (after Phases 4, 6): live VPN + packaging verified → release candidate.
