# UI DESIGN 2.0 — 11 — Kim, Independent Review

**Reviewer:** Kim — independent code review
**Stance:** the brief asked me to challenge, not to approve. This review contains
objections. Some were resolved during the review; the rest are recorded as conditions.
**Inputs:** the working tree, the 100-capture matrix, all seven gates, and reports 01–10.

---

## 1. What genuinely improved

Stated first so the objections that follow are read in proportion.

1. **The palette work is correct and it was not cosmetic.** I verified the claim
   independently: `text-violet-200` on white is **1.39:1**. That label was invisible.
   Routing 110 utilities through tokens fixed a real accessibility failure, and the
   contract now rejects the whole class of regression.
2. **The connection panel fix is right.** Sizing a component by the viewport when it is
   sized by its column was a genuine architectural error, and container queries are the
   correct tool.
3. **The `censorshipHint` DTO correction is the best change in the set.** It fixed a
   type that made a branch unreachable, and the styling bug was a *symptom*. Finding the
   cause rather than recolouring the symptom is the right instinct.
4. **Deleting NANI's hand-rolled keyboard handler** removed duplicated APG logic. Net
   −137 lines in that file while adding a card merge.
5. **Nothing was staged or committed.** The preservation rules were followed, and I
   checked `git diff --cached --name-only` myself — empty.

---

## 2. Objections

Severity: **A** = must fix before merge · **B** = should fix · **C** = judgement call.

### K-01 (A) — Three of the new assertions did not assert what they claimed

This is my strongest objection, because the brief's §9 says the goal is "to make future
design regressions detectable". An assertion that cannot fail is worse than no
assertion: it manufactures confidence.

I tested them adversarially rather than reading them. Results before fixes:

| Assertion | Claim | Actual behaviour |
|---|---|---|
| `assertNoHardcodedSurface` | rejects `text-[#f87171]` | **Did not match.** Escaping was wrong: the pattern expected `\\\[` where minified CSS emits `\[`. `text-[#f87171]` and `border-[oklch(…)]` passed. |
| `assertContainerQueries` | panels size to their column | **Passed on a single `container-type` anywhere.** One container query in the codebase satisfied it while the next panel could still collapse. |
| `assertThemeParity` | tokens have light overrides | **Weaker than stated** — it counted distinct declared values, so two identical `:root` declarations satisfied it while light theme inherited the dark value. |
| `assertEveryRouteHasHeading` | every route declares an h1 | **Gameable** — a file merely *mentioning* `pageTitle` in a comment passed. |

**Resolution:** all four were rewritten during this review.

- Escaping fixed by matching against a backslash-stripped copy of the CSS.
- The container assertion now checks the specific surface that broke
  (`ConnectionHero.tsx` must declare `@container` **and** must not reintroduce
  `lg:grid-cols-[236px`).
- Theme parity now reads the light block itself and requires each token inside it.
- The `h1` check strips comments, and additionally rejects a route that declares its
  title twice (`pageTitle` + `PageHeader`).

**And the fix is proven, not asserted.** `scripts/verify-contract-assertions.mjs` applies
nine mutations to the real stylesheet and requires each to be rejected:

```
✓ clean baseline passes
✓ raw palette utility is rejected
✓ hard-coded hex text colour is rejected
✓ hard-coded oklch border is rejected
✓ a token missing from the light block is rejected
✓ warn colliding with ok is rejected
✓ removing the animation-family rule is rejected
✓ a fixed-px font size is rejected
✓ a missing primitive class is rejected
✓ contract assertions verified — 9/9 mutants rejected correctly
```

Two of those nine cases initially failed because **my mutations were wrong, not the
assertions** — a reminder that a negative test has to be as carefully constructed as the
assertion it tests.

### K-02 (B) — Collapsing the engine glyphs may be a regression in a task nobody studied

The designer removed six per-engine hues, arguing the label already names the runtime.
That is true for a single card. It is not obviously true for the **engines page**, whose
job is to let someone scan eight engines and see which are installed, which are
third-party, and which is the app's own.

