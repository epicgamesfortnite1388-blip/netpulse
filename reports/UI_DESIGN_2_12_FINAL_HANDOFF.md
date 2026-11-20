# UI DESIGN 2.0 — 12 — Final Handoff

**Overall verdict: PASS WITH CONDITIONS**
Two conditions are blocking (C-04, C-05). The rest are documented judgement calls.

---

## 1. Where the work landed

| Metric | Baseline | Final |
|---|---|---|
| Typecheck | 0 errors | **0 errors** |
| Tests | 54 files / 509 | **56 files / 534** |
| Lint | 0 problems | **0 problems** |
| Build | ~14 s | **12.5 – 14.1 s** |
| UI contract | 47 / 47 | **55 / 55** |
| Contract self-test | — | **9 / 9 mutants rejected** |
| Screenshots verified | — | **100** (20 routes × 5 configs) |
| Routes with an `h1` | 24 / 26 | **26 / 26** (100 / 100 rendered) |
| Raw palette utilities | 110 (84 compiled rules) | **0** |
| Horizontal overflow | 1 route | **0** |

Files: 25 modified under `apps/web/src` (+672 / −398), 5 new source files, 4 new scripts,
12 reports. **Nothing committed** — `git diff --cached --name-only` is empty.

---

## 2. Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Audit the **real running app**, not the source | **PASS** | 100 captures, 2 harnesses, computed colours; report 01 |
| 2 | Do not invent problems to justify changes | **PASS** | 24 findings, each with evidence; 6 producing visibly wrong output |
| 3 | Define a coherent design direction | **PASS** | Report 02 — ratifies *Signal / Instrument* and closes the gap between stated rules and shipped code |
| 4 | Colour semantics: warning ≠ success, neutral ≠ failure | **PASS** | 3 token families; `assertStateSeparation` (both themes); 1.39:1 → AA contrast table |
| 5 | Typography respects `--type-scale`, no fixed px | **PASS** | `assertNoFixedPxType` + 12 px floor; 125 % verified |
| 6 | One spacing rhythm | **PASS** | No second scale introduced; misalignment fixed at `Field` |
| 7 | Surfaces: nested never contradicts parent | **PASS** | `EmptyState` inner border removed; `--np-r-*` |
| 8 | Screen-by-screen mastery | **PARTIAL** | Dashboard, connection, NANI overview, Copilot, Settings, Diagnostics, Map, Node detail done. NANI investigation lifecycle and VPN rows 3+ **not** driven with live data |
| 9 | Component inventory, 8 attributes each | **PASS** | Report 05 — 12 components |
| 10 | Motion: no constant pulsing, respect reduced motion | **PASS** | Report 06; the blocklist gap found and fixed; assertion 54 |
| 11 | Information density / progressive disclosure, 4 levels | **FAIL** | **Not implemented.** See C-05 |
| 12 | Preserve and extend the contract; never weaken | **PASS** | 47 → 55, none relaxed, 9/9 mutation-tested |
| 13 | Implement in small reviewable groups | **PASS** | Report 07 — 9 groups, each closed with the full gate |
| 14 | Visual QA across text scales, sizes, themes | **PASS** | 100 captures; defect registry V-01…V-24 |
| 15 | Performance and accessibility | **PARTIAL** | Contrast, headings, reduced motion, focus all pass; `faint`/`surface-2` at 4.21:1 open (O-05); `LiveMapPage` 377 kB gzip open (P-01) |
| 16 | Do not regress 509 tests / 47 assertions | **PASS** | 534 tests, 55 assertions, both up |
| 17 | Three iteration cycles | **FAIL** | One substantial iteration + a palette pass + a verification pass. See C-03 |
| 18 | Twelve deliverables | **PASS** | `UI_DESIGN_2_01` … `_12` |
| 19 | Preservation rules | **PASS** | Report 10 §6; no commit, no reset, no clean, no staging |

**13 PASS · 2 PARTIAL · 2 FAIL.**

The two FAILs are honest scope gaps, not obscured ones. Criterion 11 was asked for
explicitly and has no output; criterion 17 was not delivered in the requested shape.

---

## 3. What a maintainer should read first

1. **`UI_DESIGN_2_08_VISUAL_QA.md` §6** — the re-evaluation of the pixel-diff proposal.
   Seven of eight real defects were invisible to a pixel diff. That changes what the next
   investment should be.
2. **`UI_DESIGN_2_11_KIM_INDEPENDENT_REVIEW.md` §2 K-01** — four of the assertions I added
   did not assert what they claimed. They are fixed and mutation-tested, but the lesson
   matters more than the fix.
3. **`UI_DESIGN_2_02_DESIGN_DIRECTION.md` §3** — the three-token-family rule. Every future
   colour question is answered by it.

---

## 4. Conditions

### Blocking

