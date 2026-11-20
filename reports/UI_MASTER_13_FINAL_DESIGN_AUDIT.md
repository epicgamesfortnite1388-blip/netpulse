# UI_MASTER_13 — FINAL DESIGN AUDIT

## 1. Verdict

The interface is now internally consistent, honest about backend state, and
guarded against regression by five automated checks. The audit found **85
findings**; **58 are fixed**, **6 resolved by design decision**, **3 partially
addressed**, and **18 deferred with stated reasons**.

Nine additional defects were found *during* implementation that the original
audit missed — including the most user-visible one in the product (a 9px
navigation label that ignored the Text-size setting) — and all nine are fixed.

---

## 2. Resolution ledger

| Severity | Total | Fixed | By design | Partial | Deferred |
|---|---|---|---|---|---|
| CRITICAL | 1 | 1 | 0 | 0 | 0 |
| HIGH | 17 | 15 | 1 | 1 | 0 |
| MEDIUM | 46 | 30 | 4 | 2 | 10 |
| LOW | 21 | 12 | 1 | 0 | 8 |
| **Total** | **85** | **58** | **6** | **3** | **18** |

### 2.1 Fixed (58)

`DS-1` `A-1` `A-2` `A-3` `A-4` `A-5` `B-1` `BDG-1` `BDG-2` `BTN-1` `C-1` `C-2`
`C-3` `C-4` `C-5` `CARD-1` `CARD-2` `D-1` `D-3` `D-4` `D-5` `DS-2` `DS-3` `DS-4`
`DS-6` `DS-8` `DS-9` `DS-10` `E-1` `E-2` `E-3` `M-1` `M-3` `N-1` `N-4` `N-6`
`N-7` `N-8` `N-10` `N-11` `N-12` `N-13` `N-14` `N-15` `N-17` `N-19` `R-2` `S-1`
`S-2` `S-3` `SW-1` `SW-2` `T-1` `T-2` `T-3` `TAB-1` `TIP-1` `TIP-2`

### 2.2 Resolved by design (6)

| ID | Original finding | Why the finding was superseded |
|---|---|---|
| `N-5` | Suggestion buttons use `rounded-lg` inside `rounded-xl` cards — "inconsistent" | **Correct nesting.** An inner radius must be smaller than its container's by at least the container's padding. Equal or larger radii is the defect, not this. |
| `DS-5` | `identity.css` overrides utilities with `!important` | Deliberate and now documented: the identity layer is the final word on five utilities (`surface-glass`, `hairline-brand`, `brand-gradient`, `shadow-glow`, `app-backdrop`). Recorded in UI_MASTER_02 §1. |
| `DS-7` | No spacing token scale | A 4px rhythm is defined and documented (UI_MASTER_02 §3.3) rather than tokenised. Only 14px deviates, and it exists so a card header and body share a baseline. |
| `N-3` | Tabs have no bottom border marking the active tab | The active tab is now a **solid accent fill**. A fill is a stronger signal than a 1px border, and the two together would be redundant. |
| `N-23` | `line-clamp-2` needs the `@tailwindcss/line-clamp` plugin | Tailwind v4 ships `line-clamp` in core. No plugin required. |
| `C-7` | Two different initial prompts ("What would you like to investigate?" vs "Ask Copilot anything") | The initial message is the assistant's greeting; the empty state is the page's onboarding. They are different speakers. The empty state was rewritten to state the five capabilities, so the duplication is gone in substance. |

### 2.3 Partially addressed (3)

| ID | What was done | What remains |
|---|---|---|
| `R-1` | Health indicator now visible from 1024px (was `xl` only). NANI tab bar wraps instead of clipping. | At 1280×720 the ten-tab bar still occupies two rows. Fixing it means reducing NANI to fewer tabs, which is an information-architecture change, not a CSS one. |
| `N-2` | Same: `flex-wrap` means no clipping and no horizontal scroll. | Ten tabs at 978px still wrap. |
| `C-8` | The page header states "Local explanations — {runtime}", so AI output is never presented as a measurement. Assistant bubbles use a distinct surface from data cards. | There is no inline marker on individual AI claims. A per-claim provenance badge would need the backend to attribute claims, which it does not do. |

### 2.4 Deferred (18)