`PROXY_CORE_META.glyph` is now identical for six entries. If the field no longer
distinguishes anything, the field should be **deleted** rather than left as a
per-engine property that always holds the same value — otherwise the next developer
will assume it means something.

**Not resolved.** Either delete the field or restore a meaningful distinction. Recorded
as condition C-01.

### K-03 (B) — `EngineBadge` loses a scanning cue

Same argument at smaller scale. In a table of measurements the badge's tint was the only
at-a-glance way to group rows by core. The label still distinguishes them, but scanning
20 rows for "which came from hysteria" is now a reading task rather than a glance.

The designer's rationale (the hues had no light-theme counterpart, so the tint vanished
anyway) is sound *for light theme*. The conclusion — one tint everywhere — throws away
the dark-theme affordance too.

**Not resolved.** Acceptable as-is, but it is a trade, not a pure win, and it should be
recorded as one. Condition C-02.

### K-04 (C) — `[class*='animate-']` is a blunt selector with `!important`

It works, and the self-test proves it is present. But:

- It matches any class *containing* `animate-`, including a future `non-animate-fade`.
- It applies `animation: none !important` to everything, including one-shot entrance
  animations that a reduced-motion user might tolerate (the guidance is to reduce, not
  necessarily eliminate).
- `!important` on a broad attribute selector is the kind of rule that is hard to reason
  about later.

A narrower design would be a custom property (`--motion: 1`) that utilities multiply
into their durations. **Accepted as-is** — the pragmatic fix is correct for a WebView app
with 40 call sites, and the alternative is a larger refactor than this pass should
carry. Recorded so the trade is visible.

### K-05 (C) — `pageTitle` creates a second way to render an `h1`

Previously the invariant was "only `PageHeader` renders `h1`". Now `EngineHero` can too.
That is a real widening of the contract, and it is exactly how two `h1`s appear on one
page later.

**Partially resolved:** the contract now rejects a route that uses both `pageTitle` and
`PageHeader`, and two component tests pin `EngineHero`'s default to `h2`. The invariant
is now enforced rather than implied — but it is a weaker invariant than before.

### K-06 (B) — The report set overstates iteration coverage

The brief asked for **three iteration cycles**, each with screenshots, findings,
improvements, test results and a Kim review. What happened is closer to **one substantial
iteration plus a palette pass plus a verification pass**. Reports 04–08 present this
coherently but do not map onto three cycles, and no report claims they do — which I
checked.

**Not resolved.** It is a scope fact, not a defect to fix by relabelling. Recorded as
condition C-03.

### K-07 (A) — Phase 6 (progressive disclosure) was not implemented

The brief's §8 asks for information density and progressive disclosure across **four
levels**. The codebase has `fold` / `DisclosureScope`, and this pass *used* it, but there
is no deliverable that defines the four levels, no screen restructured to introduce a new
level, and no measurement of density before/after.

This is a required phase with no output. It is the largest genuine gap in the delivery.

**Not resolved.** Condition C-05. It should not be quietly absorbed into "future work".

### K-08 (C) — `unify-palette.mjs` is now dead code in the repository

A one-shot transformation script that is idempotent and does nothing. It documents how
110 replacements were made, which has some archaeological value, but it hard-codes file
paths that will drift and will confuse anyone who runs it later.

**Not resolved.** Either delete it (the git history holds the transformation) or move it
under `scripts/oneoff/`. Condition C-06.

### K-09 (C) — The aether/violet overlap was flagged and then expanded

Report 02 admits violet is documented as NANI's hue and that `--color-aether` is violet.
The designer flagged this as a pre-existing overlap it did not resolve — and then *added*
two new uses of `--color-aether` for the VPN planner stage tones (`POLICY`, `DECISION`).

Flagging a semantic collision while widening it is inconsistent. Either the Aether
subsystem owns violet (and the identity doc should say so) or it does not (and those
tones should use a different family).

