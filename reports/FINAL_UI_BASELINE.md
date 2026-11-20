# FINAL_UI_BASELINE — NetPulse/NANI forensic review baseline

**Reviewer:** Kim — Independent Code Review Expert (session Expert: CodeReviewExpert)
**Mission:** FINAL UI ENGINEERING MISSION — forensic review / defect elimination / quality verification
**Repository:** `E:\Code\Project\Vpn_app` (Git Bash: `/e/Code/Project/Vpn_app`)
**Baseline captured:** 2026-11-20 07:42–07:51 GMT+3:30
**Mode:** read-only baseline. No source file was modified by this reviewer.

---

## 1. Repository state at baseline

| Item | Value |
|---|---|
| Branch | `main` |
| HEAD | `2a9f82593537aee39f799f72816fb0f282f630ec` |
| HEAD subject | `docs(nani): N1.2 deliverables — timestamp contract, atomic concurrency, verification semantics; registry 36->39 ...` |
| Remote | `origin https://github.com/epicgamesfortnite1388-blip/netpulse.git` (not contacted) |
| Stash | empty |
| Dirty tracked files (07:42 snapshot) | 19 `M` files — see §2 |
| Untracked files (07:42 snapshot) | new UI sources, all prior review reports, screenshots, `.data/`-adjacent operational logs — see §3 |

Recent history (HEAD first): `2a9f825` docs N1.2 · `d46ece9` fix N1.2 · `c7fe33b` fix N1-review K-2/K-3 · `0a3cce5` docs N1.1 · `200de54` feat Bayesian authoritative path · `5b65737` test e2e nodes/export 410 · `481f6b3` fix N0 shared registry/bus · `005de03` feat(ui) brand mark + hero band.

## 2. Dirty tracked files at baseline

`git diff --stat` at 07:42: **18 files changed, 1,263 insertions(+), 733 deletions(-)** (a 19th path, `AdaptiveRecoveryCard.tsx`, was `M` in `git status` but had **no content diff** — line-ending only; git emitted repeated LF→CRLF warnings).

| Area | Files |
|---|---|
| UI shell / theme | `apps/web/src/app/AppShell.tsx`, `apps/web/src/main.tsx`, `apps/web/src/styles/tokens.css` |
| NANI frontend | `features/nani/{NaniPage.tsx,hypothesisView.ts,hypothesisView.test.ts,naniApi.ts,naniEvents.ts,naniEvents.test.ts}` |
| VPN frontend | `features/vpn/AdaptiveRecoveryCard.tsx` (line endings only) |
| Rust/Tauri backend | `src-tauri/src/commands/nani.rs`, `src-tauri/src/network_intelligence/{api_intelligence/registry.rs,diagnosis.rs,evaluation.rs,events/mod.rs,foundation.rs,persistence.rs,validation.rs}` |
| Docs | `NANI_ADVERSARIAL_TEST_REPORT.md` |

## 3. Untracked files (preserved, not touched)

- **New UI sources:** `apps/web/src/app/nav.ts`; `apps/web/src/components/{GlobalConnectionChip.tsx,PulseMark.tsx}`; `apps/web/src/features/connection/{ConnectionDial.tsx,ConnectionHero.tsx,connectionState.ts}`; `apps/web/src/styles/identity.css`.
- **Prior report packages:** `reports/N0_*`, `reports/N1_*`, `reports/N1_2_*`, `reports/NANI_AUDIT_*`, `reports/UI_REVIEW_*`, `reports/UI_MASTER_01_*`, `reports/FABLE_*` (80+ files, all untracked).
- **Screenshot evidence:** `reports/nani-release/*.png`, `reports/nani-screens/*.png`, `reports/ui-transformation/screenshots/before-*.png`, plus `reports/clean-install/`, `reports/nani-health-success/`, `reports/nani-hypothesis-view/`, `reports/nani-network-empty/`, `reports/nani-recovery-planner/`, `reports/nani-rollback/`, `reports/release-3.2.0/`.
- **Operational data/log:** `.tmp-desktop-dev.log` (144 KB), `.workbuddy-ai/`. None were deleted, moved or rewritten.

## 4. Concurrent modification — material baseline caveat

During the review window a **second agent/process was actively editing the same source files**. File mtimes after mission start (07:42:42):

```
07:42:54  apps/web/src/styles/tokens.css
07:43:32  apps/web/src/components/ui/Button.tsx
07:44:48  apps/web/src/components/ui/Tooltip.tsx
07:45:01  apps/web/src/components/ui/Switch.tsx
07:46:18  apps/web/src/app/AppShell.tsx
07:47:12  apps/web/src/components/ui/States.tsx
07:48:23  apps/web/src/styles/identity.css
07:48:43  apps/web/src/features/copilot/CopilotPage.tsx
07:48:51  apps/web/src/features/nani/NaniPage.tsx
07:50:25  apps/web/src/features/dashboard/DashboardPage.tsx
```

Diffstat grew from 18 files / +1,263−733 to **24 files / +1,321−787**. The user explicitly confirmed these are **Will's in-flight fixes**: this reviewer is confined to the Kim role (independent review, findings registry, verification, final decision) and **must not edit contested files**. All "baseline" test results below are snapshots of the tree at the moment the command ran; results after Will's edits are re-measured separately in `FINAL_UI_TEST_REPORT.md`.

## 5. Baseline test status (as captured, before/during concurrent edits)

### 5.1 Frontend unit tests — FAIL
Command: `npm run test -w @netpulse/web`
```
Test Files  1 failed | 53 passed (54)
     Tests  2 failed | 504 passed (506)
  Duration  102.40s
```
Failing file: `apps/web/test/typeScale.test.ts`
- `contains no arbitrary font sizes at all` — offenders: `src\app\AppShell.tsx: text-[11px]`, `text-[10px]`, `src\features\connection\ConnectionHero.tsx: text-[11px]` ×2.
- `renders no text below the 12px floor` — same four offenders.

