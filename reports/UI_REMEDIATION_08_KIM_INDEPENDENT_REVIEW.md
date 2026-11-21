# UI_REMEDIATION_08 — Kim: Independent Final Review

**Reviewer:** Kim (independent)
**Method:** read the source, ran the tests, drove the running application. Not the
author's account of any of it.
**Verdict:** **APPROVED WITH CONDITIONS**

---

## 0 What this review is not

I was asked not to review Will's explanation or the designer's screenshots. So nothing
below is accepted because a report says so. Every claim I accept, I re-derived: I read the
symbol, ran the command, or measured the rendered DOM. Where I could not re-derive
something, I say so and it does not count as verified.

I also went looking for what the reports do not mention. Section 6 is the result of that,
and it contains the finding I consider most significant in this review.

## 1 The two blockers

### C-04 — performance test reliability: **RESOLVED**

I reproduced the original defect. `apps/web/test/mapClusterPerf.test.ts` as it stood
asserted `<100ms`, `<25ms`, `<10ms` around a single `performance.now()` call. Under a
concurrent build the suite failed on correct code — I saw the 532-with-one-failure reading
myself during this session, and the JSON reporter confirmed all files were collected, so
the failure was real and the "missing file" story was wrong.

Two things the reports claim that I verified independently:

**The budgets were 80–90× too loose.** Running the new benchmark:
`far-5000 median 1.138ms` against a 100ms budget; `mid-1000 median 0.3118ms` against
25ms. Confirmed.

**Two of the three tests measured a passthrough.** I read `clusterCellDeg`:
`if (z >= 2.2) return 0.5;` and `clusterNodes`: `if (cell <= 1.2) return nodes;`. At zoom
2.5 and zoom 6 the function returns before touching a node. The "mid zoom" and "close
zoom" assertions therefore timed an early return. **This is a more serious finding than
the flakiness**, and the reports do state it.

**The replacement has teeth.** I injected the two defects myself rather than trusting the
recorded numbers:

- linear scan over the bin Map → `expected 340.05 to be less than 40` (per-node work);
- nested loop over nodes → `expected 2013.54 to be less than 40`, growth `3.96` against a
  `2.6` bound.

Both rejected. I then restored the source and confirmed with `git diff --quiet` that
`clusterNodes.ts` was byte-identical. The deterministic test is 6 cases in 15ms with no
wall clock in it. The performance measurement is retained, opt-in, and reports as
`4 skipped` on a default run — visible, not silent.

**I checked the counter for the failure mode the author admits to.** The first version
counted only node property reads and passed against the bin-scan defect. I confirmed the
shipped version also wraps `Map.prototype[Symbol.iterator]`, and that the injected defect
is caught. The admission in `_02` §5 is accurate.

**Load behaviour.** Idle: 563 passed, 0 failed. With a concurrent `vite build` and a
headless capture: 563 passed, 0 failed. Build wall time 15.66s under load vs 7.32s idle,
so the contention was real. **C-04 is resolved.**

### C-05 — four-level progressive disclosure: **IMPLEMENTED AND VERIFIED, WITH A SCOPE CAVEAT**

I did not take the specification as evidence. I drove the app:

- NANI: measured tab count per level from the DOM — **1, 4, 8, 10**. The tab set really is
  the disclosure mechanism, and the tabs really do appear.
- Dashboard: content height **788 → 1165 → 1578 → 1647px**. Monotonic.
- VPN: rail present at Essential (1436px), not gated away. I specifically checked this
  because the earlier state was 208px with no connect surface, which would have been a
  worse defect than the one being fixed.
- Diagnostics: three options offered, `depth={3}` working; I confirmed by removing the
  hypothesis and checking that `depth` alone makes the control render.

The control is keyboard-complete. I drove it: roving `tabIndex` (1 of 3), ArrowRight/Left,
Home/End, focus retention, and wrapping. The wrapping is correct per WAI-ARIA APG for a
radio group — I checked the spec text, because the author's first assertion claimed the
opposite and had to be corrected.

The gates unmount rather than hide: at Essential the dashboard mounts 276 nodes, at Expert
540. No canvases at either level. **The brief's "avoid expensive effects on hidden
disclosure levels" is satisfied in the strongest available form.**

**The caveat, which I consider material — see section 6.**

## 2 The ten objections

