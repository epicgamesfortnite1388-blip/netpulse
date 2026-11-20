# UI DESIGN 2.0 — 01 — Current State Audit

**Auditor:** Senior Product Designer
**Scope:** `apps/web` (React 19 + Tailwind v4 + Radix), 26 routed pages
**Method:** the real app, run locally, measured — not read.

---

## 1. How this audit was performed

The brief said not to trust the historical numbers. So nothing below is inherited:
every claim was re-derived from a running instance.

| Instrument | What it produces | Why it exists |
|---|---|---|
| `scripts/ui-capture.mjs` | PNG + `manifest.json` per route: `h1`, `scrollH`, `scrollW/clientW`, and the **resolved** theme + `--type-scale` | Screenshots you can trust, with machine-readable side-data |
| `scripts/ui-probe.mjs` | Per-selector box, `scrollH/clientH`, computed `font-size`, `color`, `backgroundColor`, `borderColor` | Proves a layout or contrast claim with a number instead of an impression |
| `node scripts/assert-ui-contract.mjs` | 53 assertions on the compiled stylesheet | Turns design rules into a failing command |
| `npx tsc`, `vitest`, `eslint`, `vite build` | The ordinary gates | Nothing is "done" until these are green |

Servers: API on `:8899` (`PORT=8899 DATA_DIR=/tmp/np-data`), Vite on `:5173`
(`VITE_API_PORT=8899`).

### 1.1 A methodology failure found and corrected

The first 125 % capture run produced screenshots that were **silently at 100 %**.
`ui-capture.mjs` wrote the raw multiplier onto `<html data-type-scale="1.25">`,
but `tokens.css` keys the ramp off *named* steps:

```css
html[data-type-scale='large'] { --type-scale: 1.125; }
html[data-type-scale='xl']    { --type-scale: 1.25; }
```

`1.25` matched no selector. The override was a no-op, the screenshots looked
plausible, and the run reported success.

This is worth recording as a finding in its own right: **an instrument that can
fail silently is worse than no instrument.** The fix was not just the mapping
(`1.25 → 'xl'`), but making the harness *read back* what the page resolved and
abort if it did not take:

```js
if (DOM_SCALE && applied.typeScale !== expected) {
  process.stderr.write(`ui-capture: text scale did not apply …`);
  process.exit(1);
}
```

Every manifest entry now carries `applied: { theme, typeScale, typeScaleAttr, rootFont }`,
so a future run cannot quietly capture the wrong configuration.

---

## 2. Baseline, re-verified

At the start of this pass, from a clean run:

| Gate | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| `vitest run` | 54 files / 509 tests passing |
| `eslint apps/web/src` | 0 problems |
| `vite build` | ~14 s |
| `assert-ui-contract.mjs` | 47 / 47 |

The historical numbers held. Nothing in this pass needed to repair a broken
build first — the work was design, not recovery.

---

## 3. Screen-by-screen audit

Each screen was captured at 1440×900, 1280×800 and 1024×768, in dark and light,
at 100 % and 125 % text. The ten questions from the brief were applied to each;
only the ones that produced a finding are listed.

### 3.1 Shell

**Holds up.** The 76 px rail survives 125 % text without clipping; the 226 px
context column keeps its two-tier grouping (`OVERVIEW` / `CONNECT` / `NANI` /
`DIAGNOSE` / `SYSTEM`); the topbar's three-zone layout does not reflow.

One real inconsistency: **three different tab languages.** `Tabs` used
`rounded-lg`, `Segmented` used `rounded-xl`, and NANI's hand-rolled bar used a
bottom rule with a solid accent fill. The same "pick one of N" affordance looked
like three different controls depending on the page.

### 3.2 Dashboard

