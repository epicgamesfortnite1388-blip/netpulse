# UI DESIGN 2.0 — 08 — Visual QA

**Captured:** 100 screenshots — 20 routes × 5 configurations — plus targeted
before/after sets per fix.

---

## 1. The matrix

| Configuration | Width × height | Theme | Text scale | Resolved `--type-scale` |
|---|---|---|---|---|
| `final-1440-dark` | 1440 × 900 | dark | 100 % | 1 |
| `final-1280` | 1280 × 800 | dark | 100 % | 1 |
| `final-1024` | 1024 × 768 | dark | 100 % | 1 |
| `final-scale125` | 1440 × 900 | dark | 125 % | 1.25 |
| `final-light` | 1440 × 900 | light | 100 % | 1 |

Every manifest entry records the **resolved** configuration, read back from the page
after the override was applied — so a run cannot claim a setting it did not get. This
was added after the harness was found silently capturing 100 % when asked for 125 %
(report 01 §1.1).

### 1.1 Structural results — all 100 captures

| Check | Result |
|---|---|
| Every route renders an `h1` | **100 / 100** |
| Horizontal overflow (`scrollW > clientW`) | **0 / 100** |
| Theme resolved as requested | **100 / 100** |
| Text scale resolved as requested | **100 / 100** |

The `h1` check is not decorative: it is what found Live Map's empty `h1` and Node
Detail's `h2`-only title.

### 1.2 Measured heights (`scrollH`, px)

| Route | 1440 dark | 1280 | 1024 | 125 % | light |
|---|---|---|---|---|---|
| Dashboard | 1831 | 2086 | 2298 | 2144 | 1831 |
| VPN | 2199 | 2253 | 2518 | 2535 | 2199 |
| NANI overview | 1077 | 1121 | 1137 | 1229 | 1077 |
| Copilot | 842 | 742 | 710 | 842 | 842 |
| Settings | 842 | 742 | 710 | 842 | 842 |
| Engines | 1271 | 1349 | 1571 | 1501 | 1331 |

Readings worth explaining rather than glossing:

- **842 / 742 / 710** for Copilot and Settings are `viewport − 58 px topbar`. Those
  pages fit the window, so `scrollH` is clamped to the container. It is not a
  measurement of content height.
- **Dashboard grows 1831 → 2298** as the window narrows. Expected: the two-column rows
  collapse. No clipping.
- **Engines is 60 px taller in light than dark** (1331 vs 1271) with identical data.
  The light scrollbar is wider, so content wraps once more. No clipping, no overflow;
  recorded because a 60 px difference between themes is the kind of thing that is
  either a scrollbar or a real bug, and it was checked.

---

## 2. What was inspected visually

Structural checks covered all 100. **A subset was inspected by eye**, and saying so
precisely matters:

| Capture | Inspected | Looked for |
|---|---|---|
| `final-light/01-dashboard` | Yes | Contrast of labels, values, units, hint sentences; balance of gauge vs connection panel |
| `final-scale125/10-settings` | Yes | Clipping, label/control overlap, awkward wrapping, content escaping its card |
| `final-light/20-engines` | Yes | Glyph tints, protocol chip surrounds, badge legibility |
| `final-1440-dark/20-engines` | Yes | Same, dark |
| `final-1440-dark/02-vpn` | Yes | Notice tones, adaptive-intelligence card, toggle rows |
| `evidence/ui2-after18/02-vpn` | Yes | Post-palette state |
| Remaining ~93 | **No** | — |

The uninspected captures are evidence, not reviewed findings. They exist so the next
pass can diff against them without re-running the app.

---

## 3. Visual defect registry

Defects found in QA, each with the fix that closed it.

| ID | Defect | Where | Severity | Status |
|---|---|---|---|---|
| V-01 | Two contradictory verdicts on one screen ("Degraded Good") | Dashboard | High | Fixed |
| V-02 | `DNS —as` — em dash + `ms` reads as a word | Dashboard hero | Medium | Fixed |
| V-03 | Verdict collapsed to ~40 px; session column off-screen | Connection @1024 | High | Fixed |
| V-04 | Six 24 px metrics outranked the page verdict | Dashboard | High | Fixed |
| V-05 | ~400 px dead space in the gauge card | Dashboard | Medium | Fixed |
| V-06 | Three tab languages | NANI / Nodes / Settings | Medium | Fixed |
| V-07 | ⅓ card cramped, ⅔ card two-thirds empty, same subject | NANI overview | Medium | Fixed |
| V-08 | Collapsed cards rendered bordered empty bodies | Diagnostics | Medium | Fixed |
| V-09 | Good news rendered in warning amber with a warning icon | VPN | High | Fixed |
| V-10 | Bordered box drawn inside every card | NANI hypotheses | Low | Fixed |
| V-11 | 400 px of controls in a 1050 px card | Settings | Medium | Fixed |
| V-12 | Paired fields misaligned by 20 px | Settings | Medium | Fixed |
| V-13 | Fake model message styled as a real answer | Copilot | High | Fixed |
| V-14 | "Offline" badge + "initializing" subtitle | Copilot | Medium | Fixed |
| V-15 | Composer floated mid-screen | Copilot | Medium | Fixed |
| V-16 | No `h1` | Live map | High (a11y) | Fixed |
| V-17 | No `h1`; title was `h2` | Node detail | High (a11y) | Fixed |
| V-18 | 110 raw palette utilities (84 compiled rules) | 11 files | High | Fixed |
| V-19 | WireGuard rose / OpenVPN amber = danger & warn hues | `engineMeta` | High | Fixed |
| V-20 | `bg-[#07121b]` never flips | QuickConnectActivity | High | Fixed |
| V-21 | NOC overlay: token text on hard-coded near-black | Live map | Medium | Fixed |
| V-22 | `animate-pulse` ran regardless of motion preference | 6 elements | Medium (a11y) | Fixed |
| V-23 | Per-engine hues carried no information | `EngineBadge` | Low | Fixed |
| V-24 | Harness captured 100 % when asked for 125 % | Tooling | High | Fixed |