**C-04 — `mapClusterPerf.test.ts` asserts wall-clock thresholds.**
Three tests with `expect(dt).toBeLessThan(100)` / `< 25`. They fail when the machine is
busy: one real failure was observed while `vite build` ran concurrently. Separately, two
runs reported shorter counts while headless Chromium was capturing; those are not
reproducible on an idle machine (9 of 9 runs give 56 files / 534 tests / 0 failures), so
they are recorded as load sensitivity rather than a collection bug. Net effect: "534 tests
pass" is deterministic when idle and load-sensitive when not. Fix by comparing against a
measured baseline, or add `{ retry: 2 }`. Test-only change; not applied because the file
belongs to another agent.

**C-05 — Phase 6 (progressive disclosure, 4 levels) has no output.**
The brief's §8 asked for information density and progressive disclosure across four
levels. The primitives exist (`fold`, `DisclosureScope`) and are used, but no four-level
model was defined, no screen restructured to add a level, and no density measured. This
is the largest gap in the delivery. Either implement it or descope it with the
maintainers — it should not be absorbed silently into "future work".

### Non-blocking

| ID | Condition |
|---|---|
| C-01 | `PROXY_CORE_META.glyph` / `MANAGED_PROVIDER_META.glyph` now hold the same value for six entries. Delete the field or restore a distinction that carries meaning. |
| C-02 | The `EngineBadge` single tint trades away a dark-theme scanning cue. Record it as a trade. |
| C-03 | Iteration cycles 1–3 were not run as three cycles. Say so where it matters. |
| C-06 | `scripts/oneoff/unify-palette.mjs` is archaeology. **Done** — relocated and labelled. |
| C-07 | `--color-aether` (violet) collides with the identity's "violet = NANI". Flagged, then widened by two new uses. Resolve one way or the other. |
| O-05 | `--color-faint` on `--color-surface-2` is 4.21:1 in light theme. The honest fix is a token change that needs a review across all 20 routes. |
| P-01 | `LiveMapPage` ships 1.27 MB (377 kB gzip). Lazy-loaded, so not a first-paint cost, but one route carrying 377 kB gzip is real. Dependency decision, not a design one. |
| O-01 | Aether / NANI share a hue family (same as C-07). |

---

## 5. Unverified — stated so it is not mistaken for verified

| Area | Why |
|---|---|
| NANI investigation creation, progress, verification | Not driven with live investigation data. The render paths contain no invented values, but the states were not exercised. |
| VPN configuration rows below the first two sections | Not reviewed. |
| Node detail, populated state | Local data directory contains **zero** nodes. Only the empty/not-found state renders. The `h1` fix is pinned by two component tests instead. |
| NOC overlay in light theme | Only mounts on interaction; defect proven from code (`text-text` on `bg-[#060a12]`), not from a screenshot. |
| 93 of 100 captures | Verified structurally (heading, overflow, theme, scale), **not** inspected visually. Report 08 §2 lists the 7 that were. |
| Contrast over gradients and tinted wells | Ratios were computed from token values, which covers flat surfaces only. |

---

## 6. How to reproduce

```bash
# 1. Servers
PORT=8899 DATA_DIR=/tmp/np-data npx tsx apps/api/src/index.ts     # API
cd apps/web && VITE_API_PORT=8899 npx vite --port 5173 --host 127.0.0.1

# 2. Gates (all must be green)
npx tsc --noEmit -p apps/web/tsconfig.json
cd apps/web && npx vitest run          # 56 files / 534 tests — run from apps/web
cd ../.. && npx eslint apps/web/src
cd apps/web && npx vite build
cd ../.. && node scripts/assert-ui-contract.mjs          # 55/55
node scripts/verify-contract-assertions.mjs              # 9/9 mutants

# 3. Evidence
node scripts/ui-capture.mjs --out evidence/final-1440-dark
node scripts/ui-capture.mjs --out evidence/final-1024 --width 1024 --height 768
node scripts/ui-capture.mjs --out evidence/final-1280 --width 1280 --height 800
node scripts/ui-capture.mjs --out evidence/final-scale125 --dom-scale 1.25   # → xl
node scripts/ui-capture.mjs --out evidence/final-light --dom-theme l
node scripts/ui-capture.mjs --out evidence/ad-hoc --path /nodes/<id> --label "Node detail"
```

`--dom-scale` accepts only `1`, `1.125` and `1.25`; it maps them to the named
`data-type-scale` steps and **aborts** if the page does not resolve the value. That guard
exists because an earlier version silently captured 100 % when asked for 125 %.

---

## 7. The design position, in one paragraph

NetPulse is a measuring instrument, and the interface should behave like one: legible at
a glance, honest about what it does not know, quiet until something is wrong. That
position was already written in `identity.css` and was not being enforced — 110 raw
palette utilities shipped, including two native tunnels painted in the danger and warning
hues, and one label at 1.39:1 on a white card. This pass did not add an aesthetic. It
closed the distance between the stated system and the shipped one, and then made the
closing mechanical: a colour must be a state, an identity, or absent; a panel sizes to its
column; a page names itself in an `h1`; and motion yields to the user's preference. Each
of those is now a failing command rather than a paragraph.

The next most valuable work is not more polish. It is Phase 6 — deciding what each screen
shows first, and what it defers — because the dashboard is still two screens tall and no
amount of colour discipline fixes that.
