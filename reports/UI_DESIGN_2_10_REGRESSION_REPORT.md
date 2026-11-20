# UI DESIGN 2.0 — 10 — Regression Report

**Baseline:** 54 files / 509 tests · 47 contract assertions
**Final:** 56 files / 534 tests · 54 contract assertions
**Net:** nothing removed, nothing weakened.

---

## 1. Final gate

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p apps/web/tsconfig.json` | **0 errors** |
| Tests | `npx vitest run` (from `apps/web`) | **56 files / 534 tests passing**, exit 0 |
| Lint | `npx eslint apps/web/src` | **0 problems** |
| Build | `npx vite build` | **success**, 12.5 – 14.1 s |
| UI contract | `node scripts/assert-ui-contract.mjs` | **54 / 54 assertions** |

```
Test Files  56 passed (56)
     Tests  534 passed (534)
```

```
✓ UI contract intact — 54/54 assertions passed (index-WZciFYAT.css)
```

---

## 2. Test suite delta

| | Baseline | Final | Δ |
|---|---|---|---|
| Files | 54 | 56 | +2 |
| Tests | 509 | 534 | +25 |
| Failures | 0 | 0 | — |

The +2 files are `test/designPrimitives.test.tsx` (9 tests, this pass) and
`test/recoveryRegressions.test.ts` (uncommitted work from a parallel agent). The
remaining tests come with that file and pre-existing additions.

**No test was deleted, skipped, or relaxed.** No assertion threshold was widened.

### 2.1 New tests — `test/designPrimitives.test.tsx`

Nine tests that pin decisions CSS cannot see (element order, ARIA roles, class
ownership):

| # | Test |
|---|---|
| 1 | one `role="tablist"`, one `role="tab"` per item, exactly one `aria-selected="true"` |
| 2 | item icons reach the trigger |
| 3 | `Tabs` and `Segmented` emit the same track chrome but keep distinct roles |
| 4 | `EmptyState` draws no second border |
| 5 | `Field` renders label → control → hint |
| 6 | error replaces hint rather than stacking |
| 7 | `Metric` defaults to `text-xl`, `size="lg"` gives `text-2xl` |
| 8 | `EngineHero` is `h2` by default |
| 9 | `EngineHero pageTitle` renders `h1` |

Test 8 exists specifically to stop test 9 from becoming the default: a hero nested
under a page title must not become the page title.

---

## 3. Contract delta — 47 → 54

Seven assertions added. None removed, none relaxed.

| # | Assertion | Would have caught |
|---|---|---|
| 48 | no raw palette utilities in the compiled stylesheet | all 110 palette leaks |
| 49 | no hard-coded hex surface utilities | `bg-[#07121b]`, `bg-[#060a12]` |
| 50 | semantic tokens differ between themes (14 checked) | a token with no light override |
| 51 | `ok` / `warn` / `danger` resolve to three distinct values | "warning looks like success" |
| 52 | container-query contexts emitted | viewport-sized panels |
| 53 | every routed page declares an `h1` (26 routes) | Live Map, Node Detail |
| 54 | reduced motion neutralises the `animate-*` family (spinners exempt) | the 6 unguarded `animate-pulse` |

Assertion 53 found a real defect on its **first run** (`NodeDetailPage`). That is the
test paying for itself immediately.

---

## 4. Behavioural regressions considered

Each change was checked against "what else touches this".

| Change | Risk | Verification |
|---|---|---|
| `Metric` default 24 px → 20 px | Every consumer gets smaller | `size="lg"` available; dashboard's focal number is the verdict, not a metric. All 20 routes captured at 5 configurations; no clipping |
| `EmptyState` / `LoadingState` lose their border | Less visually anchored inside cards | Captured NANI hypotheses and other empty states; the parent card already provides the frame |
| `Tabs` rewritten | Keyboard behaviour could change | Radix owns it; test 1 asserts roles and `aria-selected`; 8-tab Settings bar verified at 125 % |
| `Segmented` chrome changes | Could be confused with `Tabs` | Test 3 asserts shared chrome **and** distinct roles |
| NANI tab bar replaced | 10 sections must all still switch | Every NANI tab captured (`03`–`07`, `19`); tab activation uses real pointer events because Radix activates on `pointerdown` |
| `EngineHero` heading rank | Could break the outline elsewhere | Default stays `h2`; test 8 pins it; only `NodeDetailPage` opts into `h1` |
| `DetailRow` → `DetailCell` | Session detail could lose information | Same six fields, verified in the 1024 and 1440 captures |
| Palette → tokens | Colours could shift | Computed colours probed; all semantic pairs re-measured (report 09 §1) |
| `animate-*` neutralisation | Could stop a meaningful spinner | `animate-spin` explicitly exempt; asserted |
| `bg-[#07121b]` → `bg-surface-2` | Console panel could lose its character | Character is carried by mono labels and the timeline rail; verified in captures |
| `max-w-xl` → `max-w-2xl` / `max-w-3xl` in Settings | Fields could stretch uncomfortably | Captured at 1440 and 125 %; paired grid holds |

---

## 5. Test-suite stability — an honest finding, corrected

### 5.1 What was observed

Across ~11 full runs during this pass, two produced results other than
`56 files / 534 tests / 0 failed`:

| Run | Reading | Concurrent activity |
|---|---|---|
| 1 | 56 files / 532 tests, **1 failed** | `vite build` running |
| 5 | **55 files / 531 tests** | headless Chromium capture running |
| — | **55 files / 517 tests** | headless Chromium capture running |
| All others (8 runs) | 56 / 534 / 0 failed | idle |

### 5.2 What I got wrong the first time

My first draft of this section attributed the count differences to
`mapClusterPerf.test.ts` failing to collect, on the reasoning that it has three tests and
531 − 534 = −3.

That reasoning was wrong. The 517 reading (−17) cannot be explained by a 3-test file, so
the "one file with three tests was not collected" story does not fit the data. I had
pattern-matched on a single number.

### 5.3 Corrected diagnosis

Two separate things, and only one of them is a suite defect:

**A. A genuine, reproducible-under-load failure.**
`test/mapClusterPerf.test.ts` asserts wall-clock thresholds:

```ts
const t0 = performance.now();
const out = clusterNodes(nodes, 1.2);
const dt = performance.now() - t0;
expect(dt).toBeLessThan(100);   // and toBeLessThan(25) in another case
```

That is a legitimate test of a real performance envelope, and it fails when the machine is
busy — which it was, because I was running `vite build` and headless Chromium alongside it.
This explains the one real failure.

**B. Count variance that I could not reproduce.**
With the machine idle, nine consecutive runs — three with the JSON reporter, three writing
to a file, three earlier — all report exactly **56 files / 534 tests / 0 failed**, and the
JSON report contains exactly 56 `testResults` entries summing to 534 assertions, with no
file contributing zero.

The two short readings both occurred while headless Chromium was capturing 20 routes
concurrently. I cannot distinguish a vitest reporting artefact from a worker being starved
in that condition, and I am not going to assert which it is. What I can assert is that the
suite is deterministic when the machine is idle.

### 5.4 Why this still matters

The statement "all tests pass" is load-sensitive in this repository. A CI runner that also
builds or captures screenshots in parallel could see a red result that is not a code
defect. That is worth knowing before it is discovered at the worst moment.

### 5.5 Recommended remedy (not applied)

```ts
// compare against a measured baseline rather than an absolute budget
const baseline = /* median of 5 runs of a trivial workload */;
expect(dt).toBeLessThan(baseline * 20);
```

or mark the file `{ retry: 2 }`. Both are test-only changes. **Not applied**, because
`mapClusterPerf.test.ts` is a performance-envelope test owned by another agent, and
loosening someone else's threshold during a UI pass is exactly the change that should not
happen without the owner's agreement.

Recorded as condition C-04 in the final handoff.

---

## 6. Preservation compliance

| Rule | Status |
|---|---|
| Preserve all uncommitted work | Yes — nothing staged, nothing reverted |
| Do not overwrite other agents' changes | Yes — only the files listed in report 07 were edited |
| No `git reset --hard` | Not run |
| No `git clean -fd` | Not run |
| No amending commits | No commit created at all |
| No force-push | No push |
| No blind staging | `git diff --cached --name-only` is empty |
| Do not delete reports or user data | No deletions |
| Do not modify unrelated Rust / backend | None touched — `git status` shows no `src-tauri/**` change from this pass |
| Do not change NANI maths, VPN networking, API contracts | None touched |
| Do not deploy | No deploy |
| Do not replace `dist-desktop/` | Untouched; only `apps/web/dist` was rebuilt by `vite build` |

### 6.1 Files created

```
reports/UI_DESIGN_2_01_CURRENT_STATE_AUDIT.md      … _12 (this series)
scripts/ui-capture.mjs
scripts/ui-probe.mjs
scripts/unify-palette.mjs
apps/web/src/components/ui/tabStyles.ts
apps/web/test/designPrimitives.test.tsx
```

### 6.2 Files modified

25 under `apps/web/src` (+672 / −398) and `scripts/assert-ui-contract.mjs`.
Enumerated with per-file reasons in report 07 §2–§6.

---

## 7. Verdict

**PASS.** All five gates are green, the suite grew by 25 tests and the contract by 7
assertions, no assertion was weakened, and no preservation rule was violated.

**With one condition:** "534 passing" is reproducible and deterministic on an idle machine
(9 of 9 consecutive runs), but the suite is load-sensitive: one run produced a real
failure in `mapClusterPerf.test.ts`, whose three tests assert wall-clock budgets, and two
runs produced shorter counts while headless Chromium was capturing screenshots
concurrently. The wall-clock assertions are the actionable part; see §5.3.
