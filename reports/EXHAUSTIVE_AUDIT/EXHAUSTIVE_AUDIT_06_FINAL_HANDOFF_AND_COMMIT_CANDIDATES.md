# EXHAUSTIVE_AUDIT_06 — Final handoff and exact commit candidate list

## Verdict

| Gate | Decision |
|---|---|
| Expanded-audit fix scope | **PASS** |
| Kim independent review | **PASS** |
| UI recovery scope (earlier mission) | **PASS** |
| Full release | **Separate decision; C3 still authorization-gated** |

## Git safety state

- Branch: `main`
- HEAD: `2a9f82593537aee39f799f72816fb0f282f630ec`
- Nothing staged
- No commit, push, deploy, reset, clean, amend, or force-push
- All pre-existing dirty and untracked work preserved

## What changed in the expanded phase

- Fixed 17 confirmed defects (report 02), including the HTTP probe never sending a request, plain HTTP against TLS endpoints, invalid registry literals, untyped recovery events, guessed step kinds, stale recovery controllers, the 44-error lint baseline, and three release-gate defects.
- Added three API regression files, a pipeline version-gate test, and updated two mocks plus the feed test.
- Closed C4 with independent evidence: `.no_proxy()`, TCP/HTTP route inference, additive route qualifiers, and guarded frontend failure-signal logic.
- Closed C6 with data-backed screenshots from a real API sidecar.
- Kept C3 open: no likelihood table or authorization policy was silently changed.
- Kim independently reviewed and passed the expanded fix scope.
- A final scripts/config audit found and fixed three release-gate defects: localhost feed activation, a false-green version check, and e2e checks that accepted HTTP 500. An independent recheck passed after the version check was anchored on the injected `appVersion` binding.

## Exact commit candidate list

This is the exact list I would stage **only if explicitly authorized**. It is the combined UI-recovery + expanded-audit change set. It excludes concurrent external work and scratch artifacts. Nothing is staged now.

