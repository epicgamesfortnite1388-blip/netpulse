# ULTIMATE ROADMAP RECONSTRUCTION

**Reconstructed:** 2026-11-16 from verified source state.

> **Preservation note:** the repository already contained an active `ROADMAP.md` (the "FABLE master execution plan", sourced from `reports/FABLE_MASTER_ROADMAP.md`). Per the audit's preservation rules it was **left untouched**. This document is the independent reconstruction requested by the audit; it is also mirrored at `ROADMAP_ULTIMATE.md`. The two roadmaps largely agree on Wave 0 (commit in-flight work, delete dead UI, desktop gate) — that convergence is corroborating evidence, not duplication.

**Status legend:** ✅ COMPLETE · 🟡 IMPLEMENTED BUT UNVERIFIED · 🟠 PARTIAL · 🔴 BROKEN · ⬜ NOT IMPLEMENTED · 🟣 BLOCKED · 🔵 DESIGN DECISION. **No time estimates or percentages are fabricated.**

---

## How old claims were checked

Every pre-existing `NANI_*.md`, `V3_*.md`, and `reports/NANI_*` claim was compared against source. Findings: most "real" claims hold (engines, math primitives, security). Claims that did **not** hold: (a) the 10-stage pipeline is actually 4 stages; (b) confidence is uncalibrated in production; (c) InterfaceCheck and correlation-window logic were broken (now fixed); (d) the verify stage is inverted. These are recorded as BROKEN/PARTIAL above rather than trusting the reports.

---

## Stage A — Repository Recovery

| ID | Outcome | Status | Pri | Files | Acceptance | Verify | Cx |
|---|---|---|---|---|---|---|---|
| A1 | Stale `LocalInterface` binding removed | ✅ | P0 | `diagnosis.rs` | warnings gone + test | `cargo test` | S |
| A2 | Correlation-window reset fixed | ✅ | P0 | `diagnosis.rs` | long-gap test | `cargo test` | S |
| A3 | NANI store never writes empty files | ✅ | P0 | `persistence.rs` | error propagates | `cargo test` | S |
| A4 | Vault key ACL allows rotation+delete | ✅ | P0 | `keychain.ts`,`vpnService.ts` | 74 vault tests | `vitest` | S |
| A5 | Sub-12px type violations fixed | ✅ | P1 | `CopilotPage.tsx`,`NaniPage.tsx` | typeScale tests | `vitest` | S |
| A6 | Commit untracked NANI source to a branch | ⬜ | **P0** | all untracked `network_intelligence/*`, `features/nani*` | no untracked core source | `git status` | S |
| A7 | Explicit transactions for multi-statement API units | ⬜ | P1 | `repositories.ts`,`retention.ts` | partial-failure test | `vitest` | M |
| A8 | Regenerate drizzle snapshots 0001–0013 | ⬜ | P2 | `apps/api/drizzle/meta/` | `db:generate` clean | `npm run db:generate` | M |
| A9 | Renumber duplicate `0005_*` migrations | ⬜ | P3 | `cloud/worker/migrations/` | unique numbers | wrangler dry-run | S |

## Stage B — Core Reliability

| ID | Outcome | Status | Pri | Files | Acceptance | Verify | Cx |
|---|---|---|---|---|---|---|---|
| B1 | Poison-recovering locks in `setup()` | ⬜ | P1 | `main.rs:394-431` | startup survives poisoned lock | `cargo test` | S |
| B2 | Fix `+inf` softmax poisoning | ⬜ | P1 | `math.rs`,`bayesian.rs` | `+inf` test | `cargo test` | S |
| B3 | Sink-level log redaction | ⬜ | P1 | `logging.rs`,`sidecar.rs` | token line redacted on disk | unit test | M |
| B4 | Correct/re-document `credible_interval`/BOCPD/PH | ⬜ | P2 | `probability.rs`,`changepoint.rs`,`drift.rs` | doc=impl+test | `cargo test` | M |
| B5 | Wire calibrator OR label confidence uncalibrated | 🔵 | P1 | `evaluation.rs`,`naniService.ts` | honest confidence | test+UI | M |

## Stage C — VPN Engine Reliability

| ID | Outcome | Status | Pri | Files | Acceptance | Verify | Cx |
|---|---|---|---|---|---|---|---|
| C1 | Failed verification revokes `connected` | 🔵 | **P0** | `vpnService.ts:366-372` | failed IP diff → not green | per-engine test | M |
| C2 | OpenVPN verification to WG standard | 🟠 | P1 | `vpnService.ts:770-977` | management/route check | live proof | M |
| C3 | sing-box proxy mode proves traffic | 🟠 | P2 | `vpnService.ts:1472-1481` | one real request | live proof | S |
| C4 | Staged connection test (proc/iface/route/DNS/reach) | 🟡 | P1 | `vpnService.ts` | staged assertions | `proof:vpn` | L |

