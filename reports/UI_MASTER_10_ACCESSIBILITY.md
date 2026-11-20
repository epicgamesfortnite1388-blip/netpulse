# UI_MASTER_10 — ACCESSIBILITY

## 1. Standard and method

Target: **WCAG 2.1 Level AA**, with AAA where the design system already achieves
it for free.

Method: source audit of every interactive component, computed contrast for every
text/background pair in both themes, keyboard-only traversal of every route, and
build-time guards (`typeScale.test.ts`, `headingLevel.test.ts`,
`tokenRefs.test.ts`) that fail CI on regression.

---

## 2. Measured contrast (WCAG 2.1 relative luminance)

### 2.1 Dark theme

| Pair | Ratio | AA (4.5) | AAA (7.0) |
|---|---|---|---|
| `--color-text` on `--color-surface` | **15.95** | Pass | Pass |
| `--color-muted` on `--color-surface` | **6.96** | Pass | Marginal |
| `--color-faint` on `--color-surface` | **5.06** | Pass | No |
| `--color-text` on `--color-bg` | **17.18** | Pass | Pass |
| `--color-muted` on `--color-bg` | **7.49** | Pass | Pass |
| `--color-faint` on `--color-bg` | **5.45** | Pass | No |
| `--color-on-accent` on `--color-accent` | **10.21** | Pass | Pass |
| `--color-accent` on `--color-bg` | **11.10** | Pass | Pass |
| `--color-ok` on `--color-surface` | **9.68** | Pass | Pass |
| `--color-warn` on `--color-surface` | **11.15** | Pass | Pass |
| `--color-danger` on `--color-surface` | **6.73** | Pass | No |

### 2.2 Light theme

| Pair | Ratio | AA |
|---|---|---|
| `#0f172a` on `#ffffff` | **17.85** | Pass |
| `#52627a` on `#ffffff` | **6.20** | Pass |
| `#5c6b7d` on `#ffffff` | **5.45** | Pass |
| `#ffffff` on `#0e7490` (accent) | **5.36** | Pass |

### 2.3 The faint tier

`--color-faint` is the dimmest text tier and the one that previously failed:

| Value | Ratio on surface | Verdict |
|---|---|---|
| `#5c6b7d` (before) | 3.5:1 | **Fail** |
| `#75879d` (current) | 5.06:1 | Pass |

`faint` is still body text — timestamps, sequence numbers, hints. It is not
permitted to fail AA, and the token comment now records why the value is what it
is so it cannot be dimmed again "for aesthetics".

### 2.4 Semantic colours as text

`ok` / `warn` / `danger` are used as text on `surface` (banners, error states,
pipeline stages). All three pass AA at 6.73–11.15. `danger` at 6.73 is the
weakest and still clears AA by 49%.

---

## 3. Fixed critical defect: invisible text on accent

The highest-severity accessibility failure in the audit.

`text-accent-foreground` was used in `Button`, `NaniPage` (tab bar, chat bubbles)
and `CopilotPage` (message bubbles) while `--color-accent-foreground` was never
declared in any `@theme` block. Tailwind emitted the utility; the property
resolved to nothing; the label inherited the parent colour.

Result: **white text on cyan at 1.75:1** — below AA, below AA-Large, and
effectively invisible on the primary button of the product.

Fix: `--color-accent-foreground` is now declared as an alias of
`--color-on-accent` (`#04161d`) in all three theme blocks in `tokens.css` and all
three in `identity.css`. Measured after fix: **10.21:1**.

`tokenRefs.test.ts` now guards against a class referencing an undeclared custom
property, which is the class of bug that caused this.

---

## 4. Keyboard access

### 4.1 Skip link (new)

```tsx
<a href="#np-main" className="sr-only focus:not-sr-only …">Skip to main content</a>
```

`<main id="np-main" tabIndex={-1}>` receives focus. A keyboard user bypasses
**25 navigation links** with one Tab + Enter. Before this, the first Tab landed on
the rail and content was reached only after 25 stops.

`outline-none` on `main` is deliberate: the target is programmatically focused,
not interactively focused, and a ring around the whole content column would be
noise.

### 4.2 Focus treatment

One global rule covers the entire product:

```css
:where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
  border-radius: var(--np-r-1);
}
```

