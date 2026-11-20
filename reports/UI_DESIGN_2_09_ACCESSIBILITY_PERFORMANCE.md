# UI DESIGN 2.0 — 09 — Accessibility and Performance

All numbers below were measured on this machine, in this pass. Contrast was computed
from the token values actually in `identity.css`, not from intent.

---

## 1. Contrast — measured

WCAG AA requires 4.5:1 for normal text and 3:1 for large text.

### 1.1 Light theme

| Pair | Ratio | Verdict |
|---|---|---|
| `text` on `surface` | **16.69** | AA |
| `muted` on `surface` | **6.81** | AA |
| `faint` on `surface` | **4.95** | AA |
| `faint` on `surface-2` | **4.21** | AA-large only — see O-05 |
| `ok` on `surface` | **5.00** | AA |
| `warn` on `surface` | **5.68** | AA |
| `danger` on `surface` | **6.00** | AA |
| `accent-strong` on `surface` | **7.72** | AA |
| `proto-sky` on `surface` | **5.93** | AA |
| `proto-violet` on `surface` | **7.10** | AA |
| `proto-amber` on `surface` | **5.02** | AA |
| `aether` on `surface` | **6.96** | AA |

### 1.2 Dark theme

| Pair | Ratio | Verdict |
|---|---|---|
| `text` on `surface` | **15.70** | AA |
| `muted` on `surface` | **6.91** | AA |
| `faint` on `surface` | **4.62** | AA |
| `ok` on `surface` | **9.92** | AA |
| `warn` on `surface` | **9.27** | AA |
| `danger` on `surface` | **6.44** | AA |
| `accent` on `surface` | **10.36** | AA |
| `proto-sky` on `surface` | **10.86** | AA |

### 1.3 The number that justifies the palette work

The raw utility this pass removed:

```
text-violet-200 (#ddd6fe) on a white card = 1.39:1
```

That is not "slightly low". It is effectively invisible. The Aether row label on the
VPN overview was rendered in that colour, and it is the single clearest evidence that
the 110 raw palette utilities were an **accessibility** defect and not a tidiness
preference.

### 1.4 Open accessibility finding

**O-05 — `--color-faint` on `--color-surface-2` is 4.21:1 in light theme**, below the
4.5:1 AA threshold for normal text.

- Where it matters: hint text inside a full `surface-2` well (`.np-inset`, the
  borderless `EmptyState`/`LoadingState` wells).
- Where it does not: the wells this pass introduced use `bg-surface-2/40`, a 40 %
  overlay on `surface`, which lands nearer `#f6f8f6` and clears 4.5:1.
- Not fixed, because the honest fix is a token change (`--color-faint` darker in light
  theme) that affects every faint label in the product, and that needs a visual review
  across all 20 routes rather than a local tweak. Recorded as a condition.

---

## 2. Headings and document structure

| Check | Before | After |
|---|---|---|
| Routes with an `h1` | 24 / 26 | **26 / 26** |
| `h2` on pages | 0 (historical audit) | Derived from structure via `HeadingLevelProvider` |
| Heading ranks jumping levels | Fixed earlier by the level provider | — |

`HeadingLevelProvider` derives rank from structure: the page is level 1, each `Card`
opens the next level, `CardHeader` renders whatever rank it was handed. Nest a card and
the outline deepens on its own. `headingTag()` clamps to `h2…h6`, so a nested card can
never emit an `h1` — which is exactly why `NodeDetailPage` needed the explicit
`pageTitle` opt-in.

**Verified:** 100 / 100 captures have a non-empty `h1`, and assertion 53 derives the
route list from `router.tsx` so a new route is covered the moment it is registered.

---

## 3. Keyboard and focus

- `focus-visible` uses `outline-2` + `outline-offset-2` on `outline-accent` — a visible
  ring, not a colour change alone.
- Tabs and segmented controls delegate roving tabindex and arrow keys to Radix. NANI's
  hand-written `onTabKeyDown` was deleted, halving the keyboard logic to maintain.
- `Tabs` and `Segmented` keep distinct ARIA roles (`tablist` vs `radiogroup`) while
  sharing chrome — asserted by test, because a shared look must not become a shared
  semantic.
- No focusable element transitions `transform`, so focus never animates layout.

---

## 4. Reduced motion

Covered in report 06. Summary: the block was a blocklist and `animate-pulse` (infinite)
ran on six elements regardless of preference. It now covers the `animate-*` family with
`animate-spin` exempt, and assertion 54 fails the build if that regresses.

---

## 5. Performance — measured

### 5.1 Build output

| Asset | Size | Gzip |
|---|---|---|
| CSS (`index-*.css`) | 113.57 kB | **21.55 kB** |
| Main JS (`index-*.js`) | 583.29 kB | **184.18 kB** |
| `LiveMapPage` chunk | **1,266.00 kB** | **377.66 kB** |
| Total `dist/` | 3.8 MB | — |
| JS chunks emitted | 77 | — |

### 5.2 Timing

| Stage | Time |
|---|---|
| `vite build` | 12.5 – 14.1 s |
| `vitest run` (56 files, 534 tests) | ~16.7 s |
| `tsc --noEmit` | ~4 s |

### 5.3 Findings

**P-01 — `LiveMapPage` is 1.27 MB (377 kB gzip).** It is lazy-loaded, so it does not
affect first paint, but one route shipping 377 kB gzip is a real cost for users on a
metered connection. The map library dominates it. Not addressed in this pass: it is a
dependency decision, not a design one, and the brief scopes UI work. Recorded.

**P-02 — 77 chunks is working as intended.** Route-level `lazy()` splitting is
effective: the shell is 184 kB gzip and every feature is its own chunk. The many
sub-1 kB chunks are individual icons, which is a side effect of importing icons
per-module; it costs HTTP requests but nothing on a bundled desktop WebView.

**P-03 — Fonts are subset by `unicode-range`.** 12 `woff2` files ship (Inter and
JetBrains Mono, multiple subsets) totalling ~302 kB, but only the Latin subsets load
for Latin text (~88 kB). No action.

**P-04 — CSS grew 21.55 kB gzip.** The palette unification replaced 84 raw palette
rules with `color-mix()` token rules; the net effect is neutral. No CSS was added for
decoration.

### 5.4 What was not regressed

- No new runtime dependency. The capture and probe harnesses use CDP over Node's
  built-in `WebSocket`; no Playwright, no Puppeteer.
- No layout shift introduced: the changes are static class changes, not
  measure-then-mutate.
- The 54-assertion contract runs in well under a second because it reads a file rather
  than launching a browser.

---

## 6. Accessibility summary

| Criterion | State |
|---|---|
| WCAG AA contrast, semantic text pairs | **Pass** (13 / 13 light, 8 / 8 dark measured) |
| `faint` on `surface-2` | **Conditional** — 4.21:1 (O-05) |
| Every route has an `h1` | **Pass** — 26 / 26 source, 100 / 100 rendered |
| Document outline has no skipped ranks | Pass — derived from structure |
| Visible focus indicator | Pass |
| Keyboard operable tabs / segmented | Pass — Radix APG |
| `prefers-reduced-motion` honoured for utilities | **Pass** (was failing) |
| Live regions for the connection timeline | Pass — `aria-live="polite"` |
| Decorative icons hidden | Pass — `aria-hidden` where decorative |
