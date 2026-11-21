# UI_REMEDIATION_09 — Final Handoff

**Mission:** C-04, C-05, ten review objections, independent re-approval
**Verdict:** **PASS WITH CONDITIONS**

---

## 1 The four questions the brief required answered

| Question | Answer |
|---|---|
| Is C-04 resolved? | **Yes.** The suite passes identically idle and under load, the performance test is kept, and the replacement is proven to reject injected defects. |
| Is C-05 implemented and verified? | **Yes on 4 of 27 routes**, the four densest. The model, the control, the gating and the unmounting are verified in the running application. The remaining 23 routes still use only the binary fold — stated here in the same sentence because "implemented" without the scope figure would be the K-10 defect again. |
| Are all ten objections resolved? | **Eight resolved, one accepted, one unmet** (K-06: three cycles were not run). See §3. |
| Independent verdict | **APPROVED WITH CONDITIONS** — five conditions, in `_08` §7. |

## 2 What changed

### New — the disclosure system

| File | Purpose |
|---|---|
| `apps/web/src/lib/detailLevel.ts` | Pure four-level policy: levels, metadata, storage keys, clamping, visibility, suppressed counts, offer trimming. No React, no DOM — so it can be tested without rendering. |
| `apps/web/src/components/ui/DetailLevel.tsx` | The binding: `DetailLevelProvider` (`declares`, `depth`), `DetailLevelControl`, `DetailGate`, `useDetailLevel`. |
| `apps/web/test/detailLevel.test.ts` | 16 policy tests |
| `apps/web/test/detailLevelComponent.test.tsx` | 10 binding tests |

### New — measurement harnesses

| File | Purpose |
|---|---|
| `scripts/ui-colour-audit.mjs` | Computed-colour and contrast audit; walks ancestors, composites translucency, handles gradients; scans rendered class lists for raw palette utilities |
| `scripts/ui-a11y-check.mjs` | Behavioural accessibility: roving tabindex, arrow/Home/End, APG wrapping, target sizes, landmarks, hidden-level cost |

### New — performance

| File | Purpose |
|---|---|
| `apps/web/test/mapClusterWork.test.ts` | 6 deterministic work-envelope tests (no wall clock) |
| `apps/web/test/perf-baseline.json` | Recorded baseline for the opt-in benchmark |

### Rewritten

| File | Change |
|---|---|
| `apps/web/test/mapClusterPerf.test.ts` | Absolute budgets → opt-in measurement with warm-up, 21 samples, median, batching, recorded baseline, 3× drift tolerance. The passthrough scenarios are now marked as passthroughs. |

### Modified

| File | Change |
|---|---|
| `components/ui/Segmented.tsx` | Widened to `string \| number`; roving `tabIndex`; Arrow/Home/End handling |
| `components/ui/Surface.tsx` | `Section` gains `detail`; `EngineGlyph` gains `engine` (audit attribute) |
| `features/dashboard/DashboardPage.tsx` | Provider (Context default) + gates at 1/2/3/4 |
| `features/vpn/VpnPage.tsx` | Provider (Context default), rail stays essential, control added |
| `features/vpn/OverviewSurface.tsx` | `admin` at 2, `relationships` at 3, glossary at 3, glyph attribute |
| `features/vpn/CoreSurface.tsx` | `roles` at 2, `protocols` at 3 |
| `features/vpn/ProviderSurface.tsx` | `capabilities` at 3, `history` at 4 |
| `features/vpn/AetherSurface.tsx` | `tun` at 2, `provenance` at 4 |
| `features/vpn/engineMeta.ts` | Distinct `--color-proto-*` identity per engine; the violet rule documented |
| `features/nani/NaniPage.tsx` | Provider with `declares`; per-tab levels; exit rule for an invalid active tab |
| `features/diagnostics/DiagnosticsPage.tsx` | Provider with `depth={3}`; gates at 2 and 3 |
| `scripts/ui-capture.mjs` | Theme normalisation + guard, per-shot detail level, pre/post-tab application, tab activation verification, content-height metric, `tabCount` |
| `styles/identity.css` | **Only five token values**: `--color-faint` (dark `#718783→#839793`, light `#5d7570→#506561`) and `--state-idle`/`--state-unknown` (same values). No layout, spacing or typography changed. |

`scripts/ui-colour-audit.mjs` and several of the above were committed by the concurrent
process described in §6; the rest remain in the working tree.

## 3 The ten objections

