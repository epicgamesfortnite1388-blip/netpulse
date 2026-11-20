# UI_MASTER_02 — DESIGN SYSTEM DEFINITION

## Purpose

This document defines the single source of truth for NetPulse's visual language:
what a token is, which token answers which question, and which component owns
which pattern. Anything not described here is not part of the system.

Two files carry the system:

| File | Role |
|---|---|
| `apps/web/src/styles/tokens.css` | Tailwind v4 `@theme` block — primitives, type scale, motion, elevation, and the utility classes that consume them. |
| `apps/web/src/styles/identity.css` | The "Signal / Instrument" identity layer. Overrides a subset of tokens with the petrol-ink palette and adds the `np-*` component classes used by the shell, dial and panels. |

`identity.css` loads after `tokens.css`. Where the two disagree, `identity.css`
wins — deliberately, via `!important` on a small, documented set of overrides.

---

## 1. Colour

### 1.1 Surface ladder

The dark theme is built on four planes. The step between each plane is large
enough to read as a distinct physical layer, small enough to stay in one family.

| Token | Value | Used for |
|---|---|---|
| `--color-bg` | `#05080d` | Page floor. The void behind everything. |
| `--color-surface` | `#0d131d` | Panels, cards, table rows. |
| `--color-surface-2` | `#121a27` | Controls inside a surface: inputs, secondary buttons, hovered rows. |
| `--color-surface-3` | `#1a2433` | Third step — pressed states, nested controls, hover on a `surface-2` element. |
| `--color-elevated` | `#18222f` | Floating layers: menus, tooltips, popovers. |

**Why four and not three:** a control inside a panel inside the page needs three
distinct values before it stops reading as "same as its parent". `surface-3`
exists because `secondary` buttons sitting on `surface-2` rows had nowhere to go
on hover, so hover was indistinguishable from rest.

### 1.2 Text ladder

| Token | Value | Contrast on `--surface` | Role |
|---|---|---|---|
| `--color-text` | `#e8eef6` | 14.2:1 | Primary content, values, headings. |
| `--color-muted` | `#8fa0b3` | 6.4:1 | Secondary prose, descriptions, labels. |
| `--color-faint` | `#75879d` | 4.75:1 | Tertiary metadata — timestamps, sequence numbers, hints. Still passes AA. |

`--color-faint` was raised from `#5c6b7d` (3.5:1, below AA) to `#75879d`
(4.75:1). The dimmest tier is still body text; it is not permitted to fail AA.

### 1.3 Accent and ink-on-accent

| Token | Value | Role |
|---|---|---|
| `--color-accent` | `#22d3ee` | Primary action fill, active indicator, focus ring. |
| `--color-accent-strong` | `#67e8f9` | Hover on accent-filled surfaces. |
| `--color-accent-soft` | `rgba(34,211,238,0.10)` | Tinted selection background. |
| `--color-on-accent` | `#04161d` | Ink drawn **on** an accent fill. 10.7:1 against accent. |
| `--color-accent-foreground` | `#04161d` | Alias of `on-accent`, so `text-accent-foreground` resolves. |

**Fixed defect (C-1):** `text-accent-foreground` was used by `Button`,
`NaniPage` and `CopilotPage` while `--color-accent-foreground` was never
declared. Tailwind emitted the utility, the property resolved to nothing, and
the label inherited the parent colour — white on cyan at 1.75:1. The alias now
exists in all three theme blocks.

### 1.4 State colours

| Token | Dark value | Light value | Meaning |
|---|---|---|---|
| `--color-ok` | `#34d399` | `#036249` | Healthy, connected, verified. |
| `--color-warn` | `#fbbf24` | `#92400e` | Degraded, needs attention, partially armed. |
| `--color-danger` | `#f87171` | `#b91c1c` | Failed, unreachable, fail-closed. |

These are the only three semantic colours. Protocol accents
(`--color-proto-*`) and the Aether palette are decorative and never carry
meaning on their own — they always appear next to a text label.

