# UI DESIGN 2.0 — 02 — Design Direction

**Status:** ratifies and enforces the existing *Signal / Instrument* identity.
It does not replace it.

---

## 1. Why not a new direction

`identity.css` already records a direction and the alternatives it beat:

> Four candidates were explored: (A) a neon "network operations centre",
> (B) an editorial Swiss/SaaS data sheet, (C) a glassmorphic dark console, and
> (D) a precision measurement instrument. A and C are exactly the generic VPN
> aesthetic the brief rejects; B reads as a web dashboard rather than a Windows
> instrument. D was selected: NetPulse measures real things, and the interface
> should look like the instrument that measures them.

That is the correct answer, and it is already the implemented one. A second
direction would create the competing system the brief forbids. What this pass
found was not a wrong direction but **incomplete enforcement**: the stated rules
were true in the prose and false in the code.

The clearest example. The identity declares:

> A single sea-glass "signal" accent. Every other hue is SEMANTIC: amber =
> in-progress / unverified, coral = failed, violet = NANI. **A colour on this UI
> always means something.**

Meanwhile 110 raw palette utilities shipped, including WireGuard in rose (the
danger hue) and OpenVPN in amber (the warning hue) — so the two native tunnels
were painted as faults. The rule was documented and unenforced.

So this pass adds no new aesthetic. It closes the gap between the stated system
and the shipped one.

---

## 2. The direction, stated as testable rules

NetPulse is a **measuring instrument**. Its interface should behave like
laboratory equipment: legible at a glance, honest about what it does not know,
quiet until something is wrong.

| # | Rule | How it is enforced |
|---|---|---|
| 1 | **Calm by default.** No element moves or glows unless it is reporting change. | Decorative infinite animations removed; reduced-motion honoured |
| 2 | **A colour always means something.** Three token families only: semantic state, protocol identity, Aether subsystem. | `assertNoRawPalette` fails the build on any palette utility |
| 3 | **Never more optimistic than the measurement.** Unknown is rendered as unknown, not as a default. | Dashboard verdict scale unified; Copilot's fake model message removed; `censorshipHint` DTO corrected |
| 4 | **Hierarchy is a single ordering.** One page verdict, one scale. | Metrics demoted to 20 px; "Measurements" card separated from the verdict |
| 5 | **Geometry is inherited, not invented.** A nested surface never contradicts its parent's radius. | `--np-r-1/2/3`; `EmptyState` lost its inner border |
| 6 | **The type ramp is the user's, not the designer's.** | No `font-size` in `px`; `assertNoFixedPxType` + 12 px floor |
| 7 | **A panel sizes to its column, not to the window.** | `assertContainerQueries` |

---

## 3. Colour semantics

### 3.1 Three families, and nothing else

**Family 1 — semantic state.** These answer *"what is the condition?"*

| Token | Dark | Light | Means |
|---|---|---|---|
| `--color-accent` | `#6ed9bc` sea-glass | `#0e7490` | the signal itself; active, measured, in-flight |
| `--color-ok` | `#66d6ae` | `#036249` | confirmed good |
| `--color-warn` | `#e6b36a` | `#92400e` | unverified, degraded, needs attention |
| `--color-danger` | `#ee7a70` | `#b91c1c` | failed |

`assertStateSeparation` guarantees these resolve to three distinct values in each
theme. Two states that render identically are not two states.

**Family 2 — protocol identity.** `--color-proto-*` (7 protocols). A protocol is
an identity, not a condition: `vless` is not "better" than `trojan`, so these must
not be semantic. Each has a light-theme counterpart, which the raw palette
surrounds did not.

**Family 3 — Aether subsystem.** `--color-aether` / `-2` / `-3`. Aether is the
app's own core and gets its own family so it can be visually distinct without
borrowing a state hue.

### 3.2 The rule that decides the hard cases

> **If a colour is carrying information, it must be a state token. If it is
> carrying identity, it must be a protocol or subsystem token. If it is carrying
> neither, it should not be there.**

Applied to the three ambiguous cases in this codebase:

- **Engine glyphs** (Xray, sing-box, V2Ray, Hysteria2, WireGuard, OpenVPN).
  These were six arbitrary hues. They carry neither state nor identity that the
  label does not already carry in 16 px semibold text beside them. Collapsed to
  one accent tint. `EngineBadge` likewise.
