# UI_REMEDIATION_05 — Palette and Contrast

**Scope:** the colour system, and contrast measured from the rendered interface.
**Verdict:** **no raw palette utilities, and no AA contrast failures** — after fixing
two latent failures this audit found.

---

## 1 Why the figures here are computed, not quoted

The brief was explicit: *"Measure contrast against the actual resolved background, not a
source token that gets overridden later… Do not report contrast values without
identifying the exact foreground and background used."*

That constraint is not pedantry. This palette is layered: `tokens.css` declares a token
layer, `identity.css` overrides it with the petrol-ink/sea-glass palette, and a third
block re-declares the light theme. A contrast figure read from `tokens.css` describes a
value the user never sees — `--color-faint` is declared in **both** files and the
identity layer wins (recorded as R-14 in `_01`).

So `scripts/ui-colour-audit.mjs` never reads a token. For every text-bearing element it
asks the browser for:

1. the computed `color`;
2. the colour actually painted behind it, by walking ancestors, compositing translucent
   layers, and — where an ancestor paints a gradient — returning **every gradient stop**
   so the worst case is reported.

Contrast is then computed from those resolved values with the WCAG relative-luminance
formula, against a threshold of **4.5:1** for normal text and **3:1** for large text
(≥24px, or ≥18.66px bold).

## 2 Raw palette utilities

Scanning every rendered element's class list for Tailwind palette utilities
(`bg-|text-|border-|from-|to-|ring-|fill-|stroke-…-<hue>-<shade>`):

| Route | Dark | Light |
|---|---|---|
| dashboard | 0 | 0 |
| vpn | 0 | 0 |
| nani | 0 | 0 |
| diagnostics | 0 | 0 |
| nodes | 0 | 0 |
| settings | 0 | 0 |
| engines | 0 | 0 |
| map | 0 | 0 |

**Zero, measured from the DOM** — not from the source. A class string can be assembled at
runtime, so the rendered class list is the only honest check.

## 3 Contrast — two failures found, both fixed

The first audit pass reported **4 failures**, and they were two distinct pairs:

```
/nodes      dark   4.21:1 (needs 4.5)  fg=#718783  bg=#162328   "Total nodes"  .text-micro.font-medium.uppercase
/nodes      light  4.21:1 (needs 4.5)  fg=#5d7570  bg=#e9eee9   "Total nodes"
/settings   dark   4.21:1 (needs 4.5)  fg=#718783  bg=#162328   "Toast notifications for finished tests…"
/settings   light  4.21:1 (needs 4.5)  fg=#5d7570  bg=#e9eee9   "Toast notifications for finished tests…"
```

### Failure 1 — `--color-faint` against `surface-2`

`--color-faint` measured **4.21:1** on `--color-surface-2` and **3.72:1** on
`--color-surface-3` in dark theme, and the equivalent in light. It is used for metric
labels and helper text throughout — including the "Total nodes" label and Settings
helper copy, which are real content, not decoration.

Fixed by raising the token's lightness while holding hue and saturation constant, so the
petrol-green character is preserved and only the legibility changes:

| Theme | Before | After | On `surface` | On `surface-2` | On `surface-3` |
|---|---|---|---|---|---|
| Dark | `#718783` | `#839793` | 4.62 → **5.73** | 4.21 → **5.22** | 3.72 → **4.62** |
| Light | `#5d7570` | `#506561` | 4.95 → **6.22** | 4.21 → **5.29** | 3.68 → **4.62** |

### Failure 2 — `--state-idle` / `--state-unknown` shared the same value

The audit's worst-pair listing exposed a second problem the failure list had not: the
state tokens `--state-idle` and `--state-unknown` were the **same hex** as the old faint
value, so they inherited the same sub-AA behaviour on raised surfaces:

| Value | on `surface` | on `surface-2` | on `surface-3` |
|---|---|---|---|
| `#718783` (dark, before) | 4.98 | 4.21 | 3.72 |
| `#5d7570` (light, before) | 4.95 | 4.21 | 3.68 |

These were only *rendered* on the darkest surface in this environment, so the pass was
real but accidental — any idle-state label placed on a raised card would have failed.
Both now use the same AA-compliant neutral as `faint` (`#839793` / `#506561`), which is
correct rather than a compromise: idle and unknown are neutral states, so they belong to
the neutral text tone.

## 4 Final measured result

16 route × theme combinations, 192 text samples, 36 distinct foreground/background pairs:

| Theme | Samples | Distinct pairs | Worst ratio | Failures |
|---|---|---|---|---|
| Dark | 96 | 17 | **5.22:1** | **0** |
| Light | 96 | 19 | **4.56:1** | **0** |

Worst pairs, with the exact foreground and background named:

**Dark**

| Ratio | Foreground | Background | Text | Size/weight |
|---|---|---|---|---|
| 5.22:1 | `#839793` (`--color-faint`) | `#162328` (`--color-surface-2`) | "Toast notifications for finished…" | 12px / 400 |
| 5.73:1 | `#839793` | `#101a1e` (`--color-surface`) | "Connect" | 12px / 500 |
| 6.18:1 | `#839793` | `#0a1114` (page backdrop) | "Overview" | 12px / 500 |
| 6.30:1 | `#93a6a2` (`--color-muted`) | `#162328` | "VPN disconnected" | 12px / 500 |

**Light**