### 1.5 Light theme

The light theme is not an inversion. Surfaces become `#ffffff` / `#eef2f7` /
`#dfe5ec`, text becomes `#0f172a`, and every accent is re-picked for contrast
against white rather than re-used from dark:

- accent `#0e7490` (7.4:1 on white) instead of `#22d3ee` (1.6:1 on white)
- ok `#036249`, warn `#92400e`, danger `#b91c1c`

Light theme is applied by `html[data-theme='light']` and by
`@media (prefers-color-scheme: light)` when no explicit theme is set, so the
system preference is honoured on first paint.

---

## 2. Typography

### 2.1 Families

| Token | Stack |
|---|---|
| `--font-sans` | `'Inter Variable', ui-sans-serif, system-ui, sans-serif` |
| `--font-mono` | `'JetBrains Mono Variable', ui-monospace, 'Cascadia Mono', monospace` |

Mono is used for values that must align vertically or be compared digit by
digit: IPs, ports, byte counts, latencies, sequence numbers, engine ids. Prose
is always sans.

### 2.2 Type scale

Every step is `calc(<rem> * var(--type-scale))`. The multiplier is set on
`:root` by the Text-size setting, so the entire interface scales from one
number.

| Token | Base size | Use |
|---|---|---|
| `--text-micro` | 12px | Micro-labels, kbd hints, timestamps. **This is the floor.** |
| `--text-mini` | 13px | Dense table text, secondary metadata. |
| `--text-xs` | 12px | Badges, captions. |
| `--text-sm` | 14px | Body default, form labels, buttons. |
| `--text-base` | 16px | Long-form prose. |
| `--text-lg` | 18px | Card titles. |
| `--text-xl` | 20px | Section headings, secondary metrics. |
| `--text-2xl` | 24px | Page headings, primary metrics. |
| `--text-3xl` | 30px | Hero verdict only. |

**12px floor.** `test/typeScale.test.ts` fails the build if any rendered text
falls below 12px at scale 1.0, or if any arbitrary `text-[Npx]` bypasses the
scale. Two violations in `ConnectionHero.tsx` (`text-[11px]`) were migrated to
`text-micro`.

The same pass found eight `font-size: <literal>px` rules in `identity.css`
(`.np-label` 10px, `.np-rail-item` 9px, `.np-dial-sub` 9px, `.np-state-badge`
10px, `.np-row-value` 13px, `.np-btn-primary` 13px, `.np-btn-quiet` 12px,
`.np-context-link` 12.5px). Hand-written CSS is invisible to a TSX scan, so all
eight silently ignored the Text-size preference. They are now
`calc(<rem> * var(--type-scale))`, and the test scans both stylesheets for
unscaled declarations.

### 2.3 Micro-label convention

`np-label` is the system's signature type treatment: 12px, uppercase,
`letter-spacing: 0.08em`, `--color-faint`, `font-weight: 500`. It appears on
every field label, table header and panel kicker. Uppercase + tracking makes a
label read as a *label* without needing a second colour or a divider.

---

## 3. Space, radius, elevation

### 3.1 Radius

| Token | Value | Applies to |
|---|---|---|
| `--np-r-1` | 3px | Badges, kbd, chips. |
| `--np-r-2` | 6px | Buttons, inputs, small controls. |
| `--np-r-3` | 10px | Panels, cards. |
| `--np-r-4` | 14px | Overlays, dialogs, the hero band. |

**Nested radius rule:** an inner element's radius must be smaller than its
container's by at least the container's padding. A `--np-r-2` control inside a
`--np-r-3` panel is correct; two `--np-r-3` elements nested is a defect. This is
why `Tabs` uses `rounded-lg` on the list and `rounded-md` on the triggers.

### 3.2 Elevation

| Token | Use |
|---|---|
| `--shadow-raised` | Cards that sit on the page floor. |
| `--shadow-floating` | Menus, popovers, tooltips. |
| `--shadow-overlay` | Dialogs, command palette, drawers. |

