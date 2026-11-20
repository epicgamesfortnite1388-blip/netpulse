# EXHAUSTIVE_AUDIT_15 — Remaining work inventory after the approved commit

## Purpose

After the approved local commit `6dd3929a3d5f1f87d176f624d6195c40288b9a51`, work continued with a read-only review of the remaining dirty tree. No file was staged, committed, reset, or modified by this continuation. New evidence logs and this report are untracked.

## Current anchor

| Item | Value |
|---|---|
| Branch | `main...origin/main [ahead 15]` |
| HEAD | `6dd3929a3d5f1f87d176f624d6195c40288b9a51` |
| Committed paths | 171 |
| Remaining dirty entries | 21 modified, 97 untracked |

## Critical finding — committed HEAD is not self-contained

The approved 171-path commit included `scripts/assert-ui-contract.mjs`, which fails when compiled CSS contains raw Tailwind palette utilities (`assertNoRawPalette`, lines 161–169).

Evidence:

- `git grep HEAD -- apps/web/src` finds many raw palette utilities, including:
  - `EngineBadge.tsx:18-21` — `text-sky-400`, `bg-sky-500/10`, `text-emerald-400`, `text-violet-400`
  - `AetherCore.tsx:82-85` — `from-violet-500/70`, `via-cyan-400/50`, `to-fuchsia-400/40`
  - `QuickConnectActivity.tsx:31-47` — `text-cyan-300`, `text-violet-300`, `text-red-300`, etc.
  - `NodeExplorerPage.tsx`, `AetherSurface.tsx`, `AgentPathTrace.tsx`, `OverviewSurface.tsx`, `TunnelSurface.tsx`, `VpnPage.tsx`, `AccountPage.tsx`
- `git grep` over the current working tree finds **zero** raw palette utilities in `apps/web/src`.
- The UI contract passes only because those cleanup edits are present in the working tree at build time.

Conclusion: on a clean checkout of `6dd3929`, `npm run build && npm run test:ui-contract` is expected to fail `assertNoRawPalette`. The commit was valid for the then-current working tree, but the committed snapshot is not self-contained. This requires a follow-up authorization to stage the palette-cleanup files.

## Concurrent work still landing

Several files changed again after the commit was created:

- `apps/web/src/components/ui/Segmented.tsx` — adds WAI-ARIA radiogroup keyboard behavior (arrows, Home/End, single tab stop).
- `apps/web/src/features/dashboard/DashboardPage.tsx` — adds `DetailLevelProvider`, `DetailLevelControl`, and `DetailGate` gating.
- `apps/web/src/features/nani/NaniPage.tsx` — adds detail-level imports, provider, and tab visibility filtering.
- `apps/web/src/features/vpn/VpnPage.tsx` — adds detail-level provider and gating.
- `apps/web/src/features/diagnostics/DiagnosticsPage.tsx` — adds detail-level provider and gating.
- Untracked `apps/web/src/components/ui/DetailLevel.tsx` and `apps/web/src/lib/detailLevel.ts` support this rollout.

During verification these files were observed mid-write:

- First build failed on incomplete `VpnPage.tsx` JSX.
- Second typecheck failed on missing imports in `NaniPage.tsx`.
- Final typecheck passed.
- Final build failed because `DiagnosticsPage.tsx` currently lacks closing `</DetailGate>` and `</DetailLevelProvider>` tags at the end of the file.
- UI contract passed in all three runs against the last successfully generated CSS.

No cleanup or correction was attempted. The current build must be rechecked after the concurrent edits settle.

## Remaining UI palette cleanup group

These files appear to be the tail of the same audit/design-system pass, not independent third-party work:

- `apps/web/src/components/EngineBadge.tsx`
- `apps/web/src/features/account/AccountPage.tsx`
- `apps/web/src/features/diagnostics/DiagnosticsPage.tsx`
- `apps/web/src/features/map/LiveMapPage.tsx`
- `apps/web/src/features/nodes/NodeDetailPage.tsx`
- `apps/web/src/features/nodes/NodeExplorerPage.tsx`
- `apps/web/src/features/vpn/AetherCore.tsx`
- `apps/web/src/features/vpn/AetherSurface.tsx`
- `apps/web/src/features/vpn/AgentPathTrace.tsx`
- `apps/web/src/features/vpn/OverviewSurface.tsx`
- `apps/web/src/features/vpn/QuickConnectActivity.tsx`
- `apps/web/src/features/vpn/TunnelSurface.tsx`
- `apps/web/src/features/vpn/VpnPage.tsx`
- `apps/web/src/features/vpn/engineMeta.ts`
- `apps/web/test/designPrimitives.test.tsx`
- `scripts/oneoff/unify-palette.mjs`

Static review found no token mismatch, syntax defect, or broken contract in the palette migration itself. Two minor observations:

- `QuickConnectActivity.tsx` still contains `border-white/5` and `bg-black/20`; these are outside the gate’s palette-family regex but are stylistically inconsistent.
- The header of `designPrimitives.test.tsx` says “four decisions” while there are five `describe` blocks.

## C3 boundary — still held

The six C3 files remain modified and uncommitted. The pending diff contains substantive math changes, not mechanical cleanup:

- `diagnosis.rs`: eight `LikelihoodTable::signature()` residual probabilities change; `observe_recording_confirmation()` labels calibration pairs from the same likelihood table used for prediction; fully successful probe rounds can now yield `unknown` with posterior > 0.5.
- `validation.rs`: `TemperatureScaling` is deleted; `IsotonicCalibrator::fit` is rewritten; Beta shrink and adjacency pooling are introduced; `MIN_CALIBRATION_SAMPLES = 30` is currently unused.
- `foundation.rs`: `HypothesisView` gains calibrated confidence and sample-count fields; `hypothesis_view_with()` and `observe_probe_recording()` are added; `ProbeSelection` fields are removed.
- `persistence.rs`: bounded `(f64, f64)` calibration-sample journal added.
- `evaluation.rs`: absolute ECE bar replaced with relative Brier/log-loss comparisons; condition-bin evaluation added.
- `commands/nani.rs`: timestamp conversion from milliseconds to seconds, event publication, and persistence of calibration samples.

These changes alter authoritative verdict behavior and confidence semantics. They require explicit written C3 authorization, fresh Rust tests on the exact candidate set, timestamp-unit proof, UI honesty verification, and resolution of the unused minimum-sample gate before staging. Do not fold them into the UI follow-up.

## Other remaining entries

- `NANI_ADVERSARIAL_TEST_REPORT.md` — pre-existing user work.
- Pre-existing report corpora (`FINAL_UI_*` outside the committed recovery set, `UI_REVIEW_*`, `NANI_AUDIT_*`, `N0_*`, `N1_*`, `N1_2_*`, most `UI_MASTER_*`, screenshot directories) — uncommitted and untouched.
- `.tmp-desktop-dev.log`, `.workbuddy-ai/`, generated directories, and temporary browser profiles — local state.
- `EXHAUSTIVE_AUDIT_14_APPROVED_LOCAL_COMMIT_EXECUTION.md` and this report — new evidence, intentionally uncommitted.

## Decisions required from the user

1. Authorize a follow-up commit for the palette cleanup plus the detail-level rollout, after the concurrent edits settle and a clean build/UI contract check passes.
2. Explicitly authorize or permanently defer the C3 math changes.
3. Confirm whether the pre-existing report corpora should remain untracked or be handled in a separate documentation commit.
4. Confirm whether local state and scratch artifacts should remain untouched.

No follow-up commit was created. No C3 math was changed. No external UI file was edited or staged.
