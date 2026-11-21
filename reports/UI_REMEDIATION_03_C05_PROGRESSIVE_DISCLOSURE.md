# UI_REMEDIATION_03 — C-05: Four-Level Progressive Disclosure

**Finding:** Phase 6 was missing. A specification existed; nothing was implemented.
**Verdict:** **implemented and verified in the running application.**

The brief's warning was explicit: *"Do not claim Phase 6 is complete merely because a
specification document exists. The implementation must be visible and testable in the
actual application."* This report is therefore built from measurements of the running
app, not from the design of the system.

---

## 1 The model

Four levels, each a **ceiling on detail**, not a set of tabs:

| Level | Name | Contract |
|---|---|---|
| 1 | Essential | The current state, the result that matters, the next action |
| 2 | Context | The measurements and evidence that make the result believable |
| 3 | Advanced | Per-stage detail: probes, timings, strategy decisions, recovery |
| 4 | Expert | Raw provenance: event history, distributions, technical failures |

Content declares the *shallowest level at which it becomes relevant*. The reader picks
how deep to go. Raising the level only ever adds content — it never swaps one panel for
another, which is what makes the control predictable.

### Relationship to the existing fold system

The app already had a binary fold (`DisclosureSpec`, `CollapsibleCard`,
`DisclosureToolbar`). Rather than compete with it, the level is a second, orthogonal
axis:

- the **level** decides whether a block exists for this reader;
- the **fold** decides whether an existing block is open.

They compose: a Level-3 section the reader has folded stays folded at Level 4. This is
why the implementation does not introduce nested accordions — the brief's specific
warning. A level is not a panel; it is a filter applied above the panels that already
exist.

## 2 Where the policy lives, and why

`apps/web/src/lib/detailLevel.ts` is pure — no React, no DOM. `components/ui/DetailLevel.tsx`
binds it. The split exists so the rules can be tested without rendering, which is what
makes the 16 policy tests possible.

Rules, stated so they can be enforced:

- **Essential content is never gated.** Warnings, failures and the primary action render
  at every level.
- **Nothing is silently hidden.** When content is suppressed the control says so.
- **The choice is remembered per page only.** Expert on Diagnostics must not turn the
  Dashboard into a wall of events.
- **An unknown stored value falls back** to the page default, the same contract as the
  fold state.

### Two additions found necessary by building it

**`declares`** — a page whose disclosure *is* its navigation has no gate to mount.
NANI's level decides which tabs exist, so with only gates the provider saw zero
requirements and rendered **no control at all**: the feature was invisible on the page
that depends on it most. `declares` lets such a page state its requirements directly.
Declared levels are counted, because each one is a section the reader cannot see yet.

**`depth`** — Diagnostics gates its per-stage timings inside `running`/`report`, so on an
idle page those gates do not exist. The control silently collapsed from three options to
two, and a reader who chose Advanced during a run would find it gone on return. `depth`
states the page's real depth independently of what is on screen. It is **not** counted:
it is a capability, not a hidden section, and counting it would inflate the hint.

## 3 Where each level is applied

### Dashboard — `scope="dashboard"`, default **Context**

| Level | Content |
|---|---|
| 1 | Health gauge, `ConnectionHero` |
| 2 | `ConnectionCard`, Measurements, `HealthBreakdown`, Quick actions |
| 3 | `IranConnectivityWidget`, `LiveMapWidget`, Live latency, Insights |
| 4 | Recent activity |

The default is Context rather than Essential because the dashboard's essential content
is a single verdict line; a reader who lands there with nothing else would have no
measurements to act on. The choice is made in that page's source, not hidden in the
module.

### VPN — `scope="vpn"`, default **Context**, no declared depth

The rail is **navigation and stays at level 1**. Depth is applied inside each engine's
surface, where it describes a result rather than the way to reach one:

| Level | Overview engine | Aether engine |
|---|---|---|
| 1 | Engine list with live state, intake | Profiles |
| 2 | Administrator rights | System-wide mode (TUN) |
| 3 | How the pieces relate, glossary | — |
| 4 | — | Engine provenance |

Depth is derived from the gates rather than declared, so it is whatever the active engine
actually has. Declaring a flat 4 would make Expert a dead click on the surface most
readers land on.

### NANI — `scope="nani"`, default **Essential**, `declares` the tab levels

NANI discloses through its **navigation**: the level decides which tabs exist. This is
the opposite of four accordions inside one tab, and it is why the tab set is the right
structure here.

| Level | Tabs added | Total |
|---|---|---|
| 1 | Overview | **1** |
| 2 | Live Investigation, AI Workspace, Hypotheses | **4** |
| 3 | Recovery, Evidence, Network Intel, Settings | **8** |
| 4 | Learning, History | **10** |

Measured, not computed — `tabCount`/`tabLabels` in the capture manifest.

**Exit rule:** `activeTab` is validated against the visible set on every render, so
lowering the level while on a deep tab cannot leave an empty page — it falls back to
Overview.

### Diagnostics — `scope="diagnostics"`, default **Context**, `depth={3}`