Shadows are paired with a hairline border (`--color-line`). The border carries
the edge; the shadow only implies height. On a near-black page a shadow alone
disappears.

### 3.3 Spacing rhythm

Layout uses a 4px base. Component-internal padding: 12px (`px-3`), 14px
(`px-3.5`), 16px (`px-4`), 20px (`px-5`), 24px (`px-6`). Page gutters are 24px
desktop / 16px mobile. Nothing uses an odd value except 14px, which exists so a
card header and its body can share a vertical rhythm without one looking
cramped.

---

## 4. Motion

| Token | Value | Use |
|---|---|---|
| `--ease-fluid` | `cubic-bezier(0.22, 1, 0.36, 1)` | Default for anything that moves a distance. |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Overlay entry only. Never on hover. |
| `--ease-out-soft` | `cubic-bezier(0.4, 0, 0.2, 1)` | Backdrop fades. |
| `--dur-quick` | 140ms | Hover, focus, colour change. |
| `--dur-base` | 200ms | Most transitions, tooltip entry. |
| `--dur-move` | 280ms | Drawers, cards entering. |
| `--dur-slow` | 380ms | Route change (`page-enter`). |

**The no-loop rule.** Nothing in the primary UI animates forever. The one
exception is `pulse-dot` (2s opacity pulse) on a status dot that is genuinely
not in a terminal state. `animate-ping` was removed from NANI's `AiCore` because
a perpetual ping reads as "still loading" even when the system is idle.

**Reduced motion.** Seven `@media (prefers-reduced-motion: reduce)` blocks
neutralise every keyframe animation, the route progress rail, and the Aether
decorative layers. Motion is never the only signal — every animated state also
has a static text or colour equivalent.

---

## 5. Component inventory

### 5.1 Primitives (`components/ui/`)

| Component | Variants / API | Notes |
|---|---|---|
| `Button` | `primary`, `secondary`, `ghost`, `danger` × `sm`, `md`, `lg` | Primary is a **solid** accent fill. Fixed from a faint outline that contradicted `.np-btn-primary`. |
| `IconButton` | requires `label` | Label becomes `aria-label` + `title`. |
| `Badge` | tone-based; base carries `uppercase tracking-wide` | Consistent with `DemoBadge` / `PhaseBadge`. |
| `Card` | `Card` / `CardHeader` / `CardBody` | Header border is `line-strong`; body padding 14px vertical to align with header. |
| `Field` | `Field` (label + hint + error), `Input`, `Select` | Focus: `border-accent/60` + 1px accent ring. |
| `Switch` | Radix-based | Thumb optically centred at 3px / 21px, not 4px / 20px. |
| `Tabs` | Radix-based, `TabPanel` | List `rounded-lg`, triggers `rounded-md`. Panel does not re-animate. |
| `Tooltip` | Radix-based | Arrow fill follows `--color-elevated`; entry is `fade-up` at `dur-base`. |
| `States` | `EmptyState`, `ErrorState`, `LoadingState`, `PageSkeleton` | `ErrorState` carries `role="alert"`. Empty states use a solid border, not dashed. |
| `HeadingLevel` | context provider | Keeps document outline valid when cards nest at varying depths. |
| `Disclosure` | `DisclosureScope`, `CollapsibleCard`, `FoldNote` | The fold system — see §5.3. |

### 5.2 Composites (`components/ui/Surface.tsx`)

`EngineGlyph`, `EngineHero`, `Section`, `StatTile`, `CapabilityMatrix`,
`MiniMetric`, `FieldPill`, `MetricStrip`, `Panel`, `Notice`.

These are the vocabulary a feature page composes from. A feature page should
almost never write raw `div`s for layout — it composes `Section` + `StatTile` +
`MetricStrip`.

### 5.3 The fold system

