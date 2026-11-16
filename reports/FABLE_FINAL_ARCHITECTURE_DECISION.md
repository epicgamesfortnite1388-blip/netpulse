# FABLE — Final Architecture Decision

Dated 2026-11-16. Evidence-anchored; not diplomatic.

## Q1. The ten most serious defects (ranked)

1. **FABLE-ARCH-001 (CRITICAL)** — two NANI engines run simultaneously in the desktop app; two truths, double probing, permanent double maintenance. `app.ts:897` vs Rust `MonitorLoop`.
2. **FABLE-RUST-001 (HIGH)** — the intelligence loop doesn't use its own intelligence: IG-driven ordering and early stopping (`should_stop`, VOI) are dead code; the observe stage probes everything sequentially.
3. **FABLE-BUILD-001 (MEDIUM, gate-level)** — 36 files, +2,656/−493 uncommitted: no execution stage can start safely until this lands.
4. **FABLE-MATH-002 (MEDIUM)** — calibration machinery exists but posteriors are shown without continuous real-run calibration.
5. **FABLE-MATH-001 (MEDIUM)** — confidence weighting is a pseudo-likelihood, undocumented as such.
6. **FABLE-ARCH-002 (MEDIUM)** — failure classification in two languages, guaranteed future divergence.
7. **FABLE-INFRA-001 (MEDIUM)** — duplicate D1 migration number `0005`; unproven but unadjudicated.
8. **FABLE-VPN-001 (MEDIUM)** — sing-box pin refusals silently confuse users; update path appears broken when it's actually refusing.
9. **FABLE-TEST-001 (MEDIUM)** — 360 s API suite slows every future fix.
10. **FABLE-RUST-002 (MEDIUM)** — ~55 dead-code warnings: shelf modules misrepresent the system's real surface.

## Q2. Fundamentally sound modules (do not touch)

`sidecar.rs` (supervision state machine), `elevation.rs` (single UAC path), `dpapi.rs` (honest scoped encryption), `updater_feed.rs` (minisign + transport fix), `engineManager.ts` (pinned digests, self-checks), `proxyTunnel.ts` verify loop (exit-IP proof before `active`), `killSwitch.ts` (fail-closed, honest scope), `missionControl.ts` (verified/observed/not_tested taxonomy), Rust `math.rs`/`bayesian.rs`/`robust_stats.rs`/`probability.rs`/`causal.rs`, `naniEvents.ts` (contracts+reducer), cloud worker structure.

## Q3. Repair

`investigation.rs` (adaptive stopping), `app.ts` (desktop gate), `bayesian.rs` (noise model), `evaluation.rs` (continuous calibration), `EngineManagerPage.tsx` (pin UX), `apps/api/src/db` (quarantine), `desktop-package.mjs` (freshness gate), Bot repo tests.

## Q4. Replace (consolidate, not rewrite)

Dual NANI engines → Rust-authoritative desktop + TS-authoritative web, shared data taxonomy. Dual failure classifiers → one taxonomy data source. `bayesian_update` confidence heuristic → mixture likelihood.

## Q5. Delete

`features/nani-reports/`; `aether-*.zip` stubs; `.tmp-desktop-dev.log`; `.scratch-*`; stale `dist-desktop/`, `.staging-dist/`, `apps/api/dist/` chunks; dead Rust exports (compiler list); TS NANI posterior/diagnosis math after consolidation (keep types + event reducer); hierarchical/timeseries modules if fully shelf (post T-02 measurement); stale grade documents (index them instead).

## Q6. Fake or misleading features

None fake in production. Misleading artifacts only: the dead `nani-reports` page, the `naniApi.ts` parity claim, and stale grade documents. The 157k-line `netpulse-backend.js` is a build artifact, not source — treat it as such (never hand-edit; freshness gate).

## Q7. Genuinely useful math

Robust statistics (winsorize-not-drop), Wilson intervals, log-space Bayesian update with -inf semantics, expected-IG computation with the cloning test oracle, causal ATE with controlled-intervention gating, Beta-Bernoulli verified learning, BOCPD/CUSUM/Page-Hinkley drift, adversarial numerics tests.

## Q8. Incorrect or unnecessary math