| Level | Content |
|---|---|
| 1 | Run action, stability monitor |
| 2 | Three focused tools: bufferbloat, MTU discovery, CGNAT detection |
| 3 | Live stage log, per-step timings |

Level 3 is empty in this environment because no diagnostic has run. The gate exists and
registers; the content is honestly absent rather than fabricated.

## 4 Verified in the running application

### The control exists, is operable, and reports depth

Rendered on all four pages. From `evidence/a11y/a11y-report.json`, on `/diagnostics`:

```
labels=Essential|Context|Advanced   checkedIndex=1
tabStops=1 of 3
ArrowRight   checked 1 -> 2, focus stays in group ("Advanced")
ArrowLeft    checked -> 1
End          checked -> 2 of 3
Home         checked -> 0
ArrowLeft    checked -> 2 of 3   (wraps, per WAI-ARIA APG radio group)
```

Roving `tabIndex`, arrow keys, Home/End, wrapping, and focus retention — all verified
behaviourally, not by reading the source.

### Disclosure measurably changes the page

Content height, measured at 1440×900:

| Route | Essential | Context | Advanced | Expert |
|---|---|---|---|---|
| Dashboard | 788px | 1165px | 1578px | 1647px |
| VPN (Overview) | 1436px | 2041px | 2189px | — |
| VPN (Aether) | 1386px | 1993px | 1993px | 2078px |
| Diagnostics | 495px | 702px | 702px | — |

Monotonic where content exists, and flat where it does not. The Aether engine has
nothing between Context and Expert, so Advanced is a pass-through there; that is
reported rather than padded.

Dashboard contracted **1831px → 1213px** between the pre-Phase-6 layout and the default
Context view, and the map widget no longer mounts at the default level.

### Hidden levels cost nothing

`display: none` would still run animation loops. The gate **unmounts**:

```
Essential: canvases=0 animated=1 nodes=398
Expert:    canvases=0 animated=1 nodes=540
```

142 fewer DOM nodes at Essential, and zero canvases at either level (the map widget is
gated at 3 and genuinely absent below it).

## 5 Unit coverage

`apps/web/test/detailLevel.test.ts` — **16 tests**, 6ms. What each pins:

| Group | Property |
|---|---|
| definitions | exactly four levels; unique ids and labels; default is Essential |
| visibility | `isVisible` truth table; **monotonicity** — raising the level never removes anything |
| persistence | stored choice accepted; unknown value falls back; out-of-range clamped; keys namespaced per page |
| affordance | suppressed counts; next level with content; empty page = fully disclosed |
| offer | deepest requirement; offer trimmed to depth; never empty; always a contiguous prefix |

Mutation-tested (see `_04`): changing `isVisible` from `<=` to `<` fails 3 tests;
making `offeredLevels` return all four fails 2.

`apps/web/test/detailLevelComponent.test.tsx` — **10 tests** for the binding, added
because the policy tests could not catch a broken wiring. They cover: a gate hiding below
its level and showing at it; a gate outside a provider passing children through; the
`data-detail-level` marker; no control on a page with neither gates nor depth; a control
present from `depth` alone (the Diagnostics case); the offer trimmed to what the gates
reach; `declares` counted while `depth` is not; a stored deeper level clamped to what the
page offers; and a real click through the control revealing a gated block.

One of those tests failed first and the *test* was wrong: re-rendering the same scope
with a deeper `defaultLevel` did not move the level, because a stored choice outranks a
changed default. That is the intended behaviour, and the case now uses distinct scopes
with a comment saying why.

## 6 Design decisions a reviewer may want to challenge

**The control only offers levels the page can reach.** A four-option control on a page
whose content stops at Context puts two options in front of the reader that change
nothing when clicked, which reads as a broken control rather than a page with less to
say. Pages are allowed to be shallow; the control follows the page.

**VPN derives its depth per engine, so the control's shape changes when you switch
engine.** This was a genuine trade. A stable four-option control would put Expert on
Overview where it does nothing; a truthful three-option control shows the depth that
engine has. Truthfulness won, because a dead click is a worse failure than a control
that re-forms.

**Essential can never be a trap.** The control originally rendered only when a gate had
registered. Once `depth` existed, a page whose gates all sit at ≥2 would have hidden the
only way back up. The guard is now `requirements.length === 0 && depth === null`.

**The hint counts gates, not cards.** On Diagnostics at Essential it reads "1 more from
Context", where that one gate contains three tool cards. Counting cards would require
content to declare its own cardinality, which is more machinery than the affordance is
worth. The phrase is "1 more from Context", not "1 more thing".

## 7 What is not demonstrated

- **Populated level-3 content on Diagnostics.** Needs a completed diagnostic run, which
  needs the Rust backend. The gate is verified to exist and register; the content is not
  visually shown.
- **NANI tabs at level 3 with data.** The tabs exist and are counted; their populated
  states need recorded investigations.
- **Cross-page persistence across a full session** is unit-tested through the policy and
  uses the same `usePersistentState`/`sessionStorage` mechanism as every other UI
  preference, but was not exercised as an end-to-end browser flow beyond a single page.
