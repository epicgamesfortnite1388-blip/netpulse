# UI_MASTER_06 — EVIDENCE AND HYPOTHESIS VISUALIZATION

## 1. The core visual problem

A Bayesian diagnostic engine produces three numbers per hypothesis: a **prior**,
a **posterior**, and (implicitly) the **shift** between them. Displaying only the
posterior is the standard mistake — it tells you what the system believes but not
*how much the evidence changed its mind*. A hypothesis at 71% that started at 70%
is weak evidence; a hypothesis at 71% that started at 12% is a strong finding.

The visualization therefore encodes all three on one row, in one bar.

---

## 2. The hypothesis bar

```
┌────────────────────────────────────────────────────────────┐
│  dns_resolver_failure            72.4%   prior 18.0%        │
│  ██████████████████████████████████▌                        │
│                        ▲                                    │
│  +54.4 pp vs prior                                          │
└────────────────────────────────────────────────────────────┘
```

### 2.1 Anatomy

| Layer | Element | Encoding |
|---|---|---|
| Track | `bg-surface`, `h-2`, `rounded-full` | The 0–100% space |
| Posterior | `bg-accent`, width = `posteriorPct` | Current belief |
| Prior marker | `w-0.5 bg-text`, absolutely positioned at `priorPct` | Starting belief |
| Value | `font-mono text-text`, `toFixed(1)%` | Exact posterior |
| Prior text | `text-faint`, `prior {x}%` | Exact prior |
| Shift | `formatShift()`, `text-faint` | Signed percentage-point change |

### 2.2 Why a tick mark and not a second bar

A second bar (prior behind posterior, ghosted) is the obvious alternative and it
is worse: two overlapping fills at similar opacities produce a third,
unintended colour where they overlap, and the reader cannot tell which end of
the overlap is which. A 2px vertical tick has no ambiguity — it is a position,
not a quantity.

The tick is `bg-text` (the brightest text colour), not `bg-muted`. At `h-2` a
muted tick disappears against the accent fill on the segment it crosses. Using
the highest-contrast neutral guarantees the marker is visible whether it sits
inside or outside the posterior bar.

### 2.3 Why `pp` and not `%`

`formatShift` renders `+54.4 pp`, not `+54.4%`. A change from 18% to 72.4% is
**+54.4 percentage points**, not +54.4 percent (which would be +9.8 pp). The
unit distinction is the difference between a correct and a misleading chart, and
it is enforced in one shared helper so no call site can get it wrong.

