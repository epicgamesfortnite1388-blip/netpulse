# UI_MASTER_04 — DASHBOARD DESIGN

## 1. The question the page answers

The Dashboard answers exactly one question: **"How healthy is my connection
right now?"** Every element on the page either contributes evidence to that
answer or is removed. This is why the page has a hero verdict instead of a
gallery of widgets.

Reading order is deliberate:

1. **Verdict** — one word, one colour (`Healthy` / `Degraded` / `Critical`).
2. **Evidence** — the four numbers that support the verdict.
3. **What's broken** — `NeedsAttentionCard`, which renders nothing when nothing
   is wrong.
4. **Detail** — health gauge, connection card, metric grid.
5. **Actions** — quick diagnostics, folded by default.

---

## 2. The hero band

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◆  NETWORK COMMAND                                                 │
│     Healthy   All checks passing                    Health  92      │
│                                                     Ping    18 ms   │
│                                                     DNS     22 ms   │
│                                                     Download 84 Mbps│
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 Structural decisions

- **Container is `np-panel`, not `surface-glass`.** The previous hero used
  `surface-glass rounded-2xl`. `identity.css` overrides `surface-glass` to an
  opaque surface with `backdrop-filter: none !important`, so the glass effect
  never rendered — the class promised something the stylesheet refused to
  deliver. It also carried a 14px radius while every other card on the page used
  12px, so the hero read as a different shape family. It is now `np-panel`:
  identical surface, identical radius, identical border as the cards below.

- **The top hairline is decorative and `aria-hidden`.** A 1px `hairline-brand`
  line marks the band as the page's command surface without adding a heading or
  a border.

- **The verdict word is `text-2xl`, not `text-3xl`.** At `text-3xl` (30px) the
  verdict towered over the 20px evidence numbers and the 24px health score,
  creating a hierarchy cliff where the page appeared to have two different
  design languages. At 24px it sits at the top of one continuous ramp:
  24px verdict → 24px health → 20px metrics → 12px labels.

- **Tone is shared, not invented.** `heroStatus.tone` is one of
  `text-ok` / `text-warn` / `text-danger`, applied to both the verdict word and
  the health number. The hero can never disagree with the gauge below it because
  they read the same `health.score` and the same tone mapping.

### 2.2 Honest placeholders

Every metric falls back to an em dash (`—`), never to `0`, `--`, or a spinner:

| Metric | Source | Fallback |
|---|---|---|
| Health | `status.health.score` | `—` |
| Ping | `lastPing.avg ?? status.latencyTcpMs` | `—` |
| DNS | `bestDnsMs` | `—` |
| Download | `lastDownload` | `—` |

A dash means "not measured". It never means zero, and the page never renders a
zero that would look like a real measurement.

---

## 3. NeedsAttentionCard

Rendered **before** the health cards, and renders `null` when nothing needs
attention. This is the single most important layout decision on the page: a user
opening the dashboard with a broken tunnel sees the problem before they see the
score.

It is not a notification banner — it is a first-class card, because a broken
connection is the primary content of the page, not an interruption of it.

---

## 4. Health gauge

`<Gauge value={health.score} label={health.label} size={190} />`

- The gauge occupies `lg:col-span-1` of a 3-column grid.
- The label under the gauge is the backend's own health label, not a locally
  invented descriptor.
- The caption below is `text-xs text-faint` and explains what the score
  aggregates. A number without a definition is decoration.

### 4.1 Empty state

When `health.score == null`, the page does not render an empty gauge. It renders
a full card with:

- `CardHeader title="Health data" subtitle="No measurements yet"`
- A 32px `GaugeIcon` in `text-faint`, centred
- Explanatory prose
- A primary action to run the first test

Previously this branch rendered a bare `EmptyState` with no card header and no
icon, so it read as a rendering failure rather than a legitimate state.

---

## 5. Metric grid