| Property | Value | Why |
|---|---|---|
| Width | 2px | Visible on a 1px-bordered surface without dominating |
| Offset | 2px | Separates the ring from the element border so it reads as focus, not as a border colour change |
| Colour | `--color-accent` | 11.10:1 against `--color-bg`; passes AA as a non-text indicator (3:1 required) |
| Selector | `:where(...)` | Zero specificity, so a component can override without `!important` |

The rail has an additional rule so the ring is not clipped by the rail's
`overflow: hidden`.

### 4.3 Focus-visible, not focus

`:focus-visible` only, never `:focus`. A mouse click on a button must not leave a
ring behind; a Tab must. This is the platform convention and it is the difference
between "the app respects my input method" and "the app rings everything I
touch".

### 4.4 Tab order

Tab order follows DOM order, which follows visual order on every page. No
`tabIndex` values greater than 0 exist anywhere in the source — a positive
`tabIndex` is the single most common way to break a keyboard user's model of the
page.

### 4.5 Overlays

Command palette and Quick Connect close on `Escape` and trap focus while open.
The mobile drawer's backdrop is `aria-hidden="true"` and its close button is
labelled.

---

## 5. Document outline

Headings are derived from nesting depth, not declared per call site:

```ts
headingTag(level) // clamps 2..6
```

`HeadingLevelProvider` gives each card a depth; `headingTag` maps depth to a real
HTML tag. Two failure modes this prevents:

1. **`<h7>`** — HTML defines `h1..h6`. A card nested seven deep would otherwise
   emit an invalid tag, which browsers silently demote to a `div`, losing the
   heading role entirely.
2. **Demotion below the page title** — `headingTag(0)` and `headingTag(1)` both
   return `h2`, so a card can never outrank the page's own `h1`/`h2`.

Every page has exactly one `h1`-level title (from `PageHeader`), and cards nest
beneath it. `headingLevel.test.ts` covers the clamp, the deepening, and the
no-demotion rule.

---

## 6. Semantics inventory

| Pattern | Implementation |
|---|---|
| Primary navigation | `<aside aria-label="Primary navigation">` |
| Section navigation | `<aside aria-label="{section} navigation">` |
| Current route | `aria-current="page"` |
| Expandable card | `aria-expanded` on the toggle |
| Decorative art | `aria-hidden="true"` on every gradient, hairline and glyph |
| Live region (chat) | `role="log" aria-live="polite"` |
| Error state | `role="alert"` |
| Connection status | `role="status" aria-live="polite"` |
| Icon-only buttons | `aria-label` required by the `IconButton` prop type |
| Form controls | Wrapped in `Field` which associates label and hint |

`IconButton` requires `label: string` in its props. An icon-only control cannot be
built without an accessible name — the type system enforces it.

---

## 7. Colour is never the only signal

| State | Colour | Also |
|---|---|---|
| Connected / healthy | `--color-ok` | Text label ("Healthy", "Established") |
| Warning | `--color-warn` | `TriangleAlert` icon + text |
| Error | `--color-danger` | Text + `role="alert"` |
| Pipeline stage complete | `--color-ok` | Weight change + background change |
| Selected tab | accent text | Underline + `aria-current` |
| Active nav row | accent tint | 2px left rule + `aria-current` |
| Prior marker on a bar | `bg-text` | `title` attribute with the value |

Every one of these survives greyscale and survives all three common colour vision
deficiencies, because in each case there is a non-colour channel carrying the same
information.

---

## 8. Text scaling

`--type-scale` on `:root` multiplies every `--text-*` token. Settings offers 100%
/ 112% / 125%.

The build-time guard matters more than the setting:

```
test/typeScale.test.ts  (13 tests)
  ✓ contains no arbitrary font sizes
  ✓ renders no text below the 12px floor
  ✓ keeps every identity.css size on the type-scale ramp
  ✓ declares no fixed px size in either stylesheet
  ✓ never sets a stylesheet size below the 12px floor at 1x
```

A single `text-[11px]` is a hole in the user's accessibility preference. At 125%
it stays 11px while everything around it becomes 15px.

Two such holes existed in `ConnectionHero.tsx`, and **eight more existed in
`identity.css`** — `.np-rail-item` at 9px, `.np-label` at 10px, `.np-state-badge`
at 10px, `.np-dial-sub` at 9px, `.np-row-value` and `.np-btn-primary` at 13px,
`.np-btn-quiet` at 12px, `.np-context-link` at 12.5px. Hand-written CSS is
invisible to a scan of `.tsx` files, so the original test could not see them.

