# UI DESIGN 2.0 — 04 — Screen Specifications

Per screen: purpose, the one job it must do, its state vocabulary, and what changed.
Screens not listed were audited and found sound; silence is not an oversight.

---

## 1. Shell

**Job:** answer "where am I, and what is the state of the system?" without competing
with the content.

**Structure:** 76 px icon rail → 226 px context column → content. Two tiers, resolved
by `resolveSection()` longest-prefix URL matching.

**States:** collapsed rail (icons + tooltips), active section, section with no children.

**Changed:** nothing structural. The rail was verified at 100 % and 125 % text — it
does not clip, and its labels survive. It was left alone because the brief said to
change it only with evidence, and there was none.

**What the audit did find here** was the tab inconsistency (§3.1 of report 03), which
is a shared-control problem rather than a shell problem.

---

## 2. Dashboard

**Job:** one verdict, then the evidence for it.

### 2.1 Hierarchy

```
Row 1   ┌─ Verdict band (health gauge) ─┐ ┌─ ConnectionHero ──────────┐
        │ NETWORK COMMAND  Excellent 90 │ │ dial · status · actions   │
        │ Based on 2 of 8 components    │ │ SESSION DETAIL grid       │
        └───────────────────────────────┘ │ TUNNEL / TRAFFIC / GUARD  │
Row 2   ┌─ Connection card (2 cols) ────┐ ┌─ Measurements ────────────┐
        │                               │ │ 6 metrics in a 2-col grid │
        └───────────────────────────────┘ └───────────────────────────┘
```

Before, all six metrics sat in a bare six-across strip at 24 px — the widest thing
on the page was the least important. They are now inside a labelled **Measurements**
card at 20 px, so the page has one focal number (the verdict) and a supporting set.

### 2.2 State vocabulary

The dashboard must distinguish six conditions. What each renders:

| Condition | Rendering |
|---|---|
| Confirmed | `ok` value + timestamp of the measurement |
| Unknown | `—`, never `0` |
| Stale | value + age, muted |
| Loading | `Skeleton`, not `—` (a skeleton says "arriving"; `—` says "nothing") |
| Error | `Notice tone="danger"` with the failure, not a zero |
| Not applicable | the metric is absent, not zeroed |

### 2.3 The verdict scale

One scale, matching the backend:

```
>= 85  Excellent      >= 70  Good      >= 50  Fair      else  Poor
```

The band previously used `>=80 Nominal / >=50 Degraded` and printed the backend
label as a hint — so a score of 82 rendered **"Degraded Good"**. The page argued
with itself in the most prominent position on the screen.

The hint is now evidence, not a label: *"Based on 2 of 8 components"* — which is
the fact that explains why a score exists at all.

### 2.4 `DNS —as`

The hero metric rendered `{value} {unit}` unconditionally, so a missing value
produced `— ms`, which at 12 px reads as the word **"as"**. `HeroMetric` now
renders the unit only when a value exists.

---

## 3. Connection panel

**Job:** state the connection verdict and its measured details.

**States:** connected / disconnected / connecting / verifying / failed / unverified.

**The 1024 px defect:** three fixed tracks forced into a ~600 px column. The verdict
collapsed to a sliver; the session column left the viewport.

**Now:** container-driven. Above `@[480px]` the dial takes the left track and spans
two rows; the session detail becomes a 2-column `DetailCell` grid (label above a
truncating value) inside its own `@container`. Below it, everything stacks.

**Why `DetailCell` replaced `DetailRow`:** side-by-side label/value pairs cannot
truncate gracefully in a narrow column — the label wins and the value becomes `Dis…`.
Label-above-value degrades honestly.

---

## 4. NANI

**Job:** show what the investigation currently believes and why.

### 4.1 Overview

Two cards described the same engine: a ⅓ orb card and a ⅔ metrics card. The narrow
one was cramped, the wide one two-thirds empty. Merged into one **Engine** card:

```
@container lg:grid-cols-[200px_minmax(0,1fr)]
  left   orb + engine name + state
  right  metrics · notice · actions
```

### 4.2 Tabs

Ten sections on one shared `Tabs` component. NANI's bespoke bar (bottom rule, solid
accent fill, hand-written arrow-key handler) is gone; keyboard behaviour now comes
from Radix.

### 4.3 Hypotheses and evidence

Empty states were bordered boxes inside bordered cards. Now borderless tinted wells,
so "there is nothing here yet" is stated quietly rather than with the most structural
chrome on the page.

### 4.4 Progress and posteriors

**Not verified in this pass.** The brief requires that progress show no fake
percentages and that hypothesis posteriors come from the real backend. The rendering
paths were read and contain no invented values, but the states were not driven with
live investigation data. Carried as a condition in report 12.

---

## 5. Copilot

