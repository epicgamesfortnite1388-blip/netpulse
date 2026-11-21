# UI_REMEDIATION_06 — Visual and Accessibility Verification

**Scope:** rendered evidence across themes, viewports, text scales, disclosure states,
and behavioural accessibility.
**Verdict:** **31 captures + 16 audit passes + 11 behavioural checks**, all green after
fixing three harness defects that had been producing mislabelled evidence.

---

## 1 The harness problem, stated first

The brief's §8 warning — *"The harness must read back the actual applied configuration.
… Abort if the requested scale did not apply"* — turned out to be the most productive
instruction in the document. Three separate silent no-ops were live in the capture path
when this mission started:

| Defect | How it manifested | Why it went unnoticed |
|---|---|---|
| R-02 theme normalisation | `--dom-theme light` set `dark`; a folder named `theme-light` held dark screenshots | The flag accepted any string; only `l` mapped to light |
| R-03 re-render revert | The app re-applied its own theme after the interaction steps | The attribute was set once, before the clicks |
| R-04 unverified detail level | Selection and read-back in one synchronous evaluation, before React committed | It *looked* like it worked — the control was visibly correct |

Each was fixed by the same principle: **set the configuration, then read it back from the
DOM, then abort if the two disagree.** A screenshot is evidence only if the harness can
prove what it captured.

A fourth defect (R-07) made the *metric* useless: `scrollHeight` clamps to the viewport on
a page shorter than the window, so Diagnostics reported 842px at every disclosure level
while visibly changing. Content height is now measured from the bottom-most child.

## 2 Captures

All at `1440×900` unless stated. Every capture reads back theme, `--type-scale`, resolved
root font, and detail level into a manifest.

| Set | Directory | Count | Purpose |
|---|---|---|---|
| Default suite | `evidence/final-default` | 20 | every route, default configuration |
| Disclosure levels | `evidence/pd-l1 … pd-l4` | 16 | 4 routes × 4 levels |
| VPN engine surfaces | `evidence/pd-aether-l1 … l4` | 4 | Aether engine at each level |
| NANI structural levels | `evidence/pd-nani-l1 … l4` | 4 | tab set per level |
| Diagnostics levels | `evidence/pd-diag-l1 … l3` | 3 | tool cards appear at Context |
| Viewport widths | `evidence/width-{1440,1280,1024,768}` | 12 | layout integrity |
| Light theme | `evidence/theme-light` | 3 | verified light, not mislabelled |
| Text scales | `evidence/scale-{1.125,1.25}` | 6 | type-scale application |

**Total: 68 rendered captures**, each with a manifest recording the applied configuration.

## 3 Viewport coverage

No horizontal overflow at any width — checked as `documentElement.scrollWidth >
clientWidth` per shot:

| Width | Overflow | Dashboard content | VPN content | Diagnostics content |
|---|---|---|---|---|
| 1440 | none | 1165px | 2041px | 702px |
| 1280 | none | 1383px | 2095px | 722px |
| 1024 | none | 1548px | 2321px | 888px |
| 768 | none | 1931px | 2273px | 938px |

Content grows as the viewport narrows, which is the expected consequence of columns
stacking. The important result is the absence of horizontal overflow at every width,
including 768 where the VPN engine rail scrolls horizontally by design.

**Honest limitation:** 768px is the narrowest width captured. A phone-width layout
(390px) was not captured, and the desktop shell is not intended for it.

## 4 Text scale

The type scale is applied through `<html data-type-scale>` with **named** steps, not a
multiplier — an earlier harness wrote the raw number, matched no selector, and produced a
run of screenshots silently captured at 100%. The harness now maps `1.125 → large`,
`1.25 → xl` and aborts if `--type-scale` does not resolve to the requested value.

| Scale | `--type-scale` read back | Dashboard content | VPN content |
|---|---|---|---|
| 1.0 | `1` | 1165px | 2041px |
| 1.125 | `1.125` | 1282px | 2197px |
| 1.25 | `1.25` | 1359px | 2358px |

Content grows monotonically with scale, and the read-back proves the scale applied rather
than being assumed.

## 5 Themes

Both themes captured and the theme read back from `<html data-theme>`:

| Theme | Shots | Recorded `theme` | Visually confirmed |
|---|---|---|---|
| Dark | 20 + levels | `dark` | yes |
| Light | 3 | `light`, `light`, `light` | yes — white surfaces, dark text |

The light-theme capture was inspected directly rather than trusted: the earlier run
recorded `dark,dark,dark` in a directory named for light, which is exactly the failure
this read-back now prevents.

Contrast in both themes is measured in `_05`: **0 failures across 192 text samples.**

## 6 Disclosure states

Verified per route in `_03` §4. Summary of what was actually seen, not specified:

- **Dashboard** — 4 levels offered; content 788 → 1165 → 1578 → 1647px; the live map
  widget is absent below Advanced.
