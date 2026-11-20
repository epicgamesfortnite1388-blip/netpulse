# FINAL_UI_FORENSIC_REVIEW — methodology and findings

**Reviewer:** Kim — Independent Code Review Expert
**Date:** 2026-11-20 · **Baseline:** `main` @ `2a9f825` · **Mode:** read-only review of source, git objects, tests and reports.

## 1. Method

Four independent evidence streams were used; no conclusion below rests on a commit message or a prior report's claim alone.

1. **Repository forensics** — `git status --porcelain`, `git diff`, `git diff --stat`, `git show HEAD:<file>`, `git log`, `git stash list`, file mtimes. Established the true baseline, the 18→24 file drift, and the concurrent-author window (baseline §4).
2. **Three parallel read-only code reviews** — frontend redesign + design-system; NANI frontend↔Rust contract and diagnostic fidelity; Rust backend diff and network honesty. Each produced independently numbered findings (`FE-*`, `NI-*`, `BK-*`) which were de-duplicated by root cause into `FINAL_UI_FINDINGS_REGISTRY.md`.
3. **Direct execution of test suites** — web unit tests, frontend typecheck, frontend production build, full Rust suite, isolated re-run of the failing N1.1 oracle. Commands and exact output are in `FINAL_UI_TEST_REPORT.md`.
4. **Independent verification of Will's fixes** — re-ran suites after the concurrent edits, inspected the changed hunks, and explicitly checked whether any test had been weakened (it had not: `apps/web/test/typeScale.test.ts` mtime is 2026-10-02 and its assertions are byte-identical).

Deliberately **not** performed: production deployment, VPS/Cloudflare/remote DB/payment/release changes, installed-app replacement, `git reset --hard`, `git clean`, force-push, `git add -A`, or any edit to a contested file. No secret, `.data/`, cert or report was opened or deleted.

## 2. Coverage against the mission's review areas

| Mission area | Coverage | Result |
|---|---|---|
| React/TS correctness (§4.A) | Full review of `AppShell`, new `features/connection/*`, `nav.ts`, `GlobalConnectionChip`, NANI pages/hooks, shared UI primitives; typecheck + 506 unit tests executed | One build-blocking defect (F-04); one dead-code surface (F-05); hook leak (F-07) |
| Tauri/Rust integration (§4.B) | All `nani_*` command signatures vs `naniApi.ts`; event envelope and lifecycle; K-1/K-2/K-3 paths; error mapping | Error masking (F-22), K-1 uncommitted (F-14), event gaps (F-20) |
| Backend contract integrity (§4.C) | Command names, params, DTO shapes, nullability, event names/payloads, status semantics | `ProbeSelection` shape broken (F-12) |
| NANI mathematical/diagnostic integrity (§4.D) | Likelihood table, posterior routing, hypothesis ordering, calibration, insufficient-evidence behavior, K-1 units, healthy-observation behavior | Authoritative math changed (F-01), invented calibration label (F-02), web false-healthy (F-03) |
| Networking accuracy (§4.E) | HTTP/DNS probes, proxy handling, route attribution, health events, NANI-021 status | NANI-021 open and newly surfaced as verdict (F-06); DNS timeout (F-21) |
| Design-system fidelity (§4.F) | Prior 68-finding audit, token definitions, radii, focus states, type scale | Type scale regressed then verified fixed (F-10); other design fixes landed by Will |
| Product journeys (§4.G) | Startup shell, dashboard, navigation, connection views, NANI investigations/evidence/hypotheses/verification, settings, copilot | Dead connection console (F-05); no fabricated backend responses found; runtime journey testing blocked (§visual) |
| Performance (§8) | Render/subscription review, bounds, prior measurements, suite timings | No new unbounded structure; flaky engine tests (F-15) |
| Security/reliability (§9) | Tauri capabilities, IPC surface, secrets, payload validation, failure modes — carried from `UI_REVIEW_06` plus current diff | No new HTML/secret sink; carried MEDIUM items remain |