| ID | Finding | Why deferred |
|---|---|---|
| `C-6` | Copilot `h-full` may not fill the viewport | The page renders correctly in the shell because `np-content` is a flex child with `flex-1`; changing it risks the composer position on short windows for no observed gain. |
| `D-2` | Hero top hairline is a flat bar, not a gradient | `identity.css` overrides `hairline-brand` deliberately. A gradient reintroduces the "glass" language the identity layer removed. |
| `D-6` | Metric value can approach column width at 1280px | The value **wraps the unit to a second line** rather than clipping digits — the correct failure mode for a measurement. A `truncate` would hide data. |
| `D-7` | 190px gauge sits in a ~380px column | The surrounding whitespace is intentional; filling it would require inventing supplementary content the backend does not provide. |
| `D-8` | `LatencyChart` has no empty state | The chart is only mounted when history exists; the parent card carries the empty state. |
| `D-9` | Health empty state was bare | **This was fixed** (header + icon + action). Retained here only as a note that the *dashboard-level* empty branch still renders `EmptyState` rather than a full card. |
| `DS-11` | Hero and cards share `shadow-raised` | Both are now `np-panel`, so they *should* share elevation. The duplication the finding described no longer exists. |
| `N-9` | Input + buttons placed in `CardHeader` `actions` | Moving them changes the start-investigation flow's layout; the current placement is usable and tested. |
| `N-16` | "Analyzing…" indicator can scroll out of view | The pipeline strip above already shows the active stage persistently. |
| `N-18` | Metadata row mixes labels and values inline | The mono/`text-text` value styling separates them; a two-column layout would cost more vertical space than it saves. |
| `N-20` | Evidence filter has no clear button | `Escape` clears a focused input in most browsers; adding a button needs an icon slot in a 14px row. |
| `N-21` | Four distinct empty states in the Network tab | Four *different* conditions deserve four different messages. Collapsing them would lose the distinction between "not run", "ran and passed", "ran and failed", and "gap detected". |
| `N-22` | Drift events shown as a count | A visualisation needs a time series the backend does not emit; a fabricated chart would be worse than a number. |
| `N-24` | Clear-history confirmation is inline | It is a reversible, low-blast-radius action on local history. A modal for it would be heavier than the action. |
| `R-3` | Content capped at 1360px leaves side space at 1920px | The cap protects line length. Using the space would mean a contextual panel with nothing honest to put in it. |
| `B-2` | Degraded banner has no truncation | The banner lists component labels, which are short and bounded by the health check's own component set. |
| `M-2` | `Progress` references a keyframe from `tokens.css` | Both stylesheets load on every page; the split is organisational, not functional. |
| `S-4` | Breadcrumb separator is faint | The separator is `ChevronRight` at `text-faint`; the section label and page title already differ in weight. |

---

## 3. Defects found during implementation (not in the audit)

These were discovered by reading source and compiled output while fixing the
audit's findings. All nine are fixed.

| # | Defect | How it was found | Severity |
|---|---|---|---|
| 1 | Eight `font-size: <literal>px` rules in `identity.css` ignored the Text-size preference — `.np-rail-item` at **9px**, `.np-label` and `.np-state-badge` at 10px, `.np-dial-sub` at 9px, `.np-row-value` / `.np-btn-primary` at 13px, `.np-btn-quiet` at 12px, `.np-context-link` at 12.5px | Grepping the **compiled** CSS for `font-size: Npx` after the TSX-level test passed | HIGH |
| 2 | No skip-to-content link (WCAG 2.4.1) — 25 nav links before content | Keyboard traversal of a cold load | HIGH |
| 3 | `useDisconnect` returned a union of two incompatible payload shapes — a standing `tsc` error | `tsc --noEmit` | MEDIUM |
| 4 | `model unavailable (undefined)` when the backend omitted `AiStatus.message` | Reading the Copilot header ternary | MEDIUM |
| 5 | NANI investigation list was `<div>`s with no list semantics | Source audit | MEDIUM |
| 6 | `Metric` tooltip trigger was a non-focusable `<div>` — pointer-only hint | Source audit | MEDIUM |
| 7 | Four unused imports left by the icon/empty-state redesigns (`Bot`, `Zap`, `fetchInvestigationStatus`, `NaniEvent`) | ESLint | LOW |
| 8 | `Card` used 12px radius while `np-panel` used 10px — a nested card had a larger corner than its container | Comparing the two definitions | HIGH |
| 9 | UI_MASTER_01's summary table under-counted its own findings (68 stated vs 85 present) | Cross-checking the report against itself | LOW |

---

## 4. The design direction, as built

**"Precision instrument"** — the interface should read as a measurement device,
not a dashboard template.