| # | Status I assign | Basis |
|---|---|---|
| K-01 assertions that did not assert | **Resolved** | reproduced the defect; verified the replacement rejects two injected defects; verified two original assertions were vacuous |
| K-02 glyph lost its cue | **Resolved** | measured 10 distinct computed colours across 10 engine glyphs from `[data-engine-glyph]`; previously 4 of 5 identical |
| K-03 `EngineBadge` single tint | **Accepted, and I agree** | identity now lives in the glyph; a second colour channel encoding the same fact was redundant. The trade is recorded, not hidden |
| K-04 blunt `animate-*` selector | **Accepted** | deliberately blunt so a new animation cannot escape reduced-motion. The contract asserts the rule exists and the mutation suite proves that assertion bites |
| K-05 second `h1` path | **Resolved** | measured: `/diagnostics` renders exactly one `h1`, plus `lang`, `main`, `nav`. Every captured route shows one `h1` |
| K-06 three cycles not run | **Not resolved — and cannot be** | the author states plainly that three cycles were not run. I verified this is what the reports say rather than a softer claim. This is an honest failure, not a covered one |
| K-07 Phase 6 missing | **Resolved on 4 routes; not app-wide** | see section 6 |
| K-08 `unify-palette.mjs` dead | **Resolved** | relocated to `scripts/oneoff/`; no longer in the general scripts directory |
| K-09 violet collision | **Resolved by rule** | no engine glyph uses `proto-violet`; violet is reserved for the Aether subsystem; `proto-violet` retained for `vmess`, which cannot co-occur with an Aether element. The rule is in the source at the point of decision |
| K-10 claims outrunning evidence | **Resolved as a practice; the original claim was false** | "ESLint 0" does not hold — ESLint exits 1 with 3 errors. The reports now say so. I verified the 3 errors are confined to two files this mission did not touch |

I disagree with nothing above on the facts. My disagreement is with **completeness**, in
section 6.

## 3 What I independently confirmed, with numbers

| Claim | My check | Result |
|---|---|---|
| typecheck clean | `npx tsc --noEmit` | exit 0 |
| tests pass | `npx vitest run` | 58 files passed, 1 skipped; **563 passed, 4 skipped, 0 failed** |
| same under load | concurrent build + capture | **identical** |
| contract intact | `node scripts/assert-ui-contract.mjs` | **55/55**, exit 0 |
| mutants rejected | `node scripts/verify-contract-assertions.mjs` | **9/9**, exit 0 |
| no raw palette utilities | DOM class scan, 16 route×theme | **0** |
| no contrast failures | computed fg/bg, 192 samples | **0**; worst 5.22:1 dark, 4.56:1 light |
| accessibility | 11 behavioural checks, 3 runs | **11/11 stable** |
| ESLint | `npx eslint src test` | **exit 1, 3 errors** |

I re-ran the colour audit and the accessibility script myself rather than reading their
JSON. Both reproduce.

**On the contrast fix**, I verified the mechanism rather than the number: `--color-faint`
was `#718783`, which measures 4.21:1 on `#162328` and 3.72:1 on `#1d2d33`. It is now
`#839793`, 5.22:1 and 4.62:1. I also confirmed the author found a second instance the
failure list had not shown — `--state-idle` and `--state-unknown` held the same hex and
carried the same latent failure on raised surfaces. That is a real find, and fixing it was
correct: those tokens are only *rendered* on dark surfaces today, so the pass was
accidental.

## 4 Harness integrity

I care about this more than the screenshots, because mislabelled evidence is worse than no
evidence. Three silent no-ops were live at the start of this mission and I confirmed each
was real:

1. `--dom-theme light` set `dark`. The normaliser only mapped `l`. A folder named
   `theme-light` contained dark screenshots. **Verified** in
   `evidence/theme-light/manifest.json` from the earlier run: `dark,dark,dark`.
2. The app re-applied its own theme after the interaction steps, reverting the injected
   value.
3. Detail-level selection and read-back happened in one synchronous evaluation, before
   React committed.

All three now abort on mismatch. I tested the guard by requesting a level a page does not
offer (`--detail 4` on Diagnostics) and confirmed the run exits 1 with the resolved level
in the message rather than writing a screenshot.

A fourth defect made the *metric* useless: `scrollHeight` clamps to the viewport, so
Diagnostics reported 842px at every level while visibly changing. The `content=` figure
now differs per level. I confirmed this by comparing the numbers across levels.

