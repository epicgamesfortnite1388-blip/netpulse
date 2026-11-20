# UI_MASTER_07 — CONFIGURATION UX

## 1. Scope

`SettingsPage.tsx` — 896 lines, 7 tabs, ~40 controls. This is the densest surface
in the application and the one most likely to feel like a database admin tool.
The design goal is the opposite: **every control explains itself, every save is
scoped, and no invalid state can be submitted.**

---

## 2. Structure

Seven tabs, each a single `Card` with a `CardHeader` naming the domain:

| Tab | Controls | Save button |
|---|---|---|
| General | Theme, Text size, Language, Units, Notifications | Save general |
| Network | IP preference, Test timeout, Probes per test, Geo provider, Preferred proxy core | Save network |
| Diagnostics | Default target, Ping count, Route depth, Packet loss threshold | Save diagnostics |
| Optimization | Scoring weights (multi-field) | Save weights |
| VPN | Node discovery profile, behaviour preferences | Save VPN |
| Automation | Split tunnel rules | Save split tunnel |
| Platform | Capability matrix, version info, Reset App State | — |

### 2.1 Why tabs and not one long page

Forty controls in one column produces a page that scrolls past four screens and
has no landmarks. Seven tabs mean the user picks a domain first, then reads at
most six controls. The tab labels are nouns (`Network`, `Diagnostics`), not verbs
— configuration is a place you go, not an action you perform.

### 2.2 Why per-tab save

There is one save button per tab, each scoped to its own slice:

```tsx
<Button variant="primary" loading={saving} onClick={() => void save({ general: draft.general })}>
  <Save size={14} /> Save general
</Button>
```

A single global "Save all" was rejected because:

- It cannot report *which* section failed when the backend rejects one field.
- It forces the user to re-validate sections they did not touch.
- It makes the blast radius of a mistake the entire settings object.

The button label names its scope ("Save general", not "Save"). After a save, the
button returns to rest and the tab's values are the persisted values.

---

## 3. The weight-sum validator

The Optimization tab holds scoring weights that must total 100. This is the best
example of validation UX in the product:

```
Scoring weights
┌──────────────────────────────────────────────────┐
│  Σ 94 / 100                          (text-danger)│
│  …sliders / inputs…                               │
│                                                   │
│  [ Save weights ]  ← disabled                     │
└──────────────────────────────────────────────────┘
```

Three coordinated signals:

1. **Live sum** — `Σ {weightSum} / 100` updates on every keystroke.
2. **Colour** — `text-ok` at exactly 100, `text-danger` otherwise.
3. **Blocked submit** — `disabled={weightSum !== 100}`.

The user never has to press Save to discover the weights are wrong, and never
receives a backend error for a condition the frontend could compute. The `Σ`
glyph makes it read as a formula rather than a status message.

### 3.1 Why not clamp automatically

Auto-normalising the last weight to make the sum 100 was rejected: it silently
changes a number the user did not edit. An explicit sum with a blocked button
keeps the user in control of every value.

---

## 4. Field anatomy

Every control goes through the shared `Field` component:

```
┌────────────────────────────────────────────────────┐
│  Test timeout (ms)                                  │  ← label, text-sm
│  Per-operation timeout for network probes           │  ← hint, text-xs text-faint
│  ┌──────────────────────────────────────────────┐  │
│  │ 5000                                          │  │  ← Input
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

| Part | Purpose |
|---|---|
| Label | What the control is |
| Hint | What it does, in one line — present on every non-obvious field |
| Control | `Select`, `Input`, or `Switch` |

Hints are not optional decoration. `Route depth (max hops)` is meaningless
without *"Used by the route checker and traceroute"*, and `Packet loss threshold
(%)` is dangerous without *"Above this, routes/servers are flagged degraded"*.

### 4.1 Field width

`CardBody className="max-w-xl space-y-4"` — 576px. Form controls wider than
~600px are harder to scan because the label-to-control distance exceeds a single
saccade. Every settings form is capped at `max-w-xl` regardless of window width.

### 4.2 Switch rows

Booleans are not `Field` + `Switch`. They are a bordered row:

```
┌────────────────────────────────────────────────────┐
│ Notifications                          [ ●——]      │
│ Toast notifications for finished tests and failures │
└────────────────────────────────────────────────────┘
```

The whole row is the visual unit, with the switch right-aligned. This is the
standard platform convention (macOS System Settings, iOS Settings) and it makes
the toggle target unambiguous.

---

## 5. The "Why these settings" fold

`SectionNote` renders a collapsible explanation under complex sections:

```tsx
<SectionNote id="weights">…</SectionNote>
<SectionNote id="vpn-behavior">…</SectionNote>
<SectionNote id="split-tunnel">…</SectionNote>
<SectionNote id="platform-caps">…</SectionNote>
```

These are long-form explanations of *why* the settings exist and what changing
them does. They are folded by default because a returning user does not need
them again — but they are always one click away, and they participate in the
page-level `DisclosureScope`, so "Collapse all" / "Expand all" in the toolbar
controls them together with every other fold on the page.

This is the mechanism that lets the page be both dense and self-documenting: the
explanation exists, but it does not occupy space by default.

---

## 6. Capability matrix (Platform tab)

The Platform tab renders the backend's capability report as a matrix of
`CapBadge` rows:

| Capability | Badge state |
|---|---|
| Supported | `supported` |
| Unavailable | `unavailable` |

`CapBadge` was `rounded-full` (a pill) while every other badge in the product is
`rounded-md`. Two badge shapes in one product is a tell that they were written by
different hands. It is now `rounded-md`, matching `Badge`, `DemoBadge` and
`PhaseBadge`.

### 6.1 Why a matrix and not prose

A capability report is a lookup table. The user arrives with one question —
*"can this build do X?"* — and the answer should be one row, not a paragraph.
The matrix also makes absence visible: a missing row is a bug, whereas a missing
sentence is invisible.

---

## 7. Destructive action: Reset App State

The one genuinely dangerous control in Settings.

### 7.1 Guard sequence

1. Desktop-only — in web mode it toasts *"Reset App State is a desktop-app
   feature"* rather than rendering a button that cannot work.
2. Explicit confirmation dialog naming what will happen.
3. **Backup first** — `reset_app_state` moves every data file into a backup
   directory before touching anything, and returns the backup path.
4. The backup path is reported to the user via toast.

### 7.2 Wording

The confirmation text states the consequence in operational terms (networking is
disabled until the next normal launch; data files are moved, not deleted), not in
generic "this cannot be undone" language. A user who understands what moves where
can decide correctly; a user told only "are you sure?" cannot.

---

## 8. Text size — the setting that changes the interface

`Text size` offers Default (100%), Large (112%), Extra large (125%). It sets
`--type-scale` on `:root`, which multiplies every `--text-*` token.

The hint explains the consequence plainly: *"Scales every text size in the app at
once. Useful on high-DPI panels, or if the default type is too small to read
comfortably."*

This is why the type-scale test exists. A single arbitrary `text-[11px]`
anywhere in the codebase is a place where the user's accessibility setting
silently does not apply. At 125%, an 11px string stays 11px while everything
around it grows to 15px — the interface develops a hole. The test fails the build
on any such hole.

---

## 9. Loading and error states

| State | Render |
|---|---|
| Loading | `<LoadingState label="Loading settings" />` — a labelled skeleton, not a spinner |
| Load error | `ErrorState` with `role="alert"` and a retry action |
| Save in flight | Button `loading` prop → spinner replaces the icon, button disabled |
| Save error | Toast with the backend message |

The page does not render an empty form while loading. An empty form is
indistinguishable from "all settings are blank", which is a real and alarming
state.

---

## 10. Fixed defects

| # | Defect | Fix |
|---|---|---|
| C-1 | `CapBadge` used `rounded-full`, inconsistent with every other badge | `rounded-md` |
| C-2 | Settings tab content re-animated via `TabPanel` on every switch, conflicting with `page-enter` | Removed panel animation |
| C-3 | `Tabs` list and triggers shared the same radius, producing no nesting | List `rounded-lg`, triggers `rounded-md` |
| C-4 | `Switch` thumb was optically off-centre (4px/20px in a 24px track) | 3px / 21px |
| C-5 | `Input`/`Select` focus used `border-accent/80` with no ring — weak on dark surfaces | `border-accent/60` + 1px accent ring |

---

## 11. Acceptance criteria

| Criterion | State |
|---|---|
| Every non-obvious control has a hint | Pass |
| Invalid weight sum blocks save before submit | Pass |
| Invalid weight sum is visible before save | Pass — live `Σ` |
| Save scope is named on the button | Pass |
| Destructive action backs up first | Pass |
| Destructive action names its consequence | Pass |
| Explanations available without occupying space | Pass — `SectionNote` |
| Text size setting affects every string | Pass — enforced by test |
| No empty form during load | Pass |
| All badge shapes consistent | Pass |