- `should_stop`/VOI/`cost_adjusted_gain` — correct but currently unnecessary (dead); wire or delete.
- Hierarchical pooling — correct, currently unnecessary (shelf).
- `ll * c` pseudo-likelihood — heuristic to replace with mixture model.
- Continuous calibration — necessary and missing (machinery exists).
- Nothing implemented was found mathematically wrong (the adversarial suite and reference-implementation oracles protect this).

## Q9. Final Rust architecture

Unchanged in shape. Single crate; NANI Rust engine as the sole desktop intelligence authority; `foundation.rs` composition root; Tauri command surface stays narrow; adaptive stopping wired into `investigation.rs`; persistence single-source; zero dead code. VPN lifecycle stays in Node near-term with Rust-owned elevation/DPAPI/updater — the critical loop's honesty is already enforced at the tunnel state machine; moving it into Rust is optional future work, not a requirement.

## Q10. Final NANI architecture

Desktop: Rust engine (math + registry + investigation + learning + calibration) — authoritative. Web: TS core (subset) — authoritative for web mode only. Shared: taxonomy + event contracts + DTO types as data in `packages/shared`. LLM: prose-only boundary (already correct). Node shadow loop: off in desktop. Calibration: continuous, gating the "probabilities" label.

## Q11. Final VPN engine architecture

Keep all five genuine engines (xray, sing-box, v2ray, hysteria, Aether) + WireGuard profiles. Lifecycle = VALIDATE→PREPARE→START→VERIFY→MONITOR→STOP→CLEANUP with exit-IP proof before `active` (already enforced). Add: pin-refusal UX, post-install cache force. Remove: nothing.

## Q12. Final frontend architecture

27 lazy pages, backend-state-presenting, dual transport (Tauri/HTTP) — keep. Delete the dead page. Fix the parity wording. Add calibration display. No framework changes; no state-management rewrite (React Query + typed DTOs are adequate).

## Q13. Correct order of implementation

W0 (baseline commit → hygiene → desktop gate → packaging gate) → W1 (adaptive stopping → shelf deletion → noise model → calibration → classifier consolidation) → W2 (pin UX, DB quarantine, security policy, ecosystem fixes) → W3 (test ergonomics, chunk splits) → W4 (field validation: ≥100 real investigations before any new math).

## Q14. GPT-6.1 Terra executes

T-02, T-03, T-04, T-05, T-06, T-07, T-09 (Rust systems + numerics + cross-language consolidation + VPN/db glue).

## Q15. Gemini executes

T-01, T-08, T-10, T-11 (gate, packaging, hygiene, test ergonomics) and T-12 (Bot repo) — after reading each ticket's exact files; no architectural discretion.

## Q16. Requires my further reasoning

- Field-validation design for W4 (calibration thresholds, stopping-parameter tuning from real data).
- Any decision to move the tunnel verify loop into Rust (deferred; needs a measured reason).
- Adjudication of `hierarchical.rs`/`timeseries.rs` fate after T-02 shows their real consumption.

## Q17. Actual release blockers

1. FABLE-BUILD-001 (baseline commit) — process blocker.
2. FABLE-ARCH-001 — ship the desktop gate before the next release; it halves background probing and removes a two-truths failure mode users can observe as contradictory NANI answers.
3. FABLE-INFRA-001 — must be adjudicated before any cloud deploy touches migrations.
4. FABLE-VPN-001 — user-facing confusion risk on every engine update cycle.
Everything else is quality, not release-blocking.

## Q18. Permanently removed from the roadmap

- Rewriting the sidecar as multi-file source; any new paid infra (R2 etc.); new VPN protocols without evidence; neural components in NANI; "grade" documents; feature-parity claims between web and desktop NANI (the subsets are now explicit); any roadmap item that re-states a prior phase's aspirations without a file-level acceptance criterion (per this report's classification table).

## Closing judgment

This repository has been built with unusual engineering honesty: verification-before-claiming is enforced in code, tests reproduce prior claims, and the security posture is exemplary for its category. The project's real enemy is not fakery — it is **unpruned ambition**: two NANI engines, shelf mathematics, dead surface, and unmeasured field value. The path forward is consolidation and wiring, not rebuilding. Every recommendation above is executable by the ticket list in `FABLE_IMPLEMENTATION_TICKETS.md` without further discovery.
