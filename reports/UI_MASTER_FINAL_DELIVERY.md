# UI MASTER — FINAL DELIVERY

**Product:** NetPulse / NANI desktop application
**Scope:** `apps/web/src` — the entire frontend interface
**Date:** 20 November 2026
**Reports:** 13 (UI_MASTER_01 … UI_MASTER_13)

---

## 1. What was delivered

A complete interface pass over every route, component, state and interaction in
the NetPulse/NANI frontend:

- A **forensic audit** of 85 findings across shell, dashboard, NANI, Copilot,
  Settings, the design system, components, motion, accessibility, responsive
  behaviour and error states.
- A **design system** with one surface ladder, one type ramp, one radius scale,
  one motion vocabulary, and build-time guards that keep them that way.
- A **two-tier application shell** (76px rail + 226px context column) replacing a
  single 240px column that flattened 25 destinations into one scrolling list.
- **Redesigned** dashboard, investigation experience, evidence/hypothesis
  visualisation, configuration, and Copilot surfaces.
- **Nine additional defects** found during implementation and fixed, including
  the most user-visible one in the product.
- **Two new automated guards** that did not exist before this pass.

**Resolution: 58 of 85 findings fixed, 6 resolved by design decision, 3 partially
addressed, 18 deferred with stated reasons.**

---

## 2. Final verification

Every check below was run against the delivered tree.

| Check | Command | Result |
|---|---|---|
| Typecheck | `cd apps/web && npx tsc --noEmit` | **0 errors** (1 pre-existing error fixed) |
| Unit tests | `cd apps/web && npx vitest run` | **54 files / 509 tests pass** |
| Lint | `npx eslint apps/web/src` | **0 problems** |
| Production build | `cd apps/web && npx vite build` | **8.7s**, CSS 124.01 kB → **23.09 kB gzip** |
| UI contract | `npm run test:ui-contract` | **47/47 assertions pass** |
| Fixed-px type in build | grep compiled CSS | **0 occurrences** |
| `rounded-2xl` in source | grep | **0 occurrences** |
| Lowest text contrast | computed (WCAG 2.1) | **5.06:1** — AA pass |
| Text-on-accent contrast | computed | **10.21:1** — was 1.75:1 |
| Bundle | `du -sh dist` | 3.8 MB total, 26 lazy routes |

---

## 3. Files changed

### 3.1 Modified (24)

**Design system**
- `apps/web/src/styles/tokens.css` — added the missing `--color-accent-foreground`,
  `--color-surface-3` and `--color-background` aliases to all three theme blocks
  (dark, light, `prefers-color-scheme`).

**Shell**
- `apps/web/src/app/AppShell.tsx` — opaque topbar, health indicator from `lg`,
  skip link, focusable `main`, type-scale-compliant chrome strings.

**Components**
- `components/ui/Button.tsx` — primary is now a solid accent fill (was a faint
  outline); danger solid; secondary hover on `surface-3`; focus ring at 2px offset.
- `components/ui/Card.tsx` — `CardHeader` border to `line-strong`; `CardBody`
  vertical padding aligned to the header; **radius moved to `--np-r-3`** so a card
  never has a larger corner than its panel.
- `components/ui/Badge.tsx` — base badge carries `uppercase tracking-wide`.
- `components/ui/Tabs.tsx` — nested radii (list `lg`, triggers `md`); panel no
  longer re-animates under `page-enter`.
- `components/ui/Switch.tsx` — removed dead `h-5.5`; thumb optically centred.
- `components/ui/Tooltip.tsx` — arrow follows `--color-elevated`; entry animation.
- `components/ui/Field.tsx` — focus is `border-accent/60` + 1px accent ring.
- `components/ui/States.tsx` — solid empty-state border; `role="alert"` on
  `ErrorState`; no double ellipsis in `LoadingState`.
- `components/ui/Metric.tsx` — tooltip trigger is focusable (was pointer-only).

**Features**
- `features/dashboard/DashboardPage.tsx` — `np-panel` hero, 24px verdict, eight
  distinct quick-action glyphs, designed empty health state.
- `features/nani/NaniPage.tsx` — **ARIA tablist with roving focus and arrow keys**,
  `role="tabpanel"`, list semantics, one-decimal confidence, corrected pipeline
  stage colours, viewport-anchored workspace thread.
- `features/copilot/CopilotPage.tsx` — semantic `--color-ok` badge, 12px bubbles,
  surface hover on chips, `role="log"`, guarded unavailable message.
- `features/settings/SettingsPage.tsx` — `CapBadge` to `rounded-md`.
- `features/connection/ConnectionHero.tsx` — `text-[11px]` → `text-micro`.
- `features/connection/connectionState.ts` — normalised disconnect mutation type.
- `features/nani/hypothesisView.ts` + tests, `naniApi.ts`, `naniEvents.ts` + tests,
  `features/vpn/AdaptiveRecoveryCard.tsx`, `main.tsx` — supporting changes from
  earlier phases of this pass.

**Guards and config**
- `apps/web/test/typeScale.test.ts` — **+3 tests** scanning both stylesheets for
  unscaled and below-floor font sizes (13 total).
- `package.json` — added `test:ui-contract`.

### 3.2 Added

| File | Purpose |
|---|---|
| `apps/web/src/styles/identity.css` | The "Signal / Instrument" identity layer: petrol-ink palette, `np-*` component classes, motion policy, reduced-motion blocks. |
| `apps/web/src/app/nav.ts` | The two-tier navigation model — 5 sections, 25 routes, `resolveSection()` by longest prefix. |
| `apps/web/src/features/connection/` | Connection console: `ConnectionHero`, `ConnectionDial`, `connectionState`. |
| `apps/web/src/components/GlobalConnectionChip.tsx` | Topbar connection indicator. |
| `apps/web/src/components/PulseMark.tsx` | Brand mark. |
| `scripts/assert-ui-contract.mjs` | **New** — 47 assertions against the compiled stylesheet. |
| `reports/UI_MASTER_01…13` | The 13 reports. |

