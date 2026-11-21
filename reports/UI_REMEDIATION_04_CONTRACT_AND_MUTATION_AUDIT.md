# UI_REMEDIATION_04 — Contract and Mutation Audit

**Scope:** the CSS contract assertions, their mutation coverage, and the mutation
coverage of the assertions this mission added.
**Verdict:** contract **55/55**, mutants **9/9 rejected**, new assertions mutation-tested.

---

## 1 The audit question

The brief's §6 asks a precise question of every assertion: *what property does it
actually assert, does a deliberately defective example get rejected, does valid input
pass, and can it be fooled?* An assertion that has never failed is an assertion nobody
has verified.

## 2 What the contract check is

`scripts/assert-ui-contract.mjs` reads the **compiled** stylesheet from
`apps/web/dist/assets/index-*.css` and asserts that the primitives the interface depends
on survived compilation. It is not a pixel diff and does not check appearance; it checks
that the contract components rely on exists in the artefact that ships.

This catches a real class of regression. The script's own header records three defects
it found that a pixel diff would have caught only by luck:

- `text-accent-foreground` used in three components while the token was never declared —
  the utility compiled, the property resolved to nothing, white text rendered on cyan at
  **1.75:1**;
- eight `font-size: <literal>px` rules that ignored the user's Text-size preference;
- `backdrop-filter` emitted on a surface that `identity.css` then cancelled to `none`,
  so the browser paid for a compositing effect it discarded.

Each is visible in built CSS as a missing token, a fixed px size, or a no-op
declaration. No screenshot required.

## 3 Result against current source

Rebuilt first, so the check reads the CSS produced by the current source rather than a
stale artefact:

```
npx vite build                 → ✓ built in 7.85s
node scripts/assert-ui-contract.mjs
  ✓ UI contract intact — 55/55 assertions passed (index-DVKKnuXo.css)
```

**55/55, exit 0.**

## 4 Mutation coverage — do the assertions bite?

`scripts/verify-contract-assertions.mjs` feeds synthetic stylesheets through the **real**
contract script via the `UI_CONTRACT_CSS` override. This matters: a mutation test that
reimplements the validation proves only that the copy works. Here the production
assertion code runs, and only its input changes.

```
node scripts/verify-contract-assertions.mjs
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

| Mutant | Property it proves | Expected | Observed |
|---|---|---|---|
| clean baseline | no false positive on valid CSS | exit 0, "assertions passed" | as expected |
| `.bg-amber-500` injected | raw palette utilities are rejected | exit 1, "raw palette utilities" | as expected |
| `.text-[#f87171]` | hard-coded hex colours are rejected | exit 1, "hard-coded colour utilities" | as expected |
| `.border-[oklch(…)]` | hard-coded oklch colours are rejected | exit 1, "hard-coded colour utilities" | as expected |
| `--color-warn` deleted from light block | every semantic token must exist in both themes | exit 1, "missing from the light-theme block" | as expected |
| `--color-warn` set to `--color-ok` | state colours must be distinguishable | exit 1, "state colours collide" | as expected |
| animation rule deleted | reduced-motion must cover `animate-*` | exit 1, "does not cover animate-* utilities" | as expected |
| `.x{font-size:11px}` | text must respect the type-scale preference | exit 1, "fixed px font sizes" | as expected |
| `.np-dial` rule deleted | required primitives must exist | exit 1, "np-dial" | as expected |

The ninth case carries a note worth repeating: renaming `.np-dial` to
`.np-dial-renamed` would still satisfy a substring check, so the mutant **deletes the
rule outright**. That is the trap the case exists for.

### False positives

The `clean baseline passes` case is the false-positive control: the real stylesheet,
unmodified, must pass. It does.

A residual false-positive risk is worth naming: these assertions are **textual** over
minified CSS. A rule could be present but overridden later in the cascade and still pass.
That is precisely why the contrast figures in `_05` are measured from computed styles in
a browser rather than from this file. The two checks answer different questions and
neither substitutes for the other.

## 5 Mutation coverage of this mission's own assertions

The brief asks that newly added assertions get the same treatment. Two new test files
were written; both were mutated against the real implementation, then the source was
restored and the restore verified with `git diff --quiet`.

### `detailLevel.test.ts` (16 tests)

| Injected defect | Effect | Result |
|---|---|---|
| `isVisible`: `required <= current` → `required < current` | a block stops being visible at its own level | **3 tests failed** — visibility truth table, suppressed count (5 vs 4), next level (1 vs 2) |
| `offeredLevels`: return all four instead of trimming to depth | dead level options return | **2 tests failed** — "trims the offer to the deepest level in use", "never offers nothing" |

Restored: `Tests 16 passed (16)`.

### `mapClusterWork.test.ts` (6 tests)

| Injected defect | Effect | Result |
|---|---|---|
| bin lookup → linear scan over the bin Map | O(n·B) instead of O(n) | **2 tests failed** — per-node work 340 vs bound 40; growth 5.65 vs 5.5 |
| nested loop over the node list | genuine O(n²) | **2 tests failed** — per-node work 2013 vs 40; growth 3.96 vs 2.6 |

Full detail and the reason the counter had to be widened (the first version passed
against defect 1) are in `_02` §5.

## 6 What this audit did not do

- **No coverage of Rust-side assertions.** The backend has its own tests; this mission
  is scoped to the web interface.
- **No mutation of the contract script itself** — only of its input. Mutating the
  assertion code would test the mutator, not the assertion.
- **The contract check needs a build.** It reads `dist/`. Running it without a prior
  `vite build` exits 1 with an explicit message rather than silently passing on a stale
  stylesheet, but a stale `dist/` that *exists* is still read. That is a real limitation:
  the check cannot tell fresh CSS from old CSS. It was rebuilt before the run recorded
  above for exactly this reason.
- **`scripts/ui-colour-audit.mjs` and `scripts/ui-a11y-check.mjs` are not mutated.**
  They are measurement harnesses whose outputs are reported in `_05` and `_06`; their
  own failure modes were found by using them (both produced wrong answers first — see
  R-02 through R-07 in `_01`), which is a stronger signal than a synthetic mutant.