## 3. Principal findings (full detail in the registry)

**P1**
- **F-01** — `diagnosis.rs::LikelihoodTable::signature` changed the authoritative failure likelihood for `Unknown` from 0.20/0.25/0.30 to 0.02 across four tests and added three `Unknown => 0.02` arms. This changes every posterior the UI shows and is forbidden by `UI_REVIEW_07` §3. **Blocked, not reverted** (reverting would destroy concurrent work; no authorization to bless the math).
- **F-02** — Calibration samples are labelled from the engine's own likelihood function and presented as measured confidence ("calibrated on N recorded probe outcomes"). No external ground truth.
- **F-03** — Web `parseHealthCheckResult` substitutes `webChecked` for `healthy`, so an attempted-but-failed check renders as "N/N healthy".
- **F-04** — `connectionState.ts:369` TS2322: the disconnect mutation returns two incompatible envelopes, breaking `tsc --noEmit` and therefore `vite build`. Re-verified at 07:59 and again via `npm run build -w @netpulse/web`.
- **F-05** — `ConnectionHero`/`ConnectionDial` have no consumer; the new connection console cannot be reached in the running app.
- **F-06** — NANI-021: reqwest inherits the system proxy while records assert `RouteKind::Direct`; the new `HealthCheckCompleted` event emits `health: "Healthy"` with no direct-path qualifier.

**P2** — event poll leak (F-07), missing `verified`→"passed" (F-08), unhealthy check treated as resume (F-09), sub-12px text (F-10, **verified fixed by Will**), relaxed evaluation bars + changed calibration algorithm (F-11), DTO shape break (F-12), event flood + suppressed persistence errors (F-13), K-1 fix only in working tree (F-14), flaky N1.1 gate (F-15).

**P3/P4** — theme toggle, mobile drawer a11y, dial fill specificity, token ownership, event timestamps, DNS timeout, error masking, confidence reconciliation, test coverage, reduced motion (verified fixed), hard-coded version.

## 4. What was checked and found sound

- **No fabricated posterior math in the UI.** `hypothesisView.ts::toRows` re-sorts posterior-descending, matching `diagnosis.rs::ranked()`; prior is carried separately; the UI does not recompute or override probabilities.
- **Event envelope is consistent** across `events/mod.rs` (`{seq,event:{kind,payload}}`) and `naniEvents.fromTauriEvent`, with dedupe by `seq:kind`, gap counting and unsubscribe-on-unmount (leak caveat F-07).
- **Connection truth is honest at source.** `connectionState.ts` derives from real `/vpn/status` and `/vpn/tunnel/status`, preserves `verification`/`verifiedPublicIp`, and refuses `connected` until `verifiedAt && exitIp`. Its only defects are the build error and lack of a mounted consumer.
- **Route identifiers and deep links preserved** — all 25 routes in `router.tsx` have nav entries; `?tab=`, `?card=`, `?run=`, `?target=` are owned by destination pages.
- **No user work overwritten.** No report, screenshot, `.data/`, cert or local state was modified by this reviewer; all 26 registry entries record owner and disposition.

## 5. Limitations of this review

- No runtime screenshot was captured (dev server blocked by a sandbox bulk-delete guard — see `FINAL_UI_VISUAL_VERIFICATION.md`). Visual claims are therefore **not** made.
- The isolated N1.1 oracle failure and the full-suite posterior mismatch are two different failure modes; the root cause was not demonstrated, so no attribution to F-01 is asserted.
- NANI math changes (F-01/F-02/F-11) were **reviewed and isolated, not authorized or changed**. Kim's verdict on those is explicitly withheld.
- The concurrent author's work was inspected at 07:51–08:01; later edits, if any, require re-verification.

---

**Forensic conclusion:** the review identified **26 findings (0 P0, 6 P1, 9 P2, 10 P3, 1 P4)**. No finding was invented to inflate the count; duplicate symptoms were merged. The tree is not certifiable as-is: one P1 build blocker and two P1 blocked math items remain.