**I did not find a remaining way to produce a mislabelled capture.** I tried: requesting a
theme, a scale and a level simultaneously; requesting a tab that the level does not
expose; requesting a tab on a route with no tabs. Each either succeeds with a matching
read-back or aborts.

## 5 Test quality

The policy tests are good: 16 cases pinning monotonicity, storage validation, clamping,
and the offer's contiguity. I mutated the policy myself — `isVisible` from `<=` to `<`
fails 3 tests; `offeredLevels` returning all four fails 2. Restored and confirmed green.

**The component layer had no tests at all when I first looked.** `grep -rl "DetailGate" apps/web/test/`
returned nothing. The binding — `declares`/`depth` merging, gate unmount, the control's
existence guard, the clamp — was verified only end-to-end in a browser on four pages. That
is real evidence for those four pages and nothing for the other twenty-three.

Ten component tests now exist and I ran them: 10/10. They cover the Diagnostics `depth`
case, `declares` counted while `depth` is not, the clamp, and a real click revealing a
gated block. I checked one of them was written wrong first — re-rendering the same scope
with a deeper `defaultLevel` did not move the level, because a stored choice outranks a
changed default. That is correct behaviour and the test now says so.

## 6 The finding I consider most significant

**Phase 6 is applied to 4 of 27 routes.**

I counted: `DetailLevelProvider` appears in `DashboardPage`, `VpnPage`, `NaniPage` and
`DiagnosticsPage`. The router defines 27 paths, including `account`, `nodes`,
`nodes/:id`, `engines`, `settings`, `map`, `speed-test`, `dns`, `iran`, `mission`,
`events`, `copilot`, `history`, `servers`, `optimizer`, `overdrive`, `routes`, `ip`,
`gaming`, `cloudflare`, `health`, `nodes-sources`, `cloudflare`.

The remaining 23 routes still use only the binary fold.

The reports present C-05 as "implemented and verified". On the four routes, that is true
and I have confirmed it. As a **system** — which is what §4 of the brief describes — it is
applied to 15% of the application. A reader who opens Mission Control, the DNS lab or the
Engine Manager gets no level control, and nothing tells them the concept exists.

This is not dishonesty: `_09` states the coverage. But "C-05 implemented" without the
scope figure in the same sentence would let a reader conclude the whole app has it, and I
will not approve on that basis.

I am not treating this as a defect in what was built. The four chosen routes are the
dense ones, where disclosure pays. The brief explicitly warned against forcing every page
into the same layout. But "the dense routes have it" and "the app has it" are different
claims, and only the first is true.

## 7 Conditions of approval

I approve the work on the four routes, and I attach five conditions.

**C1 — Publish the scope figure wherever C-05 is described.** Any statement that Phase 6
is implemented must carry "on 4 of 27 routes, the four densest" in the same sentence, and
name the 23 that do not. `_09` does this; any future summary must too.

**C2 — Decide, in writing, whether the remaining routes get a level control or an explicit
opt-out.** Either is defensible. Silence is not, because it leaves a reader unable to tell
a deliberate omission from an unfinished one. This is a product decision, not a code
change, and it should not be closed by adding `DetailLevelProvider` to 23 pages without
deciding what belongs at each level on each of them.

**C3 — Reconcile ESLint or stop claiming a clean lint.** `npx eslint src test` exits 1
with 3 errors in `cloudFeedbackOwnership.test.ts` and `cloudSyncCompletion.test.ts`. The
mission correctly declined to edit out-of-scope files to make a number true. The
consequence is that no report may say "ESLint 0" until a separate, in-scope change makes
it so.

**C4 — State that K-06 was not met.** Three iteration cycles were not run. This cannot be
retrospectively satisfied. It must appear in the handoff as an unmet process requirement,
not folded into a general "limitations" list.

**C5 — Before any claim of visual regression safety, wire a gate.** There is no baseline
image store and no pixel diff. 68 captures exist as human evidence; none of them is a
test. A CSS change that keeps the contract intact and the contrast compliant can break a
layout and nothing will fail. This is acceptable *now* because the mission says so
plainly; it is not acceptable as a standing assurance.

## 8 What I could not verify

Listed because an approval that hides its own blind spots is worth less than one that
does not.