- **Stage tones in the connection timeline.** These *do* carry information —
  in-flight / retried / failed / done — so they became state tokens. The
  distinction between `cyan-300` and `sky-300` for two in-flight stages was
  dropped deliberately: the icon (spinner / check / cross / dot) and the label
  already distinguish them.
- **Aether state ring.** On the always-dark `.aether-stage`, the *border* carries
  the hue (state token) and the *ink* stays `text-white/*`. A state token like
  `--color-danger` is `#b91c1c` in light theme — dark red on near-black — so
  using it for text on a permanently dark surface would have been a regression
  disguised as consistency.

### 3.3 Known semantic overlap — not resolved here

`--color-aether` is violet (`#a99be0`), and the identity states violet = NANI.
The Aether VPN subsystem and NANI therefore share a hue family.

This overlap **pre-dates this pass** — `AetherSurface` was already violet — and
routing it through the token made it consistent rather than removing it. It is
flagged as a condition rather than silently "fixed", because resolving it means
choosing between two subsystem identities, which is a product decision.

---

## 4. Typography

- **Mono micro-labels, tabular numerals.** Measurements are typographic, not
  chart-shaped. This is already the identity and it holds up.
- **The ramp is `calc(<rem> * var(--type-scale))` with a 12 px floor.** A fixed
  `10px` micro-label ignored the Text-size preference entirely: at 125 % every
  label stayed 10 px while surrounding text grew to 15 px. Guarded at source and
  on the compiled output.
- **Sizes are a ramp, not a set of choices.** `text-micro`, `text-mini`, `text-xs`,
  `text-sm`, `text-base`, `text-xl`, `text-2xl`. A component picks a rank.
- **`Metric` gained a `size` prop** so the *same* primitive can be a supporting
  reading (20 px) or the focal number (24 px). Before, every metric was 24 px and
  six of them shouted louder than the page verdict.

---

## 5. Spacing and rhythm

One system: the 4 px base with the 8-point rhythm. No second scale was introduced.

What was fixed was not the scale but its **application**:

- Settings: 400 px of controls inside a 1050 px card. Bodies widened to
  `max-w-2xl`, cards to `max-w-3xl`, and paired fields put on a 2-column grid —
  the same tokens, applied to the width that was actually available.
- Diagnostics: `items-stretch` made a collapsed card match an expanded sibling,
  producing bordered empty bodies. `items-start` — a one-word fix to the rhythm.

---

## 6. Surfaces and geometry

Three elevation steps (`surface` → `surface-2` → `elevated`), hairline `--color-line`,
and three radii `--np-r-1/2/3`. Panels are planes, not pills floating inside cards.

Two violations fixed:

1. `EmptyState` and `LoadingState` drew `border border-line` *inside* a card that
   already had a border — a box in a box, announcing "there is nothing here" with
   the most structural chrome on the page. Now a borderless tinted well.
2. The connection panel forced three fixed tracks into a narrow column (see §7).

---

## 7. Layout: size to the column

The single most important structural lesson of this pass.

The connection panel chose its layout from the **viewport**:

```
lg:grid-cols-[236px_minmax(0,1fr)_258px]
```

`lg:` fires at a 1024 px window. The panel's column was ~600 px. Result: the
verdict collapsed to a ~40 px sliver and the session column was pushed off-screen.

A component that is sized by its container must query its container. The panel now
declares `@container` and switches at `@[480px]`. `assertContainerQueries` makes
the capability a build requirement.

---

## 8. Iconography

Unchanged in style: 1.5 px stroke, 11–14 px, `lucide-react`. The pass changed only
*which* icons appear and what they mean:

- `ShieldAlert` for a raised censorship hint, `ShieldCheck` for a clear one. The
  clear case previously used the warning icon, so a reassuring result looked like
  a fault.
- Icons carry state only where the label cannot: the connection timeline's
  spinner / check / cross / dot.

---

## 9. What this direction refuses

Recorded so future work does not drift back:

- No glassmorphism, no backdrop blur on panels (the compiled stylesheet asserts it).
- No neon glow as decoration. Glow appears only as state.
- No looping animation to signal "alive". A measurement that has not changed should
  not move.
- No chart without real data behind it.
- No colour that is not in one of the three families.
- No fake numbers, fake percentages, or fake model output — including a
  plausibly-styled greeting bubble.