| Finding | Evidence | Severity |
|---|---|---|
| Two contradictory verdicts on one screen: the band printed *Degraded* while the gauge printed *Good* | 1440 capture | High — the page argued with itself |
| `DNS —as` — an em dash + `ms` at 12 px reads as the word "as" | hero band | Medium |
| Six `Metric`s at 24 px outranked the page verdict, and the widest element on the page was the least important | 1440 capture | High — hierarchy inversion |
| The health gauge card carried ~400 px of dead space | probe: stretched cell `h=916` | Medium |

The contradiction was structural: the band used its own score scale
(`>=80 Nominal`, `>=50 Degraded`) and printed the backend's label as a hint, so
`82` produced "Degraded Good". One scale now, matching the backend
(`>=85 Excellent`, `>=70 Good`, `>=50 Fair`, else `Poor`), and the hint is
evidence rather than a label: *"Based on 2 of 8 components"*.

### 3.3 Connection panel

The worst layout defect in the app. At 1024 px the panel used a **viewport**
breakpoint for a **column** decision:

```
lg:grid-cols-[236px_minmax(0,1fr)_258px]
```

The panel's column was ~600 px wide, but `lg:` fired on the 1024 px viewport, so
three fixed tracks were forced into a 600 px box. The verdict collapsed to a
~40 px sliver and the session column was pushed out of view (`Dis…`, `SESSION DE…`).

Root cause: a component sized by the window instead of by its container. Fixed
with container queries; the panel now declares `@container` and switches on
`@[480px]`.

### 3.4 NANI

Two cards sat side by side describing the same engine: a one-third card with the
orb and a two-thirds card with the metrics. The narrow one was cramped; the wide
one was two-thirds empty. They are one subject and are now one card.

Also: the tab bar was a bespoke reimplementation of the APG tab pattern with its
own `onTabKeyDown` handler — duplicate keyboard logic, and the source of the
third tab language.

### 3.5 Copilot

| Finding | Why it matters |
|---|---|
| A canned "I'm NetPulse Copilot…" bubble was seeded into an empty conversation | It was styled, timestamped and copyable exactly like a model answer. There was no model. |
| The badge said **Offline** while the subtitle said "initializing…" | Two answers to the same question |
| The composer floated mid-screen | `h-full` inside an auto-height flex column is inert |

This is the honesty failure the brief warns about: the UI implied a connected
model that does not exist in this build.

### 3.6 VPN / config

| Finding | Evidence |
|---|---|
| A *reassuring* result — "No failures at a common stage in this window" — rendered in warning amber with a warning shield | `/vpn` capture |
| The branch that should have distinguished it could never run: the declared DTO had `dpiInferred: false` and no `likely` field, while the API returns `censorshipHintOf` | `tsc` error on `likely` |
| WireGuard's glyph was rose and OpenVPN's amber — the native tunnels were coloured exactly like the danger and warning states | `engineMeta.ts` |
| `bg-[#07121b]` hard-coded a near-black panel that never flips | light theme would render a black box |

The DTO lie is the interesting one. The frontend had invented a shape that never
existed on the wire, so a "clear" hint and a "raised" hint were indistinguishable
by construction — the amber styling was the only thing carrying the signal, and
it carried the wrong one.

### 3.7 Settings

- 400 px of selects inside a 1050 px card: ~50 % dead space.
- Paired fields did not align, because `Field` rendered label → **hint** → control,
  so a field with a hint sat 20 px lower than its neighbour.

### 3.8 Diagnostics

Collapsed cards (MTU, CGNAT) rendered a bordered body with nothing in it — the
row used `items-stretch`, so a collapsed card matched the height of an expanded
sibling.

### 3.9 Live map and Node detail

Both had **no `h1`**. Live map's `manifest.h1` was `""`. Node detail's title came
from `EngineHero`, whose `headingTag()` clamps to a minimum of `h2` — so the page
title was an `h2` and the document had no top-level heading at all.

### 3.10 The palette leak

The most widespread defect, and the one that is invisible until the theme flips.

`identity.css` redefines `--color-*` per theme. Raw Tailwind palette utilities are
literals, so they keep their dark-theme value on a white card. 110 distinct raw
utilities across 10 files:

```
text-cyan-100  text-violet-200  bg-emerald-500/10  border-rose-300/40
from-fuchsia-500/25  via-amber-300/40  to-yellow-200/30  …
```

They compiled to 84 distinct raw-palette rules in the shipped stylesheet. Two
consequences:

1. **Semantics detached.** `text-red-300` means "failure" only by accident; it
   carries no relationship to `--color-danger`, which is what the rest of the app
   and every theme override use.
2. **Theme broken.** `text-violet-200` (#ddd6fe) on a white card is ~1.2:1. The
   Aether row label on the VPN overview was effectively invisible in light theme.

This is not cosmetic hygiene. It is the difference between a colour system and a
set of colours that happen to be near each other.

---

## 4. Findings summary

| # | Finding | Class | Status |
|---|---|---|---|
| 1 | Two contradictory verdicts on the dashboard | Hierarchy / honesty | Fixed |
| 2 | `DNS —as` em-dash collision | Typography | Fixed |
| 3 | Connection panel collapsed at 1024 px | Layout | Fixed |
| 4 | Six 24 px metrics outranked the page verdict | Hierarchy | Fixed |
| 5 | ~400 px dead space in the gauge card | Layout | Fixed |
| 6 | Three tab languages | Consistency | Fixed |
| 7 | NANI's two cards described one engine | Structure | Fixed |
| 8 | Collapsed cards rendered empty bodies | Layout | Fixed |
| 9 | Reassuring result styled as a warning | Colour semantics | Fixed |
| 10 | DTO declared fields the API never sends | Correctness | Fixed |
| 11 | `EmptyState`/`LoadingState` drew a border inside every card | Surfaces | Fixed |
| 12 | Settings: 50 % dead space | Layout | Fixed |
| 13 | Paired fields misaligned (`Field` order) | Typography | Fixed |
| 14 | Copilot seeded a fake model message | Honesty | Fixed |
| 15 | Copilot "Offline" + "initializing" | Consistency | Fixed |
| 16 | Copilot composer floated mid-screen | Layout | Fixed |
| 17 | Live map had no `h1` | Accessibility | Fixed |
| 18 | Node detail had no `h1` (hero clamped to `h2`) | Accessibility | Fixed |
| 19 | 110 raw palette utilities / 84 compiled rules | Colour system | Fixed |
| 20 | WireGuard rose, OpenVPN amber = danger/warn hues | Colour semantics | Fixed |
| 21 | `bg-[#07121b]` never flips | Theming | Fixed |
| 22 | NOC overlay: token text on a hard-coded near-black | Theming | Fixed |
| 23 | Harness silently captured 100 % when asked for 125 % | Instrumentation | Fixed |
| 24 | `EngineBadge` per-engine hues were decoration | Colour semantics | Fixed |

Findings were not manufactured to justify changes. Six of them (#1, #3, #9, #14,
#19, #22) were producing visibly wrong output; three (#10, #18, #23) were
producing output that *looked* right and was not.

---

## 5. What this audit did not cover

Stated plainly, because a design audit that claims completeness is not one:

- **NANI investigation lifecycle.** Overview, hypotheses and evidence were
  inspected; the *creation* flow, *progress* reporting and *verification* result
  states were not driven end to end with live data.
- **VPN rows below the fold.** The first two sections were reviewed; the remaining
  configuration rows were not.
- **All 100 captures were verified structurally** (heading present, no horizontal
  overflow, correct theme/scale). A subset was inspected visually. The rest are
  evidence, not reviewed findings.
- **Motion.** Only reduced-motion compliance and the removal of decorative loops
  were checked; timing curves were not tuned.
- **Node detail, populated state.** The local data directory contains zero nodes,
  so only the empty/not-found state could be rendered. The `h1` fix is pinned by
  a component test instead (`designPrimitives.test.tsx`).

These gaps are carried into `UI_DESIGN_2_12_FINAL_HANDOFF.md` as conditions, not
silently dropped.