- **No screen reader was used.** Keyboard behaviour was driven through DevTools. Reading
  order, label association, and whether the `aria-live="polite"` hint on the detail
  control actually announces are **unverified**. I consider this the largest untested
  area, given that the feature's whole purpose is to communicate "there is more here".
- **No populated states.** The backend is not running. Diagnostics has no completed
  report, NANI has no recorded investigation, VPN is disconnected, the map has no nodes.
  The gates that reveal that content are verified to exist; the content is not. I checked
  that the reports say this rather than implying the states were seen — they do.
- **No interactive-state contrast.** Hover, focus, disabled and `::placeholder` colours
  are not measured. The audit samples rendered text only.
- **No zoom/reflow test at 400%**, no mobile viewport below 768px, no reduced-motion
  drive.
- **Provenance of the five commits.** HEAD moved from `6dd3929a` to `354034747` during the
  mission, via commits whose messages describe this work. No git hook exists. I cannot
  attribute them. The mission states it did not commit, and I found no evidence it did;
  I also cannot prove what an external process did. This is a fact about the repository a
  reader must weigh, not something I can resolve.

## 9 Verdict

**APPROVED WITH CONDITIONS.**

C-04 is resolved: I reproduced the failure, verified the replacement catches the defect
class, and confirmed the suite is now stable under load. C-05 is implemented and works on
the four routes I drove — the model is sound, the control is keyboard-complete, hidden
levels cost nothing, and the implementation is visible in the running app rather than
asserted in a document.

I withhold unconditional approval for one reason: the system covers 15% of the
application, and the reports would read as though it covers the application unless the
scope figure travels with the claim. The five conditions are about making that limitation
travel with the claim, not about redoing the work.

The engineering I reviewed is careful and, in two places, unusually honest: the
performance test was split rather than loosened, and the reports record a failed process
requirement and a false lint claim instead of quietly dropping them. That is the standard
I would want on my own team.

---

## 10 Independent revalidation (2026-11-20T22:12Z)

A second independent pass re-ran every gate against the delivered working tree.

**Gates re-verified:**

| Gate | Exit | Result | Disposition |
|---|---|---|---|
| `npx tsc --noEmit` | 0 | clean | confirmed |
| `npx vitest run` | 0 | 563 passed, 4 skipped, 0 failed | confirmed |
| `node scripts/assert-ui-contract.mjs` | 0 | 55/55 | confirmed |
| `node scripts/verify-contract-assertions.mjs` | 0 | 9/9 mutants rejected | confirmed |
| `npx vite build` | 0 | built in 7.75s | confirmed |
| `npx eslint src test --max-warnings=0` | 1 | 3 errors (pre-existing) | confirmed after fixing a mission-introduced unused import in `detailLevelComponent.test.tsx` |
| `node scripts/ui-colour-audit.mjs` (live server) | 0 | 0 contrast failures, 0 raw palette, 10 distinct engine colours | confirmed — initial run against a dead server produced 32 false failures from Chrome's own error page |
| `node scripts/ui-a11y-check.mjs` (live server) | 0 | 11/11 | confirmed after fixing the cost check to handle the dashboard's error state |
| `NP_PERF=1 npx vitest run test/mapClusterPerf.test.ts` | 0 | 4/4, median 0.99ms | confirmed |

**Three corrections were made during revalidation:**

1. **`detailLevelComponent.test.tsx`** — an unused `import type { DetailLevel }` produced
   a fourth ESLint error. Removed because this is a mission-introduced file. ESLint is now
   3 errors in two pre-existing files, matching the report.

2. **`scripts/ui-a11y-check.mjs`** — the cost check hardcoded level 1 vs level 4, but the
   dashboard only offers 2 levels when the backend is unreachable (gates at 3 and 4 are
   inside `statusQuery.data?.health`). Updated to compare the shallowest and deepest levels
   the page actually offers, and to skip cleanly when no control renders.

3. **Colour audit methodology** — the audit must be run against a live dev server. Running
   it against a dead server produces false failures from Chrome's own connection-refused
   page (`.suggestion-body` at 3.6:1, "127.0.0.1" at 2.38:1). This is not a defect in the
   audit script or the application; it is an operational requirement that must be stated.

**Verdict stands: APPROVED WITH CONDITIONS.** The five conditions (C1–C5 in §7) remain
unchanged. The corrections above are operational fixes to the verification harness, not
to the product under review, and they do not alter any of the ten objection dispositions.