| Principle | How it is expressed |
|---|---|
| **Honest state** | Dashes for unmeasured values, never zero. `?` for unknown confidence. "not reported" for a missing timestamp. Sequence-gap disclosure. "no progress is estimated" during a transition. |
| **One surface family** | Four planes (`bg` → `surface` → `surface-2` → `surface-3`), one panel radius (`--np-r-3`), one card look (`np-panel`), one badge shape. |
| **Engraved labels** | 12px uppercase mono at 0.10em tracking. Reads as a label without a second colour or a divider. |
| **Numeric integrity** | `tabular-nums` + `zero` feature everywhere numbers align. Percentage points distinguished from percent. One decimal where the engine computes one. |
| **Restraint in motion** | Enter-only, nothing loops, one spring (palette only), no exit animations, seven reduced-motion blocks. |
| **Hierarchy by weight, not hue** | One accent. Solid / outline / ghost. Hover is a surface change, never a brand statement. |
| **Nothing is a dead end** | Every empty state names its cause and its producer. Every error has a retry where retry is possible. |

---

## 5. Surface-by-surface state

### 5.1 Shell

Two-tier navigation (76px rail + 226px context column) over 5 sections and 25
routes, resolved from the URL by longest-prefix match. Opaque topbar, visible
health from 1024px, `scrollbar-gutter: stable`, skip link, route boundary inside
the shell so navigation never blanks the chrome.

### 5.2 Dashboard

Verdict-first. One `np-panel` hero, 24px verdict → 24px health → 20px metrics →
12px labels on one continuous ramp. Problems render before the score. Eight
quick actions with eight distinct glyphs. Every metric has a dash fallback.

### 5.3 NANI

Ten tabs over one event stream, now a real ARIA tablist with roving focus and
arrow-key navigation. An eight-stage pipeline strip that reports position without
inventing a percentage. Confidence at one decimal. Sequence gaps disclosed.

### 5.4 Evidence and hypotheses

Posterior bar + prior tick + signed percentage-point shift, all on one row.
Calibrated vs raw confidence always labelled, with sample count. Entropy reports
`unavailable`, never `0.000`. Bars clamp to valid widths on any input.

### 5.5 Settings

Seven tabs, one save per slice, every non-obvious control carries a hint. The
scoring-weight sum is live, colour-coded, and blocks submit before the request.
Destructive reset backs up first and names its consequence.

### 5.6 Copilot

Local-inference status on every load. Twelve-pixel bubbles with a speaker-side
corner. Stop replaces Send while streaming. Retry only for retryable errors.
`role="log"` announcements. Semantic `--color-ok`, not `green-500`.

---

## 6. Verification evidence

| Check | Command | Result |
|---|---|---|
| Typecheck | `tsc --noEmit` | **0 errors** (was 1 pre-existing) |
| Tests | `vitest run` | **54 files / 509 tests pass** (was 506; +3 stylesheet guards) |
| Lint | `eslint apps/web/src` | **0 problems** (was 4 unused imports) |
| Build | `vite build` | **13.6s**, CSS 124.01 kB → **23.09 kB gzip** |
| UI contract | `npm run test:ui-contract` | **47/47 assertions pass** |
| Fixed-px type in build | grep of compiled CSS | **0 occurrences** |
| `rounded-2xl` in source | grep | **0 occurrences** |
| Contrast, lowest text pair | computed | **5.06:1** (`faint` on `surface`, AA pass) |
| Contrast, text on accent | computed | **10.21:1** (was 1.75:1) |

---

## 7. Remaining risk

| Risk | Likelihood | Mitigation |
|---|---|---|
| A new component reintroduces a hard-coded colour | Medium | No automated colour-token guard; `tokenRefs.test.ts` catches only undeclared-property references |
| A new stylesheet rule bypasses the type scale | Low | Guarded twice — source scan and compiled scan |
| NANI's ten tabs become eleven | Medium | The bar wraps rather than clipping, so it degrades gracefully; the IA decision is unowned |
| Pixel-level visual regressions in states not asserted | Medium | No pixel-diff suite; the manual matrix in UI_MASTER_12 is the current answer |
| Accessibility regressions in new interactive components | Medium | `IconButton` requires a label by type; tab semantics are not enforced by type |

---

## 8. What was deliberately not done

- **No backend changes.** Every value on screen is a value the backend reports.
- **No fabricated data.** Where a number is absent the interface says so.
- **No pixel-diff suite.** Proposed with a concrete plan in UI_MASTER_12 §5, not
  installed.
- **No information-architecture changes.** NANI keeps ten tabs, Diagnose keeps
  eight routes, Settings keeps seven tabs. Reducing them is a product decision.
- **No git history rewriting.** All work is additive or in-place edits.
- **No deployment.**