```text
package.json
apps/api/src/app.ts
apps/api/src/routes/nani.ts
apps/api/src/services/naniProbeAdapter.ts
apps/api/src/services/naniService.ts
apps/api/src/services/systemProxy.ts
apps/api/test/naniEventContract.test.ts
apps/api/test/naniProbeAdapterHttp.test.ts
apps/api/test/naniProbeAdapterTls.test.ts
apps/api/test/naniRecoveryControls.test.ts
apps/api/test/naniShadowAssessment.test.ts
apps/web/src/app/AppShell.tsx
apps/web/src/app/nav.ts
apps/web/src/components/GlobalConnectionChip.tsx
apps/web/src/components/PulseMark.tsx
apps/web/src/components/ui/Badge.tsx
apps/web/src/components/ui/Button.tsx
apps/web/src/components/ui/Card.tsx
apps/web/src/components/ui/Field.tsx
apps/web/src/components/ui/Metric.tsx
apps/web/src/components/ui/Segmented.tsx
apps/web/src/components/ui/States.tsx
apps/web/src/components/ui/Surface.tsx
apps/web/src/components/ui/Switch.tsx
apps/web/src/components/ui/Tabs.tsx
apps/web/src/components/ui/Tooltip.tsx
apps/web/src/components/ui/tabStyles.ts
apps/web/src/features/connection/ConnectionDial.tsx
apps/web/src/features/connection/ConnectionHero.tsx
apps/web/src/features/connection/connectionState.ts
apps/web/src/features/copilot/CopilotPage.tsx
apps/web/src/features/copilot/aiApi.ts
apps/web/src/features/dashboard/DashboardPage.tsx
apps/web/src/features/health/SystemHealthPage.tsx
apps/web/src/features/nani/NaniPage.tsx
apps/web/src/features/nani/hypothesisView.test.ts
apps/web/src/features/nani/hypothesisView.ts
apps/web/src/features/nani/naniApi.ts
apps/web/src/features/nani/naniEvents.test.ts
apps/web/src/features/nani/naniEvents.ts
apps/web/src/features/nani/useNaniEvents.ts
apps/web/src/features/settings/SettingsPage.tsx
apps/web/src/features/vpn/AdaptiveRecoveryCard.tsx
apps/web/src/lib/updater.ts
apps/web/src/lib/useStartupHealth.ts
apps/web/src/lib/ws.ts
apps/web/src/main.tsx
apps/web/src/styles/identity.css
apps/web/src/styles/tokens.css
apps/web/test/recoveryRegressions.test.ts
apps/web/test/typeScale.test.ts
apps/web/vite.recovery.config.mjs
packages/shared/src/nani/events.ts
packages/shared/src/nani/registry.ts
scripts/assert-ui-contract.mjs
scripts/e2e-desktop.mjs
scripts/lib/updateFeed.mjs
scripts/lib/webDistVersion.mjs
scripts/release.mjs
scripts/ui-capture.mjs
scripts/ui-probe.mjs
scripts/update-feed.test.mjs
scripts/verify-desktop-pipeline.mjs
scripts/verify-desktop-pipeline.test.mjs
src-tauri/src/commands/nani.rs
src-tauri/src/network_intelligence/api_intelligence/monitor.rs
src-tauri/src/network_intelligence/api_intelligence/registry.rs
src-tauri/src/network_intelligence/diagnosis.rs
src-tauri/src/network_intelligence/evaluation.rs
src-tauri/src/network_intelligence/events/mod.rs
src-tauri/src/network_intelligence/foundation.rs
src-tauri/src/network_intelligence/investigation.rs
src-tauri/src/network_intelligence/persistence.rs
src-tauri/src/network_intelligence/validation.rs
reports/FINAL_UI_RECOVERY_01_BASELINE.md
reports/FINAL_UI_RECOVERY_02_P1_ROOT_CAUSE_ANALYSIS.md
reports/FINAL_UI_RECOVERY_03_P1_FIX_REPORT.md
reports/FINAL_UI_RECOVERY_04_C1_C7_CLOSURE.md
reports/FINAL_UI_RECOVERY_05_EVIDENCE_INTEGRITY.md
reports/FINAL_UI_RECOVERY_06_RUST_STABILITY.md
reports/FINAL_UI_RECOVERY_07_BUILD_VERIFICATION.md
reports/FINAL_UI_RECOVERY_08_VISUAL_VERIFICATION.md
reports/FINAL_UI_RECOVERY_09_REGRESSION_TESTS.md
reports/FINAL_UI_RECOVERY_10_REMAINING_FINDINGS.md
reports/FINAL_UI_RECOVERY_11_KIM_INDEPENDENT_REVIEW.md
reports/FINAL_UI_RECOVERY_12_FINAL_HANDOFF.md
reports/UI_MASTER_02_DESIGN_SYSTEM.md
reports/UI_MASTER_09_MOTION_AND_MICROINTERACTIONS.md
reports/UI_MASTER_10_ACCESSIBILITY.md
reports/UI_MASTER_11_FRONTEND_PERFORMANCE.md
reports/EXHAUSTIVE_AUDIT/EXHAUSTIVE_AUDIT_01_SCOPE_AND_BASELINE.md
reports/EXHAUSTIVE_AUDIT/EXHAUSTIVE_AUDIT_02_CONFIRMED_DEFECTS_AND_FIXES.md
reports/EXHAUSTIVE_AUDIT/EXHAUSTIVE_AUDIT_03_EVIDENCE_INTEGRITY.md
reports/EXHAUSTIVE_AUDIT/EXHAUSTIVE_AUDIT_04_VERIFICATION_MATRIX.md
reports/EXHAUSTIVE_AUDIT/EXHAUSTIVE_AUDIT_05_INDEPENDENT_REVIEW.md
reports/EXHAUSTIVE_AUDIT/EXHAUSTIVE_AUDIT_06_FINAL_HANDOFF_AND_COMMIT_CANDIDATES.md
reports/EXHAUSTIVE_AUDIT/api-egress-after-fix.log
reports/EXHAUSTIVE_AUDIT/api-tests-after-nani-fixes.log
reports/EXHAUSTIVE_AUDIT/api-tests-final.log
reports/EXHAUSTIVE_AUDIT/api-tls-path-tests.log
reports/EXHAUSTIVE_AUDIT/api-typecheck-after-nani-fixes.log
reports/EXHAUSTIVE_AUDIT/build-final.log
reports/EXHAUSTIVE_AUDIT/cargo-clippy-baseline.log
reports/EXHAUSTIVE_AUDIT/desktop-verify-after-scripts-fix.log
reports/EXHAUSTIVE_AUDIT/feed-tests-after-scripts-fix.log
reports/EXHAUSTIVE_AUDIT/full-workspace-tests-baseline.log
reports/EXHAUSTIVE_AUDIT/full-workspace-tests-final.log
reports/EXHAUSTIVE_AUDIT/lint-after-nani-fixes.log
reports/EXHAUSTIVE_AUDIT/lint-baseline.log
reports/EXHAUSTIVE_AUDIT/lint-final.log
reports/EXHAUSTIVE_AUDIT/pipeline-version-tests.log
reports/EXHAUSTIVE_AUDIT/rust-full-after-exhaustive-fixes.log
reports/EXHAUSTIVE_AUDIT/rust-proxy-tests.log
reports/EXHAUSTIVE_AUDIT/rust-tests-final.log
reports/EXHAUSTIVE_AUDIT/ui-contract-final.log
reports/EXHAUSTIVE_AUDIT/visual-data-backed.log
reports/EXHAUSTIVE_AUDIT/visual-data-backed/01-dashboard.png
reports/EXHAUSTIVE_AUDIT/visual-data-backed/03-nani-overview.png
reports/EXHAUSTIVE_AUDIT/visual-data-backed/07-nani-network.png
reports/EXHAUSTIVE_AUDIT/visual-data-backed/08-copilot.png
reports/EXHAUSTIVE_AUDIT/visual-data-backed/10-settings.png
reports/EXHAUSTIVE_AUDIT/visual-data-backed/manifest.json
reports/EXHAUSTIVE_AUDIT/web-after-proxy-fix.log
reports/EXHAUSTIVE_AUDIT/web-full-after-exhaustive-fixes.log
reports/EXHAUSTIVE_AUDIT/web-tests-after-nani-fixes.log
reports/EXHAUSTIVE_AUDIT/web-tests-final.log
reports/EXHAUSTIVE_AUDIT/web-typecheck-after-nani-fixes.log
reports/FINAL_UI_visual_recovery/build-final.log
reports/FINAL_UI_visual_recovery/config.json
reports/FINAL_UI_visual_recovery/config2.json
reports/FINAL_UI_visual_recovery/rec-01-dashboard-connection-hero.png
reports/FINAL_UI_visual_recovery/rec-02-settings-general.png
reports/FINAL_UI_visual_recovery/rec-03-settings-network-clicked.png
reports/FINAL_UI_visual_recovery/rec-04-settings-platform.png
reports/FINAL_UI_visual_recovery/rec-05-copilot-empty.png
reports/FINAL_UI_visual_recovery/rec-06-nani.png
reports/FINAL_UI_visual_recovery/rec-07-dashboard-narrow.png
reports/FINAL_UI_visual_recovery/rec-08-copilot-light.png
reports/FINAL_UI_visual_recovery/rec-manifest.json
reports/FINAL_UI_visual_recovery/rust-final-2.log
reports/FINAL_UI_visual_recovery/rust-final.log
reports/FINAL_UI_visual_recovery/rust-n0-isolated.log
reports/FINAL_UI_visual_recovery/ui-contract-final.log
reports/FINAL_UI_visual_recovery/v2-01-dashboard-connection-hero.png
reports/FINAL_UI_visual_recovery/v2-02-settings-general.png
reports/FINAL_UI_visual_recovery/v2-03-settings-network.png
reports/FINAL_UI_visual_recovery/v2-04-settings-platform.png
reports/FINAL_UI_visual_recovery/v2-05-copilot-empty.png
reports/FINAL_UI_visual_recovery/v2-06-nani.png
reports/FINAL_UI_visual_recovery/v2-07-dashboard-narrow.png
reports/FINAL_UI_visual_recovery/v2-08-copilot-light.png
reports/FINAL_UI_visual_recovery/v2-manifest.json
reports/FINAL_UI_visual_recovery/web-tests-final.log
reports/FINAL_UI_visual_recovery/web-typecheck-final.log
```

