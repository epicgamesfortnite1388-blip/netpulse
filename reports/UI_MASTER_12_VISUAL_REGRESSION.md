# UI_MASTER_12 — VISUAL REGRESSION

## 1. What this project has, honestly

There is **no pixel-diff visual regression suite**. No Playwright, no Chromatic,
no baseline image store. Adding one would mean a browser engine, a binary
baseline directory and a diff threshold — three new things that can fail for
reasons unrelated to the interface.

What exists instead is a three-layer backstop, and this pass added the layer that
was missing:

| Layer | Mechanism | Catches |
|---|---|---|
| **1. Source contract** | `test/typeScale.test.ts` (13 tests), `test/tokenRefs.test.ts`, `test/headingLevel.test.ts` | Arbitrary type sizes, undeclared tokens, invalid heading nesting, unscaled stylesheet sizes |
| **2. Compiled contract** | `scripts/assert-ui-contract.mjs` — **new in this pass** | A token that the source declares but the build drops; a class tree-shaken away; fixed-px type surviving compilation; dead `var()` references |
| **3. Runtime navigation** | `src-tauri/tests/navigation_webview.rs` + `scripts/verify-navigation-webview.mjs`, run in CI as the `webview-navigation` job | A route that fails to mount in the real WebView2 engine |

Layer 2 is the one this audit proved was necessary — see §3.

---

## 2. The compiled contract check

```bash
npm run build -w @netpulse/web
npm run test:ui-contract
# ✓ UI contract intact — 47/47 assertions passed (index-DZUHe1Wf.css)
```

### 2.1 What it asserts

**21 design tokens** must be declared in the compiled CSS:

```
--color-bg, --color-surface, --color-surface-2, --color-surface-3,
--color-elevated, --color-text, --color-muted, --color-faint,
--color-accent, --color-accent-strong, --color-on-accent,
--color-accent-foreground, --color-background,
--color-ok, --color-warn, --color-danger,
--color-line, --color-line-strong,
--type-scale, --ease-fluid, --ease-spring, --dur-quick, --dur-base
```

**19 structural classes** must survive Tailwind's tree-shaking:

```
np-panel, np-label, np-row, np-inset, np-state-badge, np-state-dot,
np-btn-primary, np-btn-quiet, np-icon-btn, np-shell, np-rail,
np-context, np-topbar, np-content, np-dial,
page-enter, stagger, animate-pulse-dot, sr-only
```

**5 structural invariants:**

| Invariant | Rule |
|---|---|
| No dead `var()` | A reference without a fallback to an undeclared property fails. `var(--x, fallback)` is exempt — the fallback is the value. |
| No fixed-px type | Any `font-size: <n>px` in the compiled stylesheet fails. |
| No blur on `.np-panel` | A panel that composites a `backdrop-filter` fails (see §3.3). |
| Type ramp ≥ 12px | Every `--text-*: calc(<n>rem * var(--type-scale))` must resolve to ≥12px at 1x. |
| Reduced motion present | At least one `@media (prefers-reduced-motion: reduce)` block must survive. |

### 2.2 Why assertions on compiled CSS, and not screenshots

The three defects that motivated this check are all invisible in a screenshot and
obvious in the stylesheet:

1. A utility class that compiles to a property nobody declared renders as
   *inherited* colour. On the primary button that meant white on cyan — which a
   pixel diff would flag only if a baseline already existed and only as "pixels
   changed", with no explanation of why.
2. A `font-size: 9px` that ignores the Text-size preference looks correct at
   100%. It is wrong only at 112% and 125% — the two states a baseline suite
   never captures.
3. A `backdrop-filter` that a later rule cancels to `none` produces the correct
   image and the wrong frame budget. No pixel diff can see a cost that produces
   no pixels.

---

## 3. Defects this layer catches (all real, all found in this pass)

### 3.1 Invisible text on accent — the critical one

`text-accent-foreground` was used by `Button`, `NaniPage` (tab bar, chat
bubbles) and `CopilotPage` (message bubbles). `--color-accent-foreground` was
declared in **no** `@theme` block.

- Tailwind emitted `.text-accent-foreground { color: var(--color-accent-foreground) }`
- The custom property resolved to nothing
- `color` became `inherit` (or the initial value)
- The label rendered in the parent's colour: white on cyan, **1.75:1**

Now: token declared in all six theme blocks, measured **10.21:1**, and
`assertNoDeadVarRefs()` fails the build if any component references a property
that is not declared without a fallback.

### 3.2 Stylesheet type that ignored the user preference

Eight rules in `identity.css` used literal pixel sizes:

| Rule | Was | Effect |
|---|---|---|
| `.np-label` | `10px` | Every panel engraving |
| `.np-state-badge` | `10px` | Connection status pill |
| `.np-rail-item` | `9px` | All five rail labels |
| `.np-dial-sub` | `9px` | Dial caption |
| `.np-row-value` | `13px` | Session detail values |
| `.np-btn-primary` | `13px` | Primary CTA |
| `.np-btn-quiet` | `12px` | Secondary CTA |
| `.np-context-link` | `12.5px` | 25 navigation links |

All eight bypassed `--type-scale`. At the 125% setting a user got a 15px page
with 9px rail labels and 10px panel labels — the interface developed a hole
exactly where the user had said they needed help.

Fixed to `calc(<rem> * var(--type-scale))`, with tracking reduced to compensate
for the wider glyphs (`0.16em → 0.10em` on `.np-label`, `0.055em → 0.02em` on
the rail so "Overview" still fits the 76px rail). Verified: **zero** fixed-px
font sizes in the compiled CSS.

Guarded twice: `typeScale.test.ts` now scans the stylesheets (not just the TSX),
and `assertNoFixedPxType()` scans the build output.

### 3.3 A compositing cost with no output

`.surface-glass` requested `backdrop-filter: blur(...)`; `identity.css` then
cancelled it with `backdrop-filter: none !important`. The browser had already
been asked to build a backdrop layer. `assertNoCancelledBackdropFilter()` fails
if `.np-panel` ever carries a live blur again.

---

## 4. Manual verification matrix

Everything the compiled contract cannot see. This is the checklist a human runs
before a release; it is deliberately short enough to actually be run.

### 4.1 Resolutions

| Width × Height | What to verify |
|---|---|
| 1024 × 768 | Rail + context visible; health indicator present; no horizontal scroll |
| 1280 × 800 | Full chrome; Dashboard hero on one line; metric grid at 3 columns |
| 1440 × 900 | Nav column does not scroll on the 8-route Diagnose section |
| 1920 × 1080 | Content does not stretch past `max-w-xl` on Settings forms |
| 390 × 844 | Mobile drawer opens/closes; content gutters 16px |

### 4.2 Themes and text size (the 2×3 matrix a screenshot suite misses)

| | Dark | Light |
|---|---|---|
| **100%** | Baseline | Baseline |
| **112%** | No clipped labels in rail or badges | Same |
| **125%** | Rail labels may wrap to 2 lines — must not clip; `.np-label` must grow | Same |

### 4.3 States that have no default screenshot

| State | How to reach |
|---|---|
| Backend unreachable | Stop the sidecar |
| Degraded | Force one health check to fail |
| Safe mode | Set `safeMode` in meta |
| Empty health | Fresh install, no test run |
| Investigation running | Start an investigation in NANI |
| Sequence gap | Drop events from the replay fetch |
| Model unavailable | Clear the Copilot model config |
| Weight sum ≠ 100 | Change one scoring weight |

### 4.4 Interaction checks

- Tab from a cold load: skip link appears first, Enter lands focus in `main`.
- Every focusable element shows a 2px accent ring at 2px offset.
- No element shows a ring after a mouse click (`:focus-visible` only).
- Command palette opens on `Ctrl K`, closes on `Escape`.
- `Ctrl Shift K` opens Quick Connect, and the palette is not underneath it.
- Route change never blanks the rail or topbar.

---

## 5. Recommended next step (not done here)

A real pixel-diff suite would add one thing this project lacks: catching an
*unintended* visual change in a state nobody thought to assert. The concrete
proposal:

1. `npm i -D @playwright/test`, one project per theme.
2. Baseline the eight states in §4.3 at 1280×800, dark and light.
3. `maxDiffPixelRatio: 0.01` — loose enough to survive font hinting, tight
   enough to catch a moved card.
4. Run on PRs only; store baselines in the repo, not an external service.

This is recorded rather than implemented because it adds a browser engine and a
binary asset store to a repository that currently has neither, and that is a
decision for the maintainers rather than a side effect of a UI pass.

---

## 6. Acceptance criteria

| Criterion | State |
|---|---|
| A regression in a required token fails a command | Pass — `test:ui-contract` |
| A class tree-shaken away fails a command | Pass |
| Fixed-px type cannot reach production | Pass — guarded at source and at build |
| Dead `var()` cannot reach production | Pass |
| Type ramp floor enforced on compiled output | Pass |
| Reduced-motion block cannot be dropped | Pass |
| Stylesheet type sizes participate in the text preference | Pass — 13 source tests + build assertion |
| Real-engine route mounting covered | Pass — CI `webview-navigation` job |
| Pixel-diff coverage | **Not implemented** — proposal in §5 |