**Not resolved.** Condition C-07.

### K-10 (C) — Claims in the reports that outrun the evidence

Three specific instances I checked:

1. "The 76 px rail survives 125 % text without clipping" — this was verified by
   inspecting **one** 125 % capture (Settings). The rail itself was not probed for
   clipping at 125 %.
2. "No clipping or overlap found in the inspected 125 % captures" — accurate, because it
   says "inspected", and only one was inspected. Fine, but the preceding sentence in the
   same report is broader than the evidence.
3. Report 09's accessibility summary says contrast is "Pass (13/13 light, 8/8 dark)" —
   the ratios were computed from token values, not sampled from rendered pixels. That is
   a legitimate method, but it does not cover text over gradients or tinted wells, and
   the summary reads as broader than it is.

**Not resolved**, but the reports were written to be checkable — report 08 §2 states
plainly which 7 of 100 captures were inspected and that the other 93 were not. That is
the right instinct; the remaining issue is a few sentences that should carry the same
qualifier.

---

## 3. Things I tried to break and could not

Recording these because a review that only lists objections is not calibrated.

- **Overflow at every width.** I checked all 100 manifests: zero horizontal overflow at
  1024, 1280, 1440, at 125 % text, and in light theme.
- **Missing headings.** 100 / 100 captures have a non-empty `h1`.
- **Theme/scale application.** Every manifest entry records the resolved values; all 100
  match what was requested. The earlier harness bug (silently capturing 100 % when asked
  for 125 %) is fixed and now self-verifies.
- **The claim that no test was weakened.** I diffed the test files. `designPrimitives`
  is additive; no existing assertion threshold was changed.
- **Staging.** `git diff --cached --name-only` is empty. No commit was created.
- **Backend isolation.** `git status` shows no `src-tauri/**` modification from this
  pass. NANI maths, VPN networking and API contracts are untouched.

---

## 4. Verdict

**PASS WITH CONDITIONS.**

The work is a real improvement and the two most important fixes (the palette/contrast
failure and the connection panel architecture) are correct, evidence-backed, and now
regression-guarded by assertions I have personally tried to break.

But it is not a clean pass:

- One required phase (Phase 6, progressive disclosure) has **no output at all** — K-07.
- The three-cycle iteration structure was not delivered as specified — K-06.
- Two design decisions (engine glyphs, engine badge) trade a dark-theme affordance for
  calm without measuring the cost — K-02, K-03.
- A semantic overlap was flagged and then widened — K-09.

### Conditions

| ID | Condition | Blocking? |
|---|---|---|
| C-01 | Delete `PROXY_CORE_META.glyph` / `MANAGED_PROVIDER_META.glyph`, or restore a distinction that means something | No |
| C-02 | Record the `EngineBadge` single-tint trade as a trade, not a win | No |
| C-03 | State plainly that iteration cycles 1–3 were not run as three cycles | No |
| C-04 | Fix or quarantine the wall-clock assertions in `mapClusterPerf.test.ts` (3 tests; the source of every observed flake) | **Yes** |
| C-05 | Implement Phase 6 progressive disclosure, or descope it explicitly with the maintainers | **Yes** |
| C-06 | Delete or relocate `unify-palette.mjs` | No |
| C-07 | Resolve the violet/NANI/Aether collision one way or the other | No |

C-04 and C-05 are the two I would not merge without. Everything else is a documented
judgement call that a maintainer can accept.

---

## 5. Resolution log

| Finding | Status |
|---|---|
| K-01 — assertions did not assert | **Fixed** — four rewritten, 9/9 mutation test |
| K-05 — second h1 path | **Partially fixed** — contract rejects double declaration |
| K-04 — blunt motion selector | **Accepted**, trade recorded |
| K-02, K-03, K-06, K-07, K-08, K-09, K-10 | **Open** — conditions C-01…C-07 |

I would sign this off as an improvement to the product and a correct diagnosis of what
was wrong. I would not sign it off as complete.