At the 125% setting a user was getting a 15px page with **9px navigation labels**
— the setting failed exactly where it was most needed. All twelve are now on the
ramp, and the test scans both stylesheets. Compiled output verified: zero
fixed-px `font-size` declarations remain.

The 12px floor exists because below 12px, at 100% scale on a 96dpi display,
subpixel rendering of Inter's x-height becomes unreliable and the text stops being
comfortably readable.

---

## 9. Reduced motion

Seven `prefers-reduced-motion` blocks. The rule is: **remove the movement, keep
the information.**

| Removed | Retained |
|---|---|
| Page / card entry | Content renders |
| Nav pill travel | Active colour |
| Palette, drawer, toast entry | Overlays still open |
| Aether decorative layers | Static decoration |
| Skeleton sheen | Skeleton shape |
| Route progress animation | Bar frozen at 50% — the loading signal survives |

Freezing the route bar rather than hiding it is the principle in one line: motion
is decoration, the bar is information.

---

## 10. Touch targets

| Control | Size | Standard |
|---|---|---|
| `Button` sm | 32px | Below 44px, used only in dense table rows |
| `Button` md | 36px | — |
| `Button` lg | 44px | Meets 44×44 |
| `IconButton` | 32px | WCAG 2.1 AA has no minimum; 2.5.5 AAA wants 44px |
| Rail item | 76×56px | Meets 44×44 |
| Switch | 44×24px track | Meets the 44px long axis |

WCAG 2.1 AA does not mandate 44×44 (that is 2.5.5, AAA). The dense controls are
desktop-only surfaces with a pointer; the mobile breakpoint uses the larger
variants.

---

## 11. Outstanding limitations

| Limitation | Impact | Mitigation |
|---|---|---|
| No automated axe-core run in CI | Manual-only detection of new violations | The four source-level guards cover the classes of bug found in this audit |
| `--color-faint` does not reach AAA | Metadata at 5.06:1 | It is tertiary text; raising it further would flatten the hierarchy |
| Live map (WebGL) has no text alternative | Canvas content is not announced | The map page provides a textual node list beside the canvas |
| Streaming chat announces per-message, not per-token | A screen reader hears each message once, after it completes | `aria-live="polite"` is the correct choice; `assertive` would interrupt continuously |

---

## 12. Acceptance criteria

| Criterion | State |
|---|---|
| Every text/background pair passes AA in both themes | Pass — measured, lowest is 5.06:1 |
| Text on accent is legible | Pass — 10.21:1, was 1.75:1 |
| Keyboard can bypass navigation | Pass — skip link |
| Every focusable element has a visible focus ring | Pass — one global `:focus-visible` rule |
| No positive `tabIndex` | Pass |
| Document outline is valid | Pass — `headingTag` clamps, tested |
| Icon-only controls have accessible names | Pass — enforced by prop type |
| State is never colour-only | Pass |
| Text scaling affects every string | Pass — tested |
| Reduced motion preserves all information | Pass |

---

## APPENDIX — Evidence correction (recovery mission, 2026-11-20)

A transparent correction note; the original audit text above is preserved as the historical record.

| Original claim | Verified value (actual shipped palette) | Reason |
|---|---|---|
| faint on surface = 5.06:1 | **4.62:1** (`#718783` on `#101a1e`) | Original used the overridden `tokens.css` base; `identity.css` is imported last in `main.tsx` and supplies the rendered colors. |
| on-accent on accent = 10.21:1 | **9.74:1** (`#06231c` on `#6ed9bc`) | Same cascade error. |
| warn on surface = 11.15:1 | **9.27:1** (`#e6b36a` on `#101a1e`) | Same cascade error. |
| "lowest pass is 5.06:1" | **4.62:1** — still WCAG AA pass for normal text (≥4.5:1) | AA verdict unchanged; only the measured number was wrong. |
| Seven `prefers-reduced-motion` blocks | **Five** (`identity.css:672`; `tokens.css:685,745,937,1018`) | Counted from source. |

Verification: WCAG relative-luminance formula computed from the hex values in `identity.css` dark `:root` and light `[data-theme='light']` blocks. All ten pairs checked (10 dark/light foreground-background combinations) pass AA. Light theme: faint/surface 4.95:1, on-accent/accent 5.00:1, text/surface 16.69:1, muted/surface 6.81:1 — all pass.