## Deliberately excluded

These were dirty in the working tree but are not part of the coherent fix set I authored, or are scratch artifacts:

- `.tmp-desktop-dev.log`, `.workbuddy-ai/`, generated build directories outside the repository.
- Concurrent external edits observed during verification: `apps/web/src/components/EngineBadge.tsx`, `apps/web/src/features/map/LiveMapPage.tsx`, `apps/web/src/features/account/AccountPage.tsx`, `apps/web/src/features/nodes/NodeDetailPage.tsx`, `apps/web/src/features/nodes/NodeExplorerPage.tsx`, `apps/web/src/features/vpn/AetherCore.tsx`, `apps/web/src/features/vpn/AetherSurface.tsx`, `apps/web/src/features/vpn/AgentPathTrace.tsx`, `apps/web/src/features/vpn/OverviewSurface.tsx`, `apps/web/src/features/vpn/QuickConnectActivity.tsx`, `apps/web/src/features/vpn/TunnelSurface.tsx`, `apps/web/src/features/vpn/VpnPage.tsx`, `apps/web/src/features/vpn/engineMeta.ts`, `apps/web/test/designPrimitives.test.tsx`, `scripts/unify-palette.mjs`.
- Pre-existing report corpora not produced by these missions (`FINAL_UI_*` before recovery, `UI_REVIEW_*`, most `UI_MASTER_*`, `NANI_AUDIT_*`, `N0_*`, `N1_*`, and unrelated screenshot directories).
- `NANI_ADVERSARIAL_TEST_REPORT.md`.

## Next authorized actions

1. Explicitly authorize or separate C3 math changes.
2. Decide whether to include the concurrent external UI files in a separate commit after their own review.
3. Only after both, consider a full release-gate re-review.

No commit has been made.