- **VPN** — 3 levels on Overview (1436 → 2041 → 2189px), 4 on Aether (1386 → 1993 →
  1993 → 2078px). The rail stays visible at Essential, because navigation is not detail.
- **NANI** — tab count measured per level: **1 → 4 → 8 → 10**.
- **Diagnostics** — 3 levels offered; 495 → 702 → 702px. Level 3 adds no height because
  its content is a diagnostic run's per-stage timings and no run has occurred.

## 7 Unavailable states — recorded, not fabricated

The desktop backend is not running in this environment. Several states therefore cannot
be produced, and were **not** simulated:

| State | Why unavailable | What was verified instead |
|---|---|---|
| Diagnostics with a completed report | requires a real diagnostic run via the Rust core | the level-3 gate exists and registers; the page renders an honest "Monitor idle" empty state |
| NANI with a recorded investigation | requires recorded backend activity | tab set per level; the Overview tab states "No recent diagnosis recorded" |
| VPN connected | requires a tunnel and a reachable node | disconnected state at every level; the connect/disconnect actions render correctly |
| Populated cluster map | requires node data | the map route renders its own empty/loading states |
| Toast notifications | requires an event | the settings control that governs them renders |

The empty states themselves are designed and were captured — they are not blank pages.
What was **not** done is inventing data to make a screenshot look populated. The brief
was explicit that missing backend dependencies must be recorded honestly.

## 8 Accessibility — behavioural, not declarative

`scripts/ui-a11y-check.mjs` drives a real browser. A component can carry `role="radio"`
and `aria-checked` and still be unusable; the role says what it is, not that the arrow
keys work, that there is one tab stop, or that a target is big enough to hit.

**11/11 checks passed, stable across three consecutive runs.**

| Check | Result |
|---|---|
| radiogroup exposes its levels with one selected | `labels=Essential\|Context\|Advanced checkedIndex=1` |
| exactly one radio is a tab stop (roving tabindex) | `tabStops=1 of 3` |
| the selected radio accepts focus | `focused="Context"` |
| ArrowRight moves selection and keeps focus in the group | `checked 1 → 2, focused="Advanced"` |
| ArrowLeft moves selection back | `checked → 1` |
| End jumps to the last level | `checked → 2 of 3` |
| Home jumps to the first level | `checked → 0` |
| ArrowLeft at the first level wraps to the last (**APG**) | `checked → 2 of 3` |
| no interactive control shorter than 24px | 30 controls checked |
| one `h1`, a `lang`, a `main` and a `nav` landmark | `h1=["Diagnostics"] lang="en" main=true nav=true` |
| hidden disclosure levels cost nothing | Essential: level=1 nodes=276 · Expert: level=4 nodes=540 |

### Two of these checks were wrong first

**Wrapping is correct.** The original assertion was "ArrowLeft at the first level does not
wrap to the last". It failed, and the *test* was wrong: WAI-ARIA APG for a radio group
says *"if focus is on the first radio button, moves focus to the last."* The assertion now
encodes the standard, and the detail line says so.

**Fold toggles are not 20px targets.** The first target-size run flagged "MTU discovery
99×20", "CGNAT detection 113×20" and "Connection stability monitor 183×20". Those toggles
expand their hit area with an `inset-0 ::after`, so the whole header row is clickable; the
button's own box understates the real target. The measurement now uses the offset parent
when such an overlay is present, and skips a visually-hidden skip link (1×1 until
focused). 30 controls, none below 24px.

### Performance on hidden levels

`display: none` would still run animation loops and still pay for canvas compositing. The
gate **unmounts**, so the check is whether the expensive nodes exist at all:

```
Essential (level 1): nodes=276, canvases=0
Expert    (level 4): nodes=540, canvases=0
```

264 fewer DOM nodes at Essential. Zero canvases at either level on the dashboard — the
live map is gated at Advanced and is genuinely absent, not hidden.

## 9 What this verification does not establish

- **No automated visual regression.** There is no baseline image store and no pixel diff.
  These captures are evidence for a human reviewer, not a gate. A CSS change that keeps
  the contract intact and the contrast compliant could still break a layout, and nothing
  here would catch it automatically.
- **No real-device or assistive-technology testing.** Keyboard behaviour was driven
  through the DevTools protocol. No screen reader (NVDA, JAWS, VoiceOver) was used, so
  announcement quality — reading order, label association, live-region behaviour — is
  **not verified**. `aria-live="polite"` on the detail hint was not confirmed to announce.
- **No focus-ring contrast measurement.** WCAG 2.4.11/2.4.13 (3:1 non-text) is not covered.
- **No zoom/reflow test at 400%.** WCAG 1.4.10 was not exercised.
- **No reduced-motion verification.** The contract asserts the `animate-*` rule exists;
  the behaviour under `prefers-reduced-motion: reduce` was not driven in a browser.
- **No mobile viewport.** Narrowest captured width is 768px.
- **No automated gate.** All three harnesses are run deliberately.
