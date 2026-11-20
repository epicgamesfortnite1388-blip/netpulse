# UI DESIGN 2.0 — 05 — Component Audit

Eight attributes per component: **purpose · anatomy · states · variants · tokens ·
accessibility · responsive · change**.

Components not listed were audited and left alone.

---

## 1. `Tabs` (`ui/Tabs.tsx`)

1. **Purpose** — pick one of N peer views; the selection changes content in place.
2. **Anatomy** — `TAB_LIST_CLASS` track → Radix `Trigger` per item (optional icon +
   label) → `TabPanel`.
3. **States** — active, inactive, hover, focus-visible, disabled.
4. **Variants** — `size: 'sm' | 'md'`; `ariaLabel`; per-item `icon`.
5. **Tokens** — `--np-r-3` (track), `rounded-md` (trigger), `bg-surface-2/50` track,
   `bg-accent-soft` + `text-accent-strong` active, `text-muted` idle.
6. **Accessibility** — Radix owns `role="tablist"`, `role="tab"`, roving tabindex,
   arrow keys, `aria-selected`. Icons are decorative and inherit the trigger's state.
7. **Responsive** — `flex-wrap` on the track, so eight tabs wrap rather than clip.
   Verified at 125 % text (Settings keeps all eight on one line at 1440).
8. **Change** — rewritten around `tabStyles.ts`; added `size`, `ariaLabel`, `icon`.
   NANI's duplicate implementation deleted.

---

## 2. `Segmented` (`ui/Segmented.tsx`)

1. **Purpose** — pick one of a *small* set of mutually exclusive options (2–4).
2. **Anatomy** — same track and trigger chrome as `Tabs`, different roles.
3. **States** — checked, unchecked, hover, focus-visible, disabled.
4. **Variants** — `size: 'sm' | 'md'`.
5. **Tokens** — identical to `Tabs` by construction (`TAB_LIST_CLASS`,
   `tabTriggerClass`).
6. **Accessibility** — `role="radiogroup"` / `role="radio"` / `aria-checked`. This is
   deliberately *not* `tablist`: a radio group announces "3 of 4" and does not imply
   a panel. A test asserts the shared chrome and the distinct roles together.
7. **Responsive** — inherits `flex-wrap`.
8. **Change** — adopted the shared chrome. It previously used `rounded-xl` while
   `Tabs` used `rounded-lg` — two radii for one affordance.

---

## 3. `EmptyState` (`ui/States.tsx`)

1. **Purpose** — say "there is nothing here yet" and what to do about it.
2. **Anatomy** — icon → title → description → optional action.
3. **States** — empty (single state by definition).
4. **Variants** — optional `action`, `icon`.
5. **Tokens** — `--np-r-3`, `bg-surface-2/40`, no border.
6. **Accessibility** — heading-ranked title; the action is a real button.
7. **Responsive** — centred, `px-6 py-12`, wraps.
8. **Change** — removed `border border-line`. It drew a bordered box inside every card
   that already had a border — a box in a box using the most structural chrome on the
   page to announce absence. A test asserts it draws no second border.

---

## 4. `LoadingState` (`ui/States.tsx`)

Same eight attributes; **change** — same border removal, same rationale. A loading
state and an empty state should differ by *motion*, not by frame weight.

---

## 5. `Field` (`ui/Field.tsx`)

1. **Purpose** — label a control and explain it.
2. **Anatomy** — label → **control** → help *or* error.
3. **States** — default, focused, error, disabled, with-hint, with-error.
4. **Variants** — `label`, `hint`, `error`, `htmlFor`.
5. **Tokens** — `text-mini` label, `text-xs` help, `text-faint` hint, `text-danger` error.
6. **Accessibility** — label is associated; the error replaces the hint rather than
   stacking, so a screen reader reads one message, not two contradictory ones.
7. **Responsive** — participates in the parent grid; no fixed widths.
8. **Change** — **help text moved below the control.** It previously sat between label
   and control, so in a two-column grid any field with a hint sat 20 px lower than its
   neighbour. That was the Settings misalignment. A test pins label → control → hint.

---

## 6. `Metric` (`ui/Metric.tsx`)

1. **Purpose** — one measurement, labelled, with optional unit and hint.
2. **Anatomy** — label → value + unit → optional hint.
3. **States** — value present, value absent (`—`), loading.
4. **Variants** — `size: 'md' | 'lg'` (20 px / 24 px).
5. **Tokens** — `metric-num` (tabular figures), `text-xl` default, `text-2xl` on `lg`.
6. **Accessibility** — label and value are separate elements so the value is not read
   as part of the label; the unit is adjacent text, not a pseudo-element.