`DisclosureScope` gives a page one "show everything / show essentials" switch.
`CollapsibleCard` and `FoldNote` read the scope from context, so a single
toolbar toggle expands every optional block on the page at once. Default state
is folded for secondary content and open for primary content. This is what keeps
dense pages (NANI, Settings, VPN) from presenting forty controls at once.

---

## 6. Utility classes owned by the system

| Class | Definition | Purpose |
|---|---|---|
| `np-panel` | `--color-surface`, `--np-r-3`, hairline border, `--shadow-raised` | The one card look. |
| `np-inset` | `--color-bg` at reduced radius | Recessed well inside a panel (session detail, code blocks). |
| `np-label` | see §2.3 | Micro-label. |
| `np-row` | flex, space-between, 1px top border | Definition-list row. |
| `np-state-badge` / `np-state-dot` | tone via `--np-state` | Status pill. Tone is set per instance. |
| `np-btn-primary` / `np-btn-quiet` / `np-icon-btn` | CSS-native buttons | Used by the connection console where the React `Button` would add a wrapper. Must stay visually identical to `Button`'s `primary` / `ghost` / `IconButton`. |
| `np-section-head` | label + rule | Section divider with a trailing hairline. |

**Rule:** `np-btn-primary` and `Button variant="primary"` are the same control in
two implementations. If one changes, the other changes in the same commit. They
drifted once (outline vs fill) and that drift is what C-2 in the audit records.

---

## 7. Iconography

Lucide, 1.75px stroke, sized 13–18px in UI chrome and 20–24px in empty states.
Icons are never the sole carrier of meaning: every icon that conveys state sits
next to a text label, and every icon-only control has an `aria-label`.

Duplicate-icon defect fixed: the Dashboard's `QUICK_ACTIONS` used `Zap` for six
of eight actions. Each action now has a distinct glyph (`Network`, `Activity`,
`Route`, `Shield`, `Flag`, `Gauge`), so the list is scannable by shape.

---

## 8. What is deliberately excluded

- No second accent hue for "secondary" actions. Hierarchy comes from fill vs
  outline vs ghost, not from colour variety.
- No gradients on functional surfaces. Gradients appear only in the brand mark
  and the Aether decorative layer.
- No glassmorphism on content panels. `surface-glass` is overridden to a solid
  surface in `identity.css`; translucency is reserved for the topbar scroll
  state and overlays.
- No icon fonts, no sprite sheets, no custom SVG icon set. Lucide only.

---

## 9. Enforcement

| Guard | What it catches |
|---|---|
| `test/typeScale.test.ts` (13 tests) | Arbitrary `text-[Npx]`, text below the 12px floor, unscaled `--text-*` tokens, and fixed-px `font-size` in either stylesheet |
| `test/tokenRefs.test.ts` | Classes referencing custom properties that are never declared |
| `test/headingLevel.test.ts` | Invalid heading nesting in composed pages |
| `scripts/assert-ui-contract.mjs` | A required token or class missing from the **compiled** CSS; dead `var()` without a fallback; fixed-px type in the build output |
| ESLint `no-unused-vars` | Dead imports left behind by refactors (caught four during this pass) |
| `tsc --noEmit` | Type drift between component props and call sites |

Current state: **typecheck clean, 509/509 web tests pass, ESLint clean, UI
contract 47/47, production build succeeds in 12.3s.**

---

## APPENDIX — Evidence correction (recovery mission, 2026-11-20)

Original text preserved above. Corrections:

- Any contrast ratio quoted from the `tokens.css` base palette does not describe the shipped UI: `identity.css` is imported last (`main.tsx:19`) and overrides those tokens. Use the verified values in the UI_MASTER_10 correction appendix (faint/surface 4.62:1, on-accent 9.74:1, warn 9.27:1 — all AA pass).
- "Seven `prefers-reduced-motion` blocks" → **five** (see UI_MASTER_09 correction appendix).
- "`animate-ping` was removed from NANI's AiCore" is accurate; one intentional, reduced-motion-safe `animate-ping` remains at `AgentPathTrace.tsx:78` (outside AiCore).