```ts
export function formatShift(shift: number): string {
  const pp = (Number.isFinite(shift) ? shift : 0) * 100;
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)} pp`;
}
```

### 2.4 Ordering

`toRows()` sorts by posterior descending. Ranking by posterior (not by shift) is
correct: the user's question is "what is most likely", and the shift column
answers "how surprising is that" as a secondary read.

### 2.5 Non-finite guards

Every numeric path is clamped:

```ts
function pct(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(1, p)) * 100;
}
```

A `NaN` posterior from a partially-initialised engine renders as a zero-width bar
with `0.0%`, not as `NaN%` and not as a full-width bar. Bar widths are always
valid CSS percentages, so a bad value can never break layout.

---

## 3. The header statistics strip

Above the bars, one line of secondary statistics:

| Statistic | Format | Source |
|---|---|---|
| Posterior entropy | `formatNats()` → `1.284 nats` | `view.entropy_nats` |
| MAP | label text in mono | `view.map_label` |
| Calibrated confidence | `toFixed(1)%` + provenance note | `calibrationDisplay()` |
| Legend | `bar = posterior · ▏= prior` | static |

### 3.1 Entropy

Entropy is the honest measure of *how undecided* the engine is. Three decimals
(`formatNats` → `toFixed(3)`) because information gains in this domain are small
(0–3 nats) and two decimals would collapse distinct values into the same string.
When the value is not finite it renders `unavailable`, never `0.000 nats` — zero
entropy means absolute certainty, which is the opposite of "no data".

### 3.2 Calibrated vs raw confidence

`calibrationDisplay()` is the most carefully written function in this area. It
does not decide *when* calibration is trustworthy — the Rust engine decides that
and sends a non-null `map_confidence_calibrated` only when a fitted isotonic map
is reliable. The helper treats non-null as the activation flag and never
re-derives the threshold in the frontend.

The label changes accordingly:

- Fitted map present → **"Calibrated confidence"** with note *"calibrated on N
  recorded probe outcomes"*
- No fitted map → **"Confidence"** with note *"raw posterior, N probe outcomes
  recorded"*

A user can always see whether the headline number is calibrated or raw, and on
how many samples. A confidence without provenance is a number pretending to be a
probability.

### 3.3 Legend

`bar = posterior · ▏= prior` is rendered as literal text next to a 2px swatch.
There is no hover-only legend, no tooltip-only explanation. The chart explains
itself in the same visual weight as the numbers it annotates.

---

## 4. Selected probe card

Below the hypothesis list, the engine's next-best test:

| Field | Format |
|---|---|
| Test name | `Badge tone="neutral"` |
| Expected information gain | `formatNats()` |
| Cost | `toFixed(1)` |

When there is no candidate test, the card says *"The engine has no candidate
test to rank yet."* — a sentence about the engine's state, not an empty box.

This is what makes the feature an *investigation* tool rather than a dashboard:
it shows not only what the system believes but what it would do next to become
more certain.

---

## 5. Evidence explorer

The Evidence tab is the ground truth behind the bars.

### 5.1 Structure

- `CardHeader title="Evidence explorer" subtitle="Actual observations and classifications"`
- A filter input with a leading `Search` icon
- A list of evidence cards

### 5.2 Evidence card anatomy

```
┌──────────────────────────────────────────────┐
│  ev-12                        [ApiHealthChanged] │
│  DNS probe to 1.1.1.1 timed out after 2000 ms    │
│  14:32:07                                        │
└──────────────────────────────────────────────┘
```

| Element | Encoding | Why |
|---|---|---|
| `ev-{id}` | `font-mono text-xs text-accent` | Stable identifier, accent-coloured so it is findable when cross-referencing an event log |
| Type | `Badge tone="neutral"` | The classifier's label, not the UI's |
| Detail | `text-text`, prose | What was actually observed |
| Timestamp | `text-xs text-faint` | Recency, secondary |

The ID is in the accent colour and the type is a neutral badge — deliberately
inverted from the usual "identifier muted, label bright" pattern. The ID is what
you copy into a bug report; the type is what the machine already grouped by.

### 5.3 Filter behaviour

The filter matches against both `type` and `detail`, case-insensitively. A user
who remembers "DNS" can find the evidence without knowing whether it was
classified as `ApiHealthChanged` or `HealthCheckFailed`.

### 5.4 Empty state

`EmptyState` with a `Database` icon, title "No evidence yet", and the sentence
*"Evidence appears when NANI records health checks or classified failures."*
The message names the two producers of evidence, so the user knows what action
would populate the tab.

### 5.5 Timestamp honesty

`e.at ? new Date(e.at).toLocaleTimeString() : 'time not reported'`

An event without a timestamp says so. It does not render `Invalid Date`, and it
does not render the current time.

---

## 6. Health-check result parsing

`parseHealthCheckResult()` reads the engine's own result string
(`health_check_complete: 0/1 healthy`) with a regex, and falls back to counting
checks when the string carries no aggregate verdict:

```ts
const match = raw.match(/(\d+)\s*\/\s*(\d+)\s+healthy/i);
```

The comment above the function states the constraint plainly: the web path runs
one check per registered API and reports no aggregate verdict, so the count of
checks is used rather than claiming a health value nobody measured. The `raw`
string is retained on the returned object so a detail view can show the original
text.

---

## 7. Colour discipline in this area

| Meaning | Colour | Never |
|---|---|---|
| Posterior (belief) | `--color-accent` | Never green — accent is "this is the model's answer", not "this is good" |
| Prior (reference) | `--color-text` | Never accent — it is a reference mark, not data |
| Positive shift | `--color-faint` text, signed `+` | Not green — a large positive shift is not inherently good news |
| Evidence ID | `--color-accent` | — |
| Classifier type | neutral badge | Not a semantic colour — the classifier is not a verdict |

The decision not to colour positive shifts green is deliberate. A hypothesis
jumping from 12% to 72% means the evidence strongly supports *a failure mode*.
Green would be a lie about the meaning.

---

## 8. Fixed defects

| # | Defect | Fix |
|---|---|---|
| V-1 | Confidence displayed as integer percent | `toFixed(1)` on posterior and prior |
| V-2 | Shift could render as `NaN pp` on a missing prior | `Number.isFinite` guard in `formatShift` |
| V-3 | Entropy rendered `0.000 nats` when unavailable | `formatNats` returns `unavailable` |
| V-4 | Bar widths could exceed 100% on a bad posterior | `pct()` clamps to 0–1 |
| V-5 | Prior marker invisible when overlapping the accent fill | Marker is `bg-text`, the highest-contrast neutral |
| V-6 | Calibration provenance hidden | Note string always rendered next to the number |

---

## 9. Acceptance criteria

| Criterion | State |
|---|---|
| Posterior, prior and shift all visible on one row | Pass |
| Shift unit is percentage points, not percent | Pass — `formatShift` |
| Bars clamp to valid widths on any input | Pass — `pct()` |
| Calibrated vs raw confidence is always labelled | Pass — `calibrationDisplay` |
| Sample count shown with every confidence | Pass |
| Entropy never claims certainty when unavailable | Pass — `unavailable` |
| Evidence filter matches both type and text | Pass |
| Missing timestamp says so | Pass — `time not reported` |
| Colour never implies "good" for a strong failure belief | Pass — accent, not ok |