| Ratio | Foreground | Background | Text | Size/weight |
|---|---|---|---|---|
| 4.56:1 | `#0b7e68` (`--color-accent`-family) | `#f3f5f1` | "1 core" | 12px / 500 |
| 5.00:1 | `#0b7e68` | `#ffffff` (`--color-surface`) | "Installed" | 12px / 500 |
| 5.29:1 | `#506561` (`--color-faint`) | `#e9eee9` (`--color-surface-2`) | "Toast notifications…" | 12px / 400 |
| 5.36:1 | `#ffffff` | `#0e7490` (`--color-proto-cyan`) | "Measure" | 12px / 500 |

Every pair clears 4.5:1. The tightest is light-theme accent text at 4.56:1, which has
only ~1% margin — recorded here rather than rounded away, because the next tint added
under it would break it.

## 5 Semantic colour usage

The palette has three legitimate token families, and they mean different things:

| Family | Tokens | Means | Where |
|---|---|---|---|
| Semantic | `--color-ok`, `--color-warn`, `--color-danger`, `--color-accent` | **state** | status badges, health, errors |
| Protocol | `--color-proto-{sky,violet,orange,emerald,cyan,indigo,amber}` | **protocol identity** | node type, engine identity |
| Aether | `--color-aether`, `-2`, `-3` | **subsystem identity** | the Aether engine surface |

The rule enforced: a semantic colour never identifies a protocol, and a protocol colour
never encodes state. Verified by inspection of the assignments and by the contract
assertion that `--color-warn` must not collide with `--color-ok` (mutation-tested in
`_04`).

## 6 Engine identities — K-02, resolved and measured

K-02 reported that the engine glyph had collapsed to one tint. It had: 4 of 5 core
glyphs and 3 of 4 provider glyphs were byte-identical (`from-accent/25 to-accent/10
text-accent`), so the field distinguished nothing.

Each engine now carries a distinct `--color-proto-*` identity:

| Engine | Identity | Computed colour |
|---|---|---|
| Xray-core | `proto-sky` | `oklch(0.828 0.111 230.318)` |
| sing-box | `proto-cyan` | `oklch(0.865 0.127 207.078)` |
| V2Ray-core | `proto-indigo` | `oklch(0.785 0.115 274.713)` |
| Hysteria2 | `proto-orange` | `oklch(0.837 0.128 66.29)` |
| WireGuard | `proto-emerald` | `oklch(0.845 0.143 164.978)` |
| OpenVPN | `proto-amber` | `oklch(0.879 0.169 91.605)` |
| Aether | `aether` | `rgb(169, 155, 224)` |
| Proxy Tunnel | neutral | `rgb(110, 217, 188)` |

Measured from `[data-engine-glyph]` elements on `/vpn`: **10 distinct computed colours
across 10 engine glyphs.** The `singbox` managed provider shares `sing-box`'s identity
deliberately — it is the same core.

## 7 K-09 — the violet collision, resolved by rule

The objection: `--color-proto-violet` and the `--color-aether` family are adjacent in
hue, so an engine tinted violet beside the Aether subsystem would be ambiguous. The
previous pass had flagged it and then widened the allowlist, which is not a resolution.

Resolved one way, as a rule:

- **Violet is reserved for the Aether subsystem.** No engine glyph uses
  `--color-proto-violet`.
- `--color-proto-violet` is **kept**, because it legitimately identifies `vmess` in the
  node list — a page on which no Aether element appears, so the two never co-occur.
- The rule is written into the `glyph` doc comments in `engineMeta.ts`, so the next
  person to add an engine sees it at the point of the decision rather than in a report.

## 8 K-03 — the `EngineBadge` single tint, recorded as a trade

The objection: unifying the palette collapsed two tints into one, losing a distinction.

Accepted, not changed. The badge's job is to **name** the engine. The glyph beside it now
carries identity (section 6). Two colour channels encoding the same fact made the row
read as two signals where there was one, and the second channel was the one that had
already degraded to a constant. With identity restored to the glyph, a single-tint badge
is the clearer composition.

## 9 `.aether-stage` — a hard-coded dark surface in both themes

`.aether-stage` paints a dark gradient regardless of theme. Text on it must therefore
stay `text-white/*` rather than following `--color-text`; using the theme token there
would produce dark-on-dark in light mode.

The audit's gradient handling is what makes this checkable: the stage's gradient stops
are composited over the resolved backdrop and the **worst stop** is used. All Aether
stage text passed at both themes.

## 10 What this audit does not cover

- **Gradient backgrounds are approximated.** Stops are parsed from the computed
  `background-image` string and each is composited over the nearest solid backdrop. An
  image or `color-mix()` backdrop that does not resolve to an `rgb()`/`rgba()` value
  would be skipped, and the element would fall back to an ancestor colour. No such case
  appeared in the 192 samples, but the mechanism is not a general solution.
- **Only rendered text is measured.** A state that is not currently on screen — an idle
  badge on a raised card, a disabled control, a hover state — is not sampled. This is
  exactly how the `--state-idle` failure in section 3 stayed hidden until the worst-pair
  listing surfaced it. Contrast of *interactive* states (hover, focus, disabled,
  `::placeholder`) is not asserted anywhere.
- **Focus rings are not measured.** WCAG 2.4.11/2.4.13 non-text contrast (3:1 for focus
  indicators) is not covered by this audit.
- **No automated gate.** The audit is run deliberately, not in CI.
- **`--color-faint` is still declared twice** (R-14). The rendered result is correct and
  AA-compliant; the duplication is a trap for the next editor, not a current defect.