Six metrics at `xl:grid-cols-6`, two at `sm`, three at `lg`. Each is a
`Metric` with a `text-2xl` value and a `text-micro` label.

**Known constraint:** at 1280px each column is ~170px. A 24px number with a
unit suffix can approach the column width on values like `999.9 Mbps`. The
`Metric` value does not truncate — it wraps the unit to a second line rather
than clipping digits, which is the correct failure mode for a measurement.

---

## 6. Quick actions

Eight destinations, folded by default:

| Label | Route | Icon |
|---|---|---|
| Live map | `/map` | `Globe` |
| Full test | `/diagnostics` | `Sparkles` |
| Speed test | `/speed-test` | `Activity` |
| DNS test | `/dns` | `Network` |
| Route test | `/routes` | `Route` |
| Iran test | `/iran` | `Flag` |
| Optimize | `/optimizer` | `Gauge` |
| Connect VPN | `/vpn` | `Shield` |

### 6.1 Fixed: duplicate icon defect

The previous array used `Zap` for six of eight entries. Eight rows with six
identical glyphs is not a list, it is a texture — the eye has nothing to
anchor on and must read every label. Each action now has a distinct glyph, so
the row is scannable by shape alone.

### 6.2 Folding

`<Card fold={{ id: 'quick-actions', defaultOpen: false, summary: '8 diagnostics, one click each' }}>`

Folded by default because the actions are not the page's answer — they are what
you do *after* reading the answer. The summary line tells you what is inside
without opening it, so folding costs nothing.

---

## 7. Update banner

A `lastCheckFail` notice renders above the cards with `border-warn/30
bg-warn/10`, a `TriangleAlert` icon, and a "View history" secondary button.

The wording comes from `updateEventLine(...)` — the **same function** the update
history card in Settings uses. Two surfaces describing the same event cannot
drift because they call one formatter.

The message is `truncate`d. An update error string can be a paragraph; the
banner is one line, and the full text lives one click away.

---

## 8. Layout rhythm

- `PageHeader` with title, one-line question, and a primary "Quick ping test"
  action.
- `DisclosureToolbar` at `-mt-3 mb-2` — tight to the header, because it is a
  modifier of the page, not a section of it.
- Hero: `mb-6`.
- `NeedsAttentionCard` (conditional).
- Update notice (conditional).
- Cards: `space-y-6` inside a `stagger` wrapper, so cards enter in sequence at
  `--dur-move` rather than all at once.

`stagger` is a one-shot entrance. It does not re-run on data refetch, so a
5-second polling interval does not re-animate the page every 5 seconds.

---

## 9. What the page refuses to do

| Refused | Why |
|---|---|
| Show a progress bar for an unknown operation | The backend reports state, not percentage. A fabricated bar is a lie with a timer. |
| Show `0 ms` when latency is unmeasured | A zero is a measurement. A dash is an absence. |
| Render the health card when there is no score | An empty gauge reads as a broken render. |
| Animate on every poll | `stagger` is entrance-only; polling updates values in place. |
| Put the quick actions above the verdict | Actions are the answer to "what do I do", which is the *second* question. |
| Use a second accent colour for a secondary action | Hierarchy is fill/outline/ghost, not hue. |

---

## 10. Acceptance criteria

| Criterion | State |
|---|---|
| Page answers "how healthy is my connection" within 1 second of scan | Pass — verdict word is the largest element in the top-left |
| Hero and gauge can never disagree | Pass — same `health.score`, same tone map |
| No fabricated values | Pass — every metric has an explicit dash fallback |
| Problem surfaces before score | Pass — `NeedsAttentionCard` precedes the gauge |
| Quick actions are distinguishable at a glance | Pass — eight distinct icons |
| Hero uses the same surface/radius as the cards | Pass — `np-panel` |
| Empty health state is a designed state | Pass — header + icon + action |
| No entrance animation on refetch | Pass — `stagger` is mount-only |