| # | Status |
|---|---|
| K-01 assertions that did not assert | **Resolved** — two of three original assertions measured a passthrough; replaced with a work envelope proven to reject two injected defects |
| K-02 glyph lost its cue | **Resolved** — 10 distinct computed colours across 10 engines (was 4 of 5 identical) |
| K-03 `EngineBadge` single tint | **Accepted** — identity restored to the glyph; a second channel encoding the same fact was redundant |
| K-04 blunt `animate-*` selector | **Accepted, guarded** — the contract asserts the rule and the mutation suite proves the assertion bites |
| K-05 second `h1` path | **Resolved** — measured: one `h1`, `lang`, `main`, `nav` |
| K-06 three cycles not run | **UNMET** — three cycles were not run. Cannot be retroactively satisfied |
| K-07 Phase 6 missing | **Resolved on 4 of 27 routes** |
| K-08 `unify-palette.mjs` dead | **Resolved** — moved to `scripts/oneoff/` |
| K-09 violet collision | **Resolved by rule** — no engine uses `proto-violet`; reserved for the Aether subsystem |
| K-10 claims outrunning evidence | **Resolved as practice; the original claim was false** — ESLint is 3 errors, not 0, and the reports now say so |

## 4 Final numbers

**Tests** (`npx vitest run`, from `apps/web`):

| Condition | Files | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| Idle | 58 passed, 1 skipped (59) | 567 | **563** | **0** | 4 |
| Concurrent `vite build` + headless capture | 58 passed, 1 skipped (59) | 567 | **563** | **0** | 4 |

The 4 skipped are the opt-in performance measurement, shown as skipped on every default
run. `NP_PERF=1` runs them against a recorded baseline.