## Stage D — NANI Intelligence

| ID | Outcome | Status | Pri | Files | Acceptance | Verify | Cx |
|---|---|---|---|---|---|---|---|
| D1 | Verify stage targets implicated API; no inverted confirmation | 🔴 | **P0** | `investigation.rs:726-741,512-516` | correct narrative+test | `cargo test` | M |
| D2 | Learning requires verified outcomes | 🟠 | P1 | `learning.rs:320-335,370` | unverified cannot promote | `cargo test` | M |
| D3 | Remove/mark hardcoded probe reliabilities | 🔴 | P1 | `naniProbeAdapter.ts:61-146` | no asserted confidence | test | M |
| D4 | Validate LLM narrative before `grounded` | 🟠 | P2 | `ai/explanation.rs:116-123` | grounded only if supported | test | M |
| D5 | Decide/test evidence double-weighting | 🔵 | P2 | `diagnosis.rs:647-653`,`bayesian.rs:204-207` | documented+tested | `cargo test` | S |
| D6 | True EIG vs KL-proxy | 🟠 | P2 | `information_theory.rs:62-101` | ranking correctness | test | M |

## Stage E — Application Experience

| ID | Outcome | Status | Pri | Files | Acceptance | Verify | Cx |
|---|---|---|---|---|---|---|---|
| E1 | Map `setInterval` leak | 🔴 | P1 | `LiveMapPage.tsx:347-362` | cleanup on unmount | test | S |
| E2 | Async `listen()` leak | 🔴 | P1 | `useNaniEvents.ts:82-94`,`useStartupHealth.ts:211-214` | cancelled guard | test | S |
| E3 | Single validated NANI event contract (zod) | 🟠 | P1 | `shared/src/nani/events.ts`,`events/mod.rs`,`naniEvents.ts` | payloads validated | contract test | M |
| E4 | Wire/remove 10 dead `nani_*` commands | ⬜ | P2 | `main.rs:278-298` | no dead IPC | grep+build | S |
| E5 | Consolidate NANI state | 🟠 | P2 | `naniStore.ts`,`useNaniEvents.ts` | one cursor | test | M |
| E6 | Correct Copilot web-mode story | 🔴 | P2 | `CopilotPage.tsx`,`aiApi.ts` | honest availability | UI test | S |
| E7 | Route/remove `nani-reports-page.tsx` | ⬜ | P3 | `nani-reports/` | routed or deleted | build | S |

## Stage F — Product Integration

| ID | Outcome | Status | Pri | Files | Acceptance | Verify | Cx |
|---|---|---|---|---|---|---|---|
| F1 | Surface entitlement state at top level | 🟡 | P2 | `TelegramIntegrationCard.tsx:189` | visible expiry | UI test | S |
| F2 | Resolve in-app payment gap (decision) | 🔵 | P2 | `AccountPage` | documented decision | — | M |
| F3 | Stop swallowing entitlement/audit failures | 🟠 | P1 | `netpulse-integration.ts`,`netpulse-sessions.ts` | failures surfaced | test | S |
| F4 | Remove/implement dead `/ai/ask`,`/ai/stream` | ⬜ | P2 | `cloud/worker/src/index.ts` | 200 or gone | test | S |

## Stage G — Testing and Release

| ID | Outcome | Status | Pri | Files | Acceptance | Verify | Cx |
|---|---|---|---|---|---|---|---|
| G1 | Desktop build + launch + visual verification | ⬜ | **P0** | `src-tauri` | screenshots all pages | `desktop:build`+manual | L |
| G2 | Live VPN proof per engine | 🟡 | **P0** | `scripts/vpn-live-proof.mjs` | OS-level assertions | `proof:vpn` | L |
| G3 | Contract test: every `nani:event` validates | ⬜ | P2 | events | schema test | both suites | M |
| G4 | Transaction rollback tests | ⬜ | P2 | db | partial-failure test | `vitest` | M |
| G5 | Run clippy + fmt gates | 🟣 | P2 | — | install components | `cargo clippy` | S |
| G6 | Installer + upgrade/recovery verification | ⬜ | P1 | `scripts/` | install/upgrade test | manual | L |

---

## Critical path
**A6 (preserve untracked work) → C1 (connected honesty) → D1 (verify stage) → G1/G2 (build + live proof).** A6 first because untracked work has no recovery point.

## Deferred (need sign-off)
- VPN verification model rewrite; production calibration; removing dual NANI implementations.