### 3.1 Open defects — not fixed

| ID | Defect | Severity | Why open |
|---|---|---|---|
| O-01 | `--color-aether` (violet) overlaps the "violet = NANI" identity rule | Low | Resolving it means choosing between two subsystem identities — a product decision, not a UI fix. Flagged in report 02 §3.3. |
| O-02 | Settings card occupies ~768 px of a ~1138 px column | Low | Deliberate. A form that stretches to full width reads worse. Not a defect; recorded so it is not "fixed" later. |
| O-03 | Dashboard is ~2 screens tall at 1440 | Low | Content volume, not layout. Progressive disclosure is the answer (report 12, condition). |
| O-04 | 60 px height delta between themes on Engines | Informational | Scrollbar width. No clipping, no overflow. |

---

## 4. Verification that the fixes actually rendered

Each fix was re-captured after the change, not assumed:

| Fix | Evidence |
|---|---|
| Dashboard hierarchy + verdict scale | `evidence/ui2-after1`, `ui2-after2` |
| Connection panel at 1024 | `evidence/ui2-1024` |
| Tabs unified | `evidence/ui2-after3` … `ui2-after6` |
| NANI merge | `evidence/ui2-after7` |
| Empty states | `evidence/ui2-after10` |
| Settings | `evidence/ui2-after11` |
| Copilot | `evidence/ui2-after12` |
| Diagnostics | `evidence/ui2-after13` |
| Palette unification | `evidence/ui2-after18`, `ui2-after18-light` |
| Final matrix | `evidence/final-*` |

---

## 5. Text-scale stress

125 % is the hardest case, because every fixed dimension in the app is a dimension that
cannot grow.

**What survived without change:**

- The 76 px rail: labels grow, the rail does not clip.
- The 226 px context column.
- The topbar's three-zone layout.
- Settings' eight tabs stay on one line at 1440.
- Paired fields stay aligned (the `Field` anatomy fix is what makes this hold — before,
  any field with a hint shifted 20 px).

**What grows correctly:** VPN 2199 → 2535 px, NANI 1077 → 1229 px, Dashboard
1831 → 2144 px. Text got bigger and the layout absorbed it.

**No clipping or overlap found** in the inspected 125 % captures.

---

## 6. Re-evaluating the pixel-diff proposal in `UI_MASTER_12`

`UI_MASTER_12` §5 proposed a Playwright pixel-diff suite
(`maxDiffPixelRatio: 0.01`, baselines per theme, PR-only) and recorded it rather than
implemented it, because it "adds a browser engine and a binary asset store to a
repository that currently has neither".

**Re-evaluated after this pass: still not the right next investment.** The reasoning
has firmed up, not softened.

The proposal's own premise was that a pixel diff catches "an *unintended* visual change
in a state nobody thought to assert". This pass tested that premise against real
defects:

| Defect | Would a pixel diff have caught it? |
|---|---|
| `DNS —as` | Only if a baseline already showed `DNS 12ms` in that state |
| 110 raw palette utilities | **No** — they looked fine in dark theme, which is where baselines would be taken |
| WireGuard painted in the danger hue | No — it was stable and wrong |
| `animate-pulse` ignoring reduced motion | No — a static screenshot cannot see it |
| Fake Copilot message | No — it was stable and wrong |
| Missing `h1` | No |
| Verdict collapse at 1024 | Only with a baseline at exactly 1024 |
| `bg-[#07121b]` in light theme | Only with a light baseline of a panel that only mounts mid-connect |

Seven of eight are invisible to a pixel diff, and the eighth needs a baseline at the
exact width where the bug lives. Meanwhile **all eight are caught by the 54 structural
assertions** — including the four added this pass.

What a pixel diff *would* add is confidence against regressions in states nobody
asserted. That is real but it is not what was broken.

**What was done instead, and recommended:** the capture harness now produces a
machine-readable manifest per route — `h1`, `scrollH`, `scrollW/clientW`, and the
resolved theme and type scale. That is a deterministic regression signal with **zero
binary assets and zero new dependencies** (CDP over Node's built-in `WebSocket`), and
it can be diffed in CI as JSON.

The concrete recommendation, if the maintainers want to go further:

1. Commit the manifests from `final-*` as the structural baseline (JSON, ~2 KB each).
2. Fail CI when a route loses its `h1`, gains horizontal overflow, or changes
   `scrollH` by more than a set tolerance.
3. Only then consider pixel baselines — for the handful of states that genuinely have
   no structural signal, such as the dial's ring geometry.

This keeps the repository free of a binary asset store while making the class of defect
that actually occurred detectable.