**Job:** explain, and be explicit about what it cannot do.

### 5.1 The honesty failure

A canned message — *"I'm NetPulse Copilot…"* — was seeded into an empty conversation
and rendered with the same bubble, timestamp and copy affordance as a model answer.
There is no local model in this build. The UI implied one.

**Now:** `messages` starts empty; the hero *is* the greeting. `clearConversation`
returns to `[]`.

### 5.2 One vocabulary

The badge said **Offline** while the subtitle said *"initializing…"*. Two answers to
one question. Both now derive from the same capability value:

- `Deterministic explanations — no local model (…)`
- `Local explanations — availability not reported in this build`

### 5.3 Composer placement

The composer floated mid-screen because `h-full` is inert inside an auto-height flex
column. The root now reserves the real height:

```
min-h-[calc(100dvh-var(--np-topbar-h)-76px)] flex flex-col
```

so the composer sits at the bottom where a message composer belongs.

### 5.4 Generated vs measured

The distinction the brief requires is now carried by the badge vocabulary rather than
by styling that could be read either way. A generated explanation never borrows the
visual language of a measurement.

---

## 6. VPN / engines

**Job:** state what is installed, what is running, and never be more optimistic than
the backend.

### 6.1 The reassurance bug

`AdaptiveRecoveryCard` rendered *"No failures at a common stage in this window"* in
warning amber with a warning shield. That sentence is **good news**.

It could not have done otherwise: the declared DTO was

```ts
censorshipHint: { level: string; reason: string; dpiInferred: false } | null
```

while the API returns `censorshipHintOf` with `{ likely, reason, considered,
distinctStrategies }`. `likely` did not exist, so the branch that distinguishes a
raised hint from a clear one was unreachable — TypeScript proved it. The styling was
carrying the whole signal, and carrying it backwards.

Fixed at the type, then at the presentation: `tone={likely ? 'warn' : 'info'}` with
`ShieldAlert` / `ShieldCheck`.

### 6.2 Engine identity

Engine glyphs were six arbitrary hues, including **WireGuard in rose** (the danger
hue) and **OpenVPN in amber** (the warning hue) — the two native tunnels were painted
as faults. All third-party cores now share the accent tint; Aether, the app's own
core, keeps its own family.

### 6.3 The connection timeline

`QuickConnectActivity` used a hard-coded `bg-[#07121b]` — a near-black that never
flips, so in light theme the panel was a black box. Now `bg-surface-2` with the
console feel carried by the mono labels and the timeline rail rather than by an
absolute colour.

Stage tones became state tokens; the icon and label distinguish the stages.

### 6.4 Below the fold

Rows 3+ of the VPN page were **not** reviewed in this pass. Carried as a condition.

---

## 7. Settings

**Job:** change a setting and know it saved.

**Changed:**
- Bodies widened `max-w-xl` → `max-w-2xl`; cards capped at `max-w-3xl`. Previously
  400 px of controls sat in a 1050 px card.
- General's fields paired into `sm:grid-cols-2`, so Theme/Text size and
  Language/Units align.
- `Field` anatomy fixed: label → control → help. The hint previously sat *between*
  label and control, so any field with a hint was 20 px lower than its neighbour.
- Notifications row lost its border (it is a row, not a surface).
- Save moved below a `border-t`, separating "commit" from "edit".

**States:** default / dirty / saving / saved / error. `Text size` applies instantly
(`data-type-scale` on `<html>`); theme likewise.

---

## 8. Diagnostics

Collapsed cards rendered bordered empty bodies because the row used
`items-stretch`, so a collapsed card matched the height of an expanded sibling.
`items-start` — collapsed cards now end at their header.

The three action buttons were `variant="ghost"`, which made destructive-adjacent
actions look like text. Now `variant="secondary" size="sm"`.

---

## 9. Live map

**Changed:** it had no `h1` at all (`manifest.h1 === ""`). A `PageHeader` was added.

The fullscreen NOC overlay used `bg-[#060a12]` while its own chrome used
`text-text` / `text-muted`. In light theme that is dark text on near-black. The
backdrop is now `bg-bg`.

**Not verified:** the NOC overlay only mounts on interaction, so it was not captured;
the defect is proven from the code, not from a screenshot.

---

## 10. Node detail

**Changed:** it had no `h1`. Its title came from `EngineHero`, and `headingTag()`
clamps to a minimum of `h2` — so the page title was an `h2` and the document had no
top-level heading.

`EngineHero` gained `pageTitle`, which renders `h1` and bumps the name to `text-xl`
to match `PageHeader`. Only `NodeDetailPage` passes it; the three VPN sub-views
correctly stay at `h2` because the VPN page owns the `h1`.

**Not captured:** the local data directory contains zero nodes, so only the
empty/not-found state renders. The fix is pinned by two component tests instead.
