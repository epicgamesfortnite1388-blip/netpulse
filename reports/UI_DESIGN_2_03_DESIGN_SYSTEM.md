# UI DESIGN 2.0 — 03 — Design System

**Contract status:** 47 → **53 assertions**, none weakened, none removed.

---

## 1. Token layer

Two files, applied in order:

| File | Owns | Rule |
|---|---|---|
| `styles/tokens.css` | Tailwind v4 `@theme` entries: colour primitives, the type ramp, spacing, radii, motion | Structural. Referenced by utilities. |
| `styles/identity.css` | Overrides the *semantic* custom properties; defines `np-*` classes | Imported after `tokens.css`. Because Tailwind emits `var(--color-*)`, overriding here repaints every screen without editing them. |

### 1.1 Semantic tokens (the only ones a component should name)

```
--color-bg / surface / surface-2 / surface-3 / elevated
--color-text / muted / faint
--color-line / line-strong
--color-accent / accent-strong / accent-soft / on-accent
--color-ok / warn / danger
```

Each is declared in `:root` (dark) **and** overridden for light. That pairing is
now asserted — see §4.3.

### 1.2 Identity tokens

```
--color-proto-sky / violet / orange / emerald / cyan / indigo / amber   (protocol)
--color-aether / aether-2 / aether-3 / aether-soft / aether-line        (subsystem)
```

### 1.3 Structural tokens

```
--type-scale          1 | 1.125 ('large') | 1.25 ('xl')     set by the user
--text-*              calc(<rem> * var(--type-scale))      12px floor
--np-r-1 / -2 / -3    radii
--np-topbar-h         58px
--ease-fluid / -spring / -out-soft,  --dur-quick / -base / -slow
```

---

## 2. Primitive inventory

| Primitive | File | Contract |
|---|---|---|
| `Card` / `CardHeader` / `CardBody` | `ui/Card.tsx` | `fold={{id, defaultOpen, summary, pinned}}` disclosure |
| `Section` | `ui/Surface.tsx` | `card` \| `flat`; opens the heading level for its subtree |
| `MetricStrip` | `ui/Surface.tsx` | A row of readings; hints are sentences, not labels (no truncation) |
| `Metric` | `ui/Metric.tsx` | `size?: 'md' \| 'lg'` → 20 px \| 24 px |
| `Panel` | `ui/Surface.tsx` | Bordered plane with a label |
| `Notice` | `ui/Surface.tsx` | Left-rule, `tone: info \| ok \| warn \| danger` |
| `Chip` | `ui/Surface.tsx` | `state: on \| off \| partial` |
| `DataList` / `DataRow` | `ui/Surface.tsx` | Label/value pairs, truncating |
| `Skeleton` | `ui/Surface.tsx` | Loading placeholder |
| `StatTile` | `ui/Surface.tsx` | Label + value + hint |
| `EngineHero` | `ui/Surface.tsx` | Page-or-section hero; `pageTitle` opts into `h1` |
| `EngineGlyph` | `ui/Surface.tsx` | Gradient-backed icon tile |
| `Tabs` / `TabPanel` | `ui/Tabs.tsx` | Radix-backed; owns APG roving tabindex |
| `Segmented` | `ui/Segmented.tsx` | `radiogroup`; shares the tab *chrome*, not the role |
| `EmptyState` / `LoadingState` | `ui/States.tsx` | Borderless tinted well |
| `Field` / `Input` | `ui/Field.tsx` | label → control → help/error |

---

## 3. Two structural decisions worth recording

### 3.1 One tab language, two roles

Three tab implementations existed. They are now one:

```ts
// ui/tabStyles.ts
export const TAB_LIST_CLASS =
  'flex flex-wrap items-center gap-1 rounded-[var(--np-r-3)] border border-line bg-surface-2/50 p-1';

export function tabTriggerClass(size: 'sm' | 'md' = 'md', active = false): string {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-md transition-colors …';
  const dims = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm';
  const state = active ? 'bg-accent-soft font-semibold text-accent-strong'
                       : 'font-medium text-muted hover:bg-surface-3/60 hover:text-text';
  return `${base} ${dims} ${state}`;
}
```

`Tabs` keeps `role="tablist"` / `role="tab"`; `Segmented` keeps
`role="radiogroup"` / `role="radio"` / `aria-checked`. They look like the same
control because they *are* the same affordance; they keep different roles because
they behave differently to a screen reader. Sharing chrome without merging
semantics is the point.

NANI migrated to the shared `Tabs`, deleting its hand-rolled `onTabKeyDown` —
duplicate keyboard logic that had to be kept correct twice.

### 3.2 Container queries instead of viewport breakpoints

The connection panel declares `@container` and switches on its own width:

```tsx
<div className="np-panel @container overflow-hidden">
  <div className="grid gap-6 px-6 py-6 @[480px]:grid-cols-[auto_minmax(0,1fr)] @[480px]:gap-x-8">
    <div className="flex items-start justify-center @[480px]:row-span-2 @[480px]:justify-start">
      <ConnectionDial state={state} />
    </div>
```