**Other gates:**

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx eslint src test --max-warnings=0` | **exit 1 — 3 errors**, pre-existing, in two files this mission did not touch |
| `node scripts/assert-ui-contract.mjs` | **55/55**, exit 0 |
| `node scripts/verify-contract-assertions.mjs` | **9/9 mutants rejected**, exit 0 |
| `npx vite build` | exit 0 (7.3s idle, 15.7s under load) |
| `node scripts/ui-colour-audit.mjs` | 0 contrast failures, 0 raw palette utilities |
| `node scripts/ui-a11y-check.mjs` | **11/11**, stable across three runs |

## 5 Visual and accessibility coverage

**68 rendered captures**, each with a manifest recording the applied theme, `--type-scale`,
resolved root font and detail level:

- 20 routes at default configuration
- 4 routes × 4 disclosure levels (16)
- VPN Aether engine × 4 levels (4)
- NANI × 4 levels (4)
- Diagnostics × 3 levels (3)
- 4 viewport widths × 3 routes (12), no horizontal overflow at any
- Light theme (3), verified light rather than mislabelled
- Text scales 1.125 and 1.25 × 3 routes (6), read back from `--type-scale`

**Disclosure effect**, measured as content height: Dashboard 788 → 1165 → 1578 → 1647px;
VPN Overview 1436 → 2041 → 2189px; NANI 1 → 4 → 8 → 10 tabs; Diagnostics 495 → 702px.

**Contrast**: 192 text samples across 16 route × theme combinations, 36 distinct
foreground/background pairs, **0 failures**. Worst: 5.22:1 dark, 4.56:1 light.

**Accessibility**: 11 behavioural checks — roving tabindex, arrow/Home/End, APG wrapping,
focus retention, 30 controls all ≥24px, one `h1` + `lang` + `main` + `nav`, and hidden
levels unmounted (276 nodes at Essential vs 540 at Expert).

## 6 Repository state, and a change this mission did not make

| | At mission start | At mission end |
|---|---|---|
| Branch | `main` | `main` |
| HEAD | `6dd3929a3d5f1f87d176f624d6195c40288b9a51` | `354034747b8fff87be94d4f34c635f3efc0a2bcd` |
| Staged | 0 | 0 |
| Modified (tracked) | 21 | 2 |
| Untracked | 98 | 12 |

**Nothing was staged, committed, pushed or deployed by this mission, and no history was
rewritten.** HEAD nevertheless moved: five commits appeared during the session whose
messages describe this mission's work (`1399be6`, `350ffed`, `9eda132`, `503ce2a`,
`3540347`). No git hook is installed — `.git/hooks` contains only `*.sample` — so the
committing process is external to the repository. It is recorded as concurrent work, which
§1 asked to identify, and it was left exactly as found.

Two files remain uncommitted and are this mission's own final edits:
`apps/web/src/styles/identity.css` and `scripts/ui-capture.mjs`. Twelve untracked entries remain: this report set (9),
`apps/web/test/detailLevelComponent.test.tsx`, `scripts/ui-a11y-check.mjs`, plus
`reports/EXHAUSTIVE_AUDIT/EXHAUSTIVE_AUDIT_17_…` which the concurrent process created and
this mission did not touch.

Three transient vitest JSON reports this mission produced were deleted before handoff.

## 7 Remaining limitations

Ordered by what I would fix first.

1. **Phase 6 covers 4 of 27 routes.** The four densest. The other 23 have no level control
   and nothing indicates the concept exists. Condition C1/C2 in `_08`.
2. **No automated visual regression.** 68 captures are human evidence, not tests. No
   baseline image store, no pixel diff. A layout regression can ship with every gate
   green.
3. **No assistive-technology testing.** Keyboard behaviour was driven through DevTools; no
   screen reader was used. Whether the `aria-live="polite"` hint on the detail control
   announces is **unverified** — and communicating "there is more here" is the feature's
   entire purpose.
4. **K-06: three iteration cycles were not run.** An unmet process requirement.
5. **ESLint is not clean** — 3 errors in two pre-existing files. Deliberately not fixed.
6. **Interactive-state contrast is unmeasured** — hover, focus, disabled, placeholder. The
   audit samples rendered text only. Focus-ring contrast (WCAG 2.4.11) is not covered.
7. **The performance benchmark is manual.** A 3× regression is caught only when someone
   runs it; there is no CI timing gate. Deliberate — a blocking timing gate on shared
   hardware is the defect C-04 removed.
8. **Populated states were not demonstrated.** No backend. Diagnostics has no completed
   run, NANI no recorded investigation, VPN is disconnected, the map has no nodes. The
   gates that reveal that content are verified to exist; the content is not. Nothing was
   fabricated.
9. **`meta.color` is dead metadata** (8 hex values, referenced nowhere) — reported, not
   fixed, out of scope.
10. **`--color-faint` is declared in both `tokens.css` and `identity.css`**; the identity
    layer wins, so the tokens value is misleading. The rendered result is correct.
11. **Narrowest captured viewport is 768px.** No mobile layout, no 400% zoom/reflow test.
12. **No reduced-motion drive.** The contract asserts the `animate-*` rule exists; the
    behaviour under `prefers-reduced-motion: reduce` was not exercised in a browser.

## 8 What was done well enough to name

Two decisions are worth recording because they were the harder path:

**The performance test was split, not loosened.** Raising the thresholds until it passed
would have taken one line and would have removed the only signal that the map can cluster
5,000 nodes inside an interaction. Instead the wall clock was replaced by a property that
can fail deterministically, and the measurement was rebuilt with warm-up, sampling, a
baseline and a documented environment.

**Two claims were withdrawn rather than defended.** K-06 is recorded as an unmet
requirement, and the earlier "ESLint 0" is corrected in place with the actual 3 errors
named. Both are the K-10 failure mode, and both are the reason the rest of this report can
be taken at face value.

## 9 Independent revalidation

A second independent pass re-ran every gate against the delivered working tree on
2026-11-20T22:12Z. All gates confirmed. Three corrections were made to the verification
harness (not to the product):

1. **`detailLevelComponent.test.tsx`** — unused `import type { DetailLevel }` removed
   (mission-introduced file, in scope). ESLint: 3 errors in two pre-existing files.
2. **`scripts/ui-a11y-check.mjs`** — cost check updated to handle the dashboard's error
   state when the backend is unreachable (offers fewer levels). 11/11.
3. **Colour audit** — must be run against a live dev server. A dead server produces false
   failures from Chrome's own error page. 0 failures against a live server.

**Final verified numbers:**

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` | 58 files, 563 passed, 4 skipped, 0 failed |
| `npx eslint src test --max-warnings=0` | exit 1, 3 errors (pre-existing) |
| `node scripts/assert-ui-contract.mjs` | 55/55, exit 0 |
| `node scripts/verify-contract-assertions.mjs` | 9/9, exit 0 |
| `npx vite build` | exit 0 (7.75s) |
| `node scripts/ui-colour-audit.mjs` (live) | 0 failures, 0 raw palette, 10 distinct engine colours |
| `node scripts/ui-a11y-check.mjs` (live) | 11/11 |
| `NP_PERF=1 npx vitest run test/mapClusterPerf.test.ts` | 4/4, median 0.99ms |

## 10 Stop condition

Delivered. Nothing staged, committed, pushed or deployed. No history rewritten. Work
stops here pending further authorisation.

**Verdict: PASS WITH CONDITIONS.**