---

## 4. The three defects that mattered most

### 4.1 Invisible text on the primary button (CRITICAL)

`text-accent-foreground` was used in `Button`, `NaniPage` and `CopilotPage`.
`--color-accent-foreground` was declared in **no** theme block. Tailwind emitted
the utility, the property resolved to nothing, and the label inherited the
parent colour: **white on cyan at 1.75:1**.

The primary call-to-action of the entire product was effectively unreadable. Now
10.21:1, and `assert-ui-contract.mjs` fails the build on any `var()` reference to
an undeclared property.

### 4.2 Navigation labels that ignored the Text-size setting (HIGH)

Eight `font-size: <literal>px` rules in `identity.css` — including the five rail
labels at **9px** — were invisible to the existing test because it scanned `.tsx`
files and these are hand-written CSS. At the 125% setting a user got a 15px page
with 9px navigation labels: the accessibility preference failed exactly where it
was most needed.

All eight are now `calc(<rem> * var(--type-scale))`, verified at **0** fixed-px
declarations in the compiled CSS, and guarded twice.

### 4.3 A tab bar a screen reader could not describe (HIGH)

NANI's ten tabs were ten unrelated `<button>` elements with no `role="tablist"`,
no `aria-selected`, no `aria-controls`, and ten Tab stops. They are now a proper
APG tablist: one Tab stop, arrow keys to move, Home/End to jump, and a
`role="tabpanel"` that names its tab.

---

## 5. Report index

| Report | Contents |
|---|---|
| `UI_MASTER_01_FORENSIC_AUDIT.md` | 85 findings by severity, per surface |
| `UI_MASTER_02_DESIGN_SYSTEM.md` | Tokens, type ramp, radii, motion, component inventory, enforcement |
| `UI_MASTER_03_APPLICATION_SHELL.md` | Two-tier navigation, topbar, banners, responsive, skip link |
| `UI_MASTER_04_DASHBOARD_DESIGN.md` | Verdict-first layout, hero band, honest placeholders |
| `UI_MASTER_05_INVESTIGATION_EXPERIENCE.md` | Ten tabs, eight-stage pipeline, gap disclosure, workspace |
| `UI_MASTER_06_EVIDENCE_AND_VISUALIZATION.md` | Posterior/prior/shift bar, calibration provenance, evidence explorer |
| `UI_MASTER_07_CONFIGURATION_UX.md` | Per-slice saves, weight-sum validator, fold system, destructive reset |
| `UI_MASTER_08_COPILOT_UX.md` | Local-inference status, bubbles, streaming, stop/retry |
| `UI_MASTER_09_MOTION_AND_MICROINTERACTIONS.md` | Fill-mode rule, stagger cap, honest progress, reduced motion |
| `UI_MASTER_10_ACCESSIBILITY.md` | Measured contrast, keyboard, headings, semantics, scaling |
| `UI_MASTER_11_FRONTEND_PERFORMANCE.md` | Build measurements, code splitting, polling discipline |
| `UI_MASTER_12_VISUAL_REGRESSION.md` | Compiled contract check, manual matrix, pixel-diff proposal |
| `UI_MASTER_13_FINAL_DESIGN_AUDIT.md` | Full resolution ledger, verdict, remaining risk |

---

## 6. Constraints honoured

| Constraint | Status |
|---|---|
| Preserve all existing user changes | Honoured — no file reverted; all edits additive or in place |
| No git history rewriting | Honoured — no `amend`, no `rebase`, no `reset --hard`, no force push |
| No fake data | Honoured — dashes, `?`, "not reported" and "unavailable" everywhere a value is absent |
| No backend modifications | Honoured — the only non-frontend change is `package.json` (one script) and a new `scripts/` file |
| No deployment | Honoured |
| Adapt to actual backend capabilities | Honoured — e.g. Copilot says "model unavailable" instead of pretending; NANI says "gap detected" instead of a complete story |
| 13 reports + delivery document | Delivered |

---

## 7. What is not done, and why

| Item | Reason |
|---|---|
| **Pixel-diff visual regression suite** | Needs a browser engine and a binary baseline store — an infrastructure decision, not a side effect of a UI pass. Concrete plan in UI_MASTER_12 §5. |
| **NANI tab count reduction** | Ten tabs wrap at 1280px. Fixing it is an information-architecture decision the product owner must make. |
| **Spacing token scale** | The 4px rhythm is documented rather than tokenised; tokenising it would touch every component for no visible gain. |
| **axe-core in CI** | The four source-level guards cover the bug classes this audit actually found. A runtime a11y suite is the natural next step. |
| **Vendor chunk splitting** | Would improve cache reuse across deploys with no size change; needs a team-wide chunk policy. |

---

## 8. How to verify

```bash
# 1. Typecheck, test, lint
cd apps/web && npx tsc --noEmit
npx vitest run                 # expect 54 files / 509 tests
cd ../.. && npx eslint apps/web/src

# 2. Build and assert the compiled UI contract
cd apps/web && npx vite build
cd ../.. && npm run test:ui-contract    # expect 47/47

# 3. Read the ledger
#    reports/UI_MASTER_13_FINAL_DESIGN_AUDIT.md §2
```

---

## 9. Closing note

The interface now behaves like an instrument: it reports what it measured, says
so when it has measured nothing, and never animates to fill a silence. The work
that matters most is not any single component — it is that the rules are now
enforced by tests rather than by memory, so the next change cannot quietly undo
them.