`@[300px]:grid-cols-2` is used again *inside* the session block, so the detail grid
adapts to the session column rather than to the window.

---

## 4. Validation: 47 → 53 assertions

`scripts/assert-ui-contract.mjs` reads the **compiled** stylesheet, because the
compiled stylesheet is what ships. Six assertions were added. None of the existing
47 was relaxed.

### 4.1 No raw palette utilities

```js
function assertNoRawPalette() {
  const families = 'green|red|blue|amber|yellow|emerald|sky|violet|purple|fuchsia|…';
  const raw = [...new Set([...css.matchAll(
    new RegExp(`\\.(?:bg|text|border|from|via|to|ring|fill|stroke|divide|outline|decoration)-(?:${families})-\\d{2,3}`, 'g')
  )].map((m) => m[0]))];
  checks.push([raw.length === 0, 'no raw palette utilities in the compiled stylesheet']);
}
```

This is the assertion that would have caught all 110 leaks. It is cheap, it has no
false positives (the three legitimate families are named `proto-*` / `aether-*` /
semantic), and it fails on the *output* rather than on the source, so a utility
reaching the build by any route is caught.

### 4.2 No hard-coded hex surfaces

```js
const raw = [...new Set([...css.matchAll(/\.(?:bg|from|via|to|ring)-\\\[#[0-9a-fA-F]{3,8}\\\]/g)].map((m) => m[0]))];
```

`bg-[#07121b]` and `bg-[#060a12]` were literal near-blacks that never flipped.

### 4.3 Theme parity

```js
for (const token of required) {
  const values = new Set([...css.matchAll(new RegExp(`${token}:\\s*([^;}]+)`, 'g'))].map((m) => m[1].trim()));
  if (values.size < 2) single.push(`${token} (only ${[...values].join(' | ')})`);
}
```

A token declared once and never overridden keeps its dark value on a white page.
That is the exact bug class this pass found, and it is now a build failure.

### 4.4 State separation

```js
new Set([value('--color-ok'), value('--color-warn'), value('--color-danger')]).size === 3
```

"Warning must not look like success" — asserted rather than trusted.

### 4.5 Container-query contexts

```js
const inline = [...css.matchAll(/container-type:\s*inline-size/g)].length;
```

If the mechanism disappears, panels silently fall back to viewport sizing and
collapse in narrow columns.

### 4.6 Every routed page declares an h1

Derived from `router.tsx`, so a new route is covered the moment it is registered:

```js
const modules = [...router.matchAll(/import\(\s*'@\/([^']+)'\s*\)/g)].map((m) => m[1]);
if (!/PageHeader|<h1[\s>]|pageTitle/.test(src)) missing.push(mod);
```

This caught `NodeDetailPage` on its first run. It is a source-level check, not a
render test — it cannot prove the heading reaches the DOM. The render-level
evidence is the capture manifest's per-route `h1` field, and the primitive itself
is pinned by a component test (§5).

### 4.7 What the contract deliberately does not do

It does not verify appearance. It verifies that the primitives the interface
depends on survived compilation. Layout and colour still need the capture matrix
in `UI_DESIGN_2_08_VISUAL_QA.md`.

---

## 5. Component-level tests

`apps/web/test/designPrimitives.test.tsx` — 9 tests. These pin what CSS cannot
see: element order, ARIA roles, and which element carries which class.

| Test | Pins |
|---|---|
| one `tablist`, N `tab`s, exactly one `aria-selected="true"` | Radix wiring |
| item icons reach the trigger | icon plumbing |
| `Tabs` and `Segmented` share the track chrome but keep distinct roles | the §3.1 decision |
| `EmptyState` draws no second border | the §6 surface rule |
| `Field` renders label → control → hint | the settings alignment fix |
| error replaces hint rather than stacking | form clarity |
| `Metric` defaults to 20 px, `size="lg"` gives 24 px | hierarchy fix |
| `EngineHero` is `h2` by default | a hero under a page title is a section |
| `EngineHero pageTitle` becomes `h1` | Node detail's missing page title |

---

## 6. Surface rules

- A nested surface never draws a second border. `EmptyState` and `LoadingState`
  are borderless tinted wells (`bg-surface-2/40`) inside a card that already has
  one.
- Radii come from `--np-r-1/2/3`. A component that needs a different radius is
  signalling a hierarchy that should be expressed by elevation instead.
- Elevation is three steps. There is no fourth.
- `--np-topbar-h` is the only place the topbar height is written.

---

## 7. Deliberate non-additions

| Considered | Decision |
|---|---|
| A `--color-engine-*` family | Rejected. Six arbitrary hues carried no information the label did not. |
| A fourth semantic state (e.g. `info`) | Rejected. `accent` already means "signal"; a fourth state invites misuse. |
| A pixel-diff suite | Rejected for now — see `UI_DESIGN_2_08` §6. A structural capture harness gives most of the value with no binary baseline store. |
| A second spacing scale | Rejected outright. |