7. **Responsive** — fills its grid cell; `MetricStrip` no longer truncates hints.
8. **Change** — added `size`, defaulting to **20 px**. Six 24 px metrics had outranked
   the page verdict. `MetricStrip` stopped truncating, because hints became sentences
   ("Based on 2 of 8 components") rather than labels.

---

## 7. `EngineHero` (`ui/Surface.tsx`)

1. **Purpose** — introduce a page or a major section with a name, identity and actions.
2. **Anatomy** — glyph → name + badges → tagline → description → actions → optional
   `visual` panel → optional footer.
3. **States** — page title, section hero; with/without visual, badges, actions.
4. **Variants** — `pageTitle?: boolean`.
5. **Tokens** — `rounded-xl`, `border-line-strong`, `bg-surface`, `shadow-floating`;
   the decorative glow now uses `--color-accent-soft` / `--color-aether-soft`.
6. **Accessibility** — `pageTitle` renders `h1` (`text-xl`); otherwise `headingTag()`
   at the surrounding level, clamped to a minimum of `h2`.
7. **Responsive** — `lg:grid-cols-[minmax(0,1fr)_minmax(300px,370px)]` when a `visual`
   is present; stacks below.
8. **Change** — added `pageTitle` (Node detail had no `h1`). The glow's hard-coded
   `rgba(34,211,238,…)` / `rgba(168,85,247,…)` were replaced by tokens — they were a
   cyan/violet wash that did not follow the theme.

---

## 8. `Notice` (`ui/Surface.tsx`)

1. **Purpose** — state a condition that is not the main content.
2. **Anatomy** — left rule → icon (optional) → text.
3. **States** — `info`, `ok`, `warn`, `danger`.
4. **Variants** — `tone`.
5. **Tokens** — `--color-accent` / `ok` / `warn` / `danger` at rule and ink.
6. **Accessibility** — `role="status"` where the notice is live; the left rule is
   decorative (`aria-hidden`), so the meaning is in the text and the icon.
7. **Responsive** — full width of its container.
8. **Change** — **no code change**, but the *usage* was the bug: a reassuring result
   was passed `tone="warn"` because the DTO made the correct branch unreachable.
   Fixed at the call site and at the type.

---

## 9. `EngineBadge` (`components/EngineBadge.tsx`)

1. **Purpose** — name the local core that produced a measurement.
2. **Anatomy** — single inline badge, `engineLabel` text.
3. **States** — renders, or renders **nothing** when no engine is recorded.
4. **Variants** — none.
5. **Tokens** — `text-accent` + `bg-accent-soft`.
6. **Accessibility** — `title` explains the badge; the label is the accessible name.
7. **Responsive** — inline, does not wrap.
8. **Change** — four per-engine hues collapsed to one. They were decoration (the label
   already names the runtime) and had no light-theme counterpart, so the tint vanished
   on a white card. The "renders nothing when unknown" behaviour was preserved — a
   never-tested measurement must not be labelled with a runtime that did not run.

---

## 10. `ConnectionDial` / `DetailCell` (`features/connection/`)

1. **Purpose** — show the connection verdict as an instrument reading, with its detail.
2. **Anatomy** — dial (state ring, state word, path) · detail cells (label above value).
3. **States** — disconnected, connecting, verifying, connected, failed, unverified.
4. **Variants** — full (hero) / compact.
5. **Tokens** — `np-dial`, `--np-r-2`, `bg-surface-2/60` for the session well.
6. **Accessibility** — the state word is text, not an image; the ring is decorative.
7. **Responsive** — `@[480px]` container breakpoint, not a viewport breakpoint.
8. **Change** — `DetailRow` (side-by-side) replaced by `DetailCell` (stacked) inside a
   container-queried grid. Side-by-side cannot truncate in a narrow column: the label
   wins and the value becomes `Dis…`.

---

## 11. `QuickConnectActivity` (`features/vpn/`)

1. **Purpose** — narrate a connection attempt as a sequence of measured milestones.
2. **Anatomy** — header (state + activity) → timeline (stage badge, message, engine,
   error) → route telemetry.
3. **States** — idle (renders nothing), active, failed stage, complete.
4. **Variants** — none.
5. **Tokens** — `bg-surface-2`, `border-line`, stage tones from the state family.
6. **Accessibility** — `aria-live="polite"`; `aria-label="Adaptive connection activity"`;
   "awaiting next measured milestone" rather than a fake percentage.
7. **Responsive** — timeline scrolls; messages `break-words`.
8. **Change** — `bg-[#07121b]` → `bg-surface-2` (the old value never flipped). Stage
   tones → state tokens. 18 raw palette classes removed.

---

## 12. `CapabilityMatrix` / `Chip` / `DataList` / `StatTile` / `Skeleton` / `Section`

Audited; **no change**. These already met the surface, radius and type rules. Recorded
here so the next pass knows they were checked rather than skipped.