These four classes were introduced by the redesign and violate the binding 12px floor (`reports/UI_REVIEW_07` §5.5). At 07:51 the two AppShell offenders were no longer present (concurrent fix); the two `ConnectionHero.tsx` offenders remained.

### 5.2 Frontend typecheck — FAIL
Command: `npm run typecheck -w @netpulse/web`
```
src/features/connection/connectionState.ts(369,5): error TS2322:
Type '(source: ConnectionSource) => Promise<{ tunnel: ProxyTunnelStatus; }> |
                                     Promise<{ status: VpnStatus; }>'
is not assignable to type 'MutationFunction<{ tunnel: ProxyTunnelStatus }, ConnectionSource>'.
```
The new `useDisconnect()` mutation declares one concrete result type but returns one of two different envelopes. This is a **new, build-blocking defect** in the untracked connection module.

### 5.3 Rust suite — FAIL (2 of 552)
Command: `cargo test --manifest-path src-tauri/Cargo.toml`
```
test result: FAILED. 550 passed; 2 failed; 2 ignored; 0 measured; 0 filtered out; finished in 60.52s
```
- `network_intelligence::investigation::tests::n1_analysis_latency_smoke` — `analysis cycle unexpectedly slow: 8.8075112s` (`investigation.rs:1888`).
- `network_intelligence::investigation::tests::n1_bayesian_engine_drives_the_real_analysis` — `assertion left == right failed; left: Some("ipv4") right: Some("quic_udp_failure")` (`investigation.rs:1745`).

A **fresh isolated re-run** of the second test failed differently: `investigation nani-investigation-1 did not reach a terminal state in 6s` (`investigation.rs:1356`). Both failures are **environment/load sensitive** in this workspace; this reviewer does **not** attribute them to the uncommitted likelihood-table change without further proof. Their status is `OPEN — flaky, root cause not demonstrated`, not "newly introduced by the math change".

### 5.4 Build status at baseline
Not executed during the baseline window; see `FINAL_UI_TEST_REPORT.md` for the post-edit build result.

## 6. Existing reports / prior findings reviewed

| Package | Relevant content |
|---|---|
| `reports/UI_REVIEW_07_UI_REDESIGN_ENGINEERING_CONTRACT.md` | Binding change contract: what may change, contract-sensitive symbols, must-not-change areas (NANI math, VPN engine, security boundaries, backend contract shapes), definition of done. |
| `reports/UI_MASTER_01_FORENSIC_AUDIT.md` | 68 prior visual/UX findings (1 CRITICAL, 14 HIGH, 35 MEDIUM, 18 LOW). Top items: undefined `text-accent-foreground`/`bg-surface-3`/`bg-background` tokens, button style split, radii, missing tablist semantics. |
| `reports/N1_2_REVIEW_FINAL_INDEPENDENT_DECISION.md` | Prior Kim verdict **CHANGES REQUIRED**: blocking R-1 (committed-tree ms-feeder in `commands/nani.rs`), C-N1.2-2 documentation correction. |
| `reports/NANI_AUDIT_10_CRITICAL_GAP_REGISTER.md` | 18 gaps NANI-001…018; 001/002/003/019 resolved, others open. |
| `reports/N1_2_04_HEALTHY_NETWORK_BIAS_ASSESSMENT.md`, `reports/N1_2_07_FINAL_IMPLEMENTATION_REPORT.md` | NANI-020 (all-healthy posterior artifact) OPEN; NANI-021 (system-proxy contamination) HIGH OPEN; NANI-022 (units) partially resolved. |

## 7. Scope of the redesigned UI

New/changed surfaces observed: application shell and two-tier navigation (`AppShell.tsx`, `nav.ts`, `GlobalConnectionChip`, `PulseMark`), identity/token layer (`identity.css`, `tokens.css`), connection console (`features/connection/*`), dashboard, NANI page and event/posterior helpers, Copilot, shared UI primitives.

**Backend changes accompany the UI** (`diagnosis.rs` +240, `evaluation.rs` +183, `validation.rs` large rewrite, `foundation.rs` +101, `persistence.rs` +67, `registry.rs` +69, `events/mod.rs` +11, `commands/nani.rs` +75) — i.e. the working tree is *not* UI-only. Two of these hunks change authoritative diagnostic semantics; see `FINAL_UI_FINDINGS_REGISTRY.md` (F-01, F-02).

## 8. Risks before modification

1. **Concurrent authorship** — any edit to the 10 files above can silently overwrite Will's work (user instructed: treat as Will's work; do not edit).
2. **Out-of-scope math in the working tree** — likelihood-table and calibration changes alter posterior values under a contract that forbids engine changes; no authorization to revert or bless them in this mission.
3. **Correctness gate already red** — frontend typecheck and two test suites fail at baseline; a "green build" claim would be false.
4. **Diagnostic honesty** — NANI-021 remains open; a new health-check event can surface a proxy-derived verdict without a direct-path qualifier.
5. **Environment-sensitive engine tests** — the N1.1 oracle and perf smoke are flaky here; verdicts must not rely on a single run.
6. **Visual claim risk** — no screenshot was captured during the baseline window; visual verification must be performed against a real runtime or explicitly reported as not performed.

---

**Baseline verdict:** repository state is preserved and fully inventoried; the tree is **not** in a releasable state at baseline. All findings derived from this baseline are in `FINAL_UI_FINDINGS_REGISTRY.md`.
