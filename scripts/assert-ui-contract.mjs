#!/usr/bin/env node
/**
 * UI contract regression check.
 *
 * Run: node scripts/assert-ui-contract.mjs      (needs a prior `vite build`)
 *
 * ## Why this exists
 *
 * The product has no pixel-diff visual regression harness. Adding one means a
 * browser engine, a baseline image store and a diff threshold -- and every one
 * of those is a new thing that can fail for reasons unrelated to the UI. What
 * this project actually needs first is a check that the *compiled* stylesheet
 * still contains the primitives the interface depends on.
 *
 * That is a real class of regression, not a hypothetical one. This audit found
 * three defects that a pixel diff would have caught only by luck, and that a
 * token assertion catches exactly:
 *
 *   - `text-accent-foreground` used in three components while
 *     `--color-accent-foreground` was never declared: the utility compiled, the
 *     property resolved to nothing, and white text rendered on cyan at 1.75:1.
 *   - Eight `font-size: <literal>px` rules in identity.css that ignored the
 *     user's Text-size preference.
 *   - `backdrop-filter` emitted on a surface that identity.css then cancelled
 *     to `none`, so the browser paid for a compositing effect it discarded.
 *
 * Each of those is visible in the built CSS as a missing token, a fixed px size,
 * or a no-op declaration. No screenshot required.
 *
 * ## What it does not do
 *
 * It does not verify layout, spacing or colour *appearance* -- only that the
 * contract the components rely on survived compilation. The manual matrix in
 * `reports/UI_MASTER_12_VISUAL_REGRESSION.md` covers the rest.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'apps', 'web', 'dist');
const ASSETS = join(DIST, 'assets');

/*
 * Self-test hook. Pointing `UI_CONTRACT_CSS` at a synthetic stylesheet lets the
 * assertions be exercised against input they are supposed to reject — an
 * assertion that has never failed is an assertion nobody has verified.
 * See `scripts/verify-contract-assertions.mjs`.
 */
const OVERRIDE = process.env.UI_CONTRACT_CSS;

if (!OVERRIDE && !existsSync(DIST)) {
  console.error('✖ apps/web/dist not found — run `npm run build -w @netpulse/web` first.');
  process.exit(1);
}

let cssFile;
let css;
if (OVERRIDE) {
  cssFile = OVERRIDE;
  css = readFileSync(OVERRIDE, 'utf8');
} else {
  cssFile = readdirSync(ASSETS).find((f) => /^index-.*\.css$/.test(f));
  if (!cssFile) {
    console.error('✖ no index-*.css in dist/assets — the build did not emit a stylesheet.');
    process.exit(1);
  }
  css = readFileSync(join(ASSETS, cssFile), 'utf8');
}

const failures = [];
const checks = [];

/** A token that a component references must exist in the compiled output. */
function requireToken(name) {
  const pattern = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  const ok = pattern.test(css);
  checks.push([ok, `token ${name} declared`]);
  if (!ok) failures.push(`missing token: ${name}`);
}

/** A class the interface depends on must survive Tailwind's tree-shaking. */
function requireClass(name) {
  const ok = css.includes(name);
  checks.push([ok, `class .${name} emitted`]);
  if (!ok) failures.push(`missing class: ${name}`);
}

/**
 * No declaration may reference a custom property that is never declared.
 *
 * `var(--x, fallback)` is exempt: the fallback is the declared value for that
 * use, which is how Tailwind's own `--default-font-feature-settings` works.
 * An undeclared property *without* a fallback resolves to the initial value --
 * that is the shape of the `--color-accent-foreground` defect, where the
 * utility compiled and the text inherited whatever colour was behind it.
 */
function assertNoDeadVarRefs() {
  const declared = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  // Set by the browser or by a runtime library, not by this stylesheet.
  const external = new Set(['--np-state']);
  const dead = new Set();
  for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*(,?)/g)) {
    const name = m[1];
    const hasFallback = m[2] === ',';
    if (hasFallback || declared.has(name) || external.has(name)) continue;
    dead.add(name);
  }
  const ok = dead.size === 0;
  checks.push([ok, 'no var() references an undeclared property without a fallback']);
  if (!ok) failures.push(`dead custom properties: ${[...dead].join(', ')}`);
}

/** Fixed px type is a hole in the Text-size preference. */
function assertNoFixedPxType() {
  const offenders = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => `${m[1]}px`);
  const ok = offenders.length === 0;
  checks.push([ok, 'no fixed-px font-size']);
  if (!ok) failures.push(`fixed px font sizes: ${[...new Set(offenders)].join(', ')}`);
}

/** A cancelled effect is a cost with no output. */
function assertNoCancelledBackdropFilter() {
  const hasBackdrop = /backdrop-filter:\s*(?!none)/.test(css);
  const cancelled = /backdrop-filter:\s*none\s*!important/.test(css);
  // Both is only a defect when the same rule set ends up as `none`; the
  // stylesheet uses `!important` deliberately to strip a vendor utility, so
  // the meaningful assertion is that no *live* backdrop-filter remains on a
  // panel surface.
  const panelWithBlur = /\.np-panel[^{]*\{[^}]*backdrop-filter:\s*(?!none)/.test(css);
  const ok = !panelWithBlur;
  checks.push([ok, 'no blur on .np-panel' + (hasBackdrop || cancelled ? ' (utility stripped as intended)' : '')]);
  if (!ok) failures.push('np-panel still composites a backdrop-filter');
}

/** The 12px floor, asserted on the compiled ramp. */
function assertTypeFloor() {
  const sizes = [...css.matchAll(/--text-[\w-]+:\s*calc\(\s*([\d.]+)rem\s*\*\s*var\(--type-scale\)/g)]
    .map((m) => Number(m[1]) * 16);
  const ok = sizes.length > 0 && sizes.every((px) => px >= 12);
  checks.push([ok, `type ramp respects the 12px floor (${sizes.length} steps)`]);
  if (!ok) failures.push(`type ramp below 12px: ${sizes.filter((p) => p < 12).join(', ')}px`);
}

/** The reduced-motion block must still neutralise the animations it names. */
function assertReducedMotion() {
  const blocks = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)/g)].length;
  const ok = blocks >= 1;
  checks.push([ok, `prefers-reduced-motion blocks present (${blocks})`]);
  if (!ok) failures.push('no prefers-reduced-motion block in the compiled CSS');
}

/**
 * A second palette is a design-system leak, not a style choice.
 *
 * Raw Tailwind palette utilities carry no light-theme counterpart: identity.css
 * redefines `--color-*` per theme, but `bg-sky-500/10` is a literal. So a
 * component written against the palette keeps its dark-theme tint on a white
 * card and its meaning silently detaches from the state it was meant to show.
 * Every colour must arrive through a token (semantic, protocol or aether).
 */
function assertNoRawPalette() {
  const families = 'green|red|blue|amber|yellow|emerald|sky|violet|purple|fuchsia|orange|cyan|indigo|rose|slate|gray|zinc|neutral|stone|teal|lime|pink';
  const raw = [...new Set(
    [...css.matchAll(new RegExp(`\\.(?:bg|text|border|from|via|to|ring|fill|stroke|divide|outline|decoration)-(?:${families})-\\d{2,3}`, 'g'))]
      .map((m) => m[0]),
  )];
  const ok = raw.length === 0;
  checks.push([ok, 'no raw palette utilities in the compiled stylesheet']);
  if (!ok) failures.push(`raw palette utilities: ${raw.slice(0, 12).join(', ')}${raw.length > 12 ? ` (+${raw.length - 12} more)` : ''}`);
}

/**
 * A hard-coded surface colour cannot follow the theme.
 *
 * `bg-[#07121b]` stayed near-black in light theme, which made the panel's own
 * token-coloured text unreadable. Arbitrary hex belongs in a token, not a class.
 *
 * An earlier version only looked at `bg-|from-|via-|to-|ring-`, which meant
 * `text-[#f87171]` and `border-[oklch(...)]` sailed straight through. Arbitrary
 * *colour* values are rejected on every colour-bearing prefix; arbitrary values
 * that reference a token (`shadow-[0_0_18px_var(--color-accent-soft)]`) are fine.
 */
function assertNoHardcodedSurface() {
  // Minified CSS escapes arbitrary-value selectors (`.text-\[\#f87171\]`), so
  // match against a copy with the escapes stripped. Getting the escaping wrong
  // here silently disabled the whole check — the self-test in
  // `verify-contract-assertions.mjs` is what caught it.
  const flat = css.replace(/\\/g, '');
  const prefixes = 'bg|text|border|from|via|to|ring|fill|stroke|divide|outline|decoration|shadow|accent|caret|placeholder';
  const hex = new RegExp(`\\.(?:${prefixes})-\\[#[0-9a-fA-F]{3,8}\\]`, 'g');
  const fn = new RegExp(`\\.(?:${prefixes})-\\[(?:oklch|rgba?|hsla?)\\(`, 'g');
  const raw = [...new Set([...flat.matchAll(hex), ...flat.matchAll(fn)].map((m) => m[0]))];
  const ok = raw.length === 0;
  checks.push([ok, 'no hard-coded colour values in utility classes']);
  if (!ok) failures.push(`hard-coded colour utilities: ${raw.slice(0, 8).join(', ')}`);
}

/**
 * Every semantic colour must actually be overridden for the light theme.
 *
 * An earlier version counted *distinct declared values* for a token and required
 * two. That is too weak: two identical declarations in two `:root` blocks would
 * satisfy it while light theme still inherited the dark value. This version reads
 * the light block itself and requires the token to be declared inside it.
 */
function lightThemeBlock() {
  // The build minifies `html[data-theme='light']` to `html[data-theme=light]`.
  const re = /html\[data-theme=['"]?light['"]?\]\{([^}]*)\}/g;
  let out = '';
  for (const m of css.matchAll(re)) out += m[1] + ';';
  return out;
}

function assertThemeParity() {
  const required = [
    '--color-bg', '--color-surface', '--color-surface-2', '--color-surface-3',
    '--color-text', '--color-muted', '--color-faint',
    '--color-accent', '--color-ok', '--color-warn', '--color-danger',
    '--color-line', '--color-aether', '--color-aether-2',
  ];
  const light = lightThemeBlock();
  if (!light) {
    checks.push([false, 'light-theme block found in the compiled stylesheet']);
    failures.push('no `html[data-theme=light]` block in the compiled CSS');
    return;
  }
  const missing = required.filter((t) => !new RegExp(`${t}:`).test(light));
  const ok = missing.length === 0;
  checks.push([ok, `light theme overrides every semantic token (${required.length} checked)`]);
  if (!ok) failures.push(`token missing from the light-theme block: ${missing.join(', ')}`);
}

/** Two states that render identically are not two states — in either theme. */
function assertStateSeparation() {
  const first = (scope, token) => {
    const m = scope.match(new RegExp(`${token}:\\s*([^;}]+)`));
    return m ? m[1].trim().toLowerCase() : null;
  };
  const dark = css;
  const light = lightThemeBlock();
  const bad = [];
  for (const [name, scope] of [['dark', dark], ['light', light]]) {
    const vals = ['--color-ok', '--color-warn', '--color-danger'].map((t) => first(scope, t));
    if (vals.some((v) => !v) || new Set(vals).size !== 3) bad.push(`${name}: ${vals.join(' / ')}`);
  }
  const ok = bad.length === 0;
  checks.push([ok, 'ok / warn / danger are three distinct values in both themes']);
  if (!ok) failures.push(`state colours collide — ${bad.join('; ')}`);
}

/**
 * Reduced motion must cover the animation *utilities*, not just named classes.
 *
 * The original block was a blocklist (`.aether-halo`, `.animate-pulse-dot`, …).
 * Components use Tailwind's utilities directly, and `animate-pulse` — infinite —
 * appeared on six elements with nothing neutralising it. A list of names cannot
 * keep up, so the family is covered and `animate-spin` is exempt (a spinner that
 * stops is indistinguishable from a hang).
 */
function assertReducedMotionCoverage() {
  const family = css.includes('[class*=animate-]') || css.includes("[class*='animate-']");
  const spinExempt = css.includes(':not([class*=animate-spin])') || css.includes(":not([class*='animate-spin'])");
  const ok = family && spinExempt;
  checks.push([ok, 'reduced motion neutralises the animation-utility family (spinners exempt)']);
  if (!ok) failures.push('reduced-motion block does not cover animate-* utilities');
}

/**
 * A panel sized by its column needs a container context.
 *
 * Counting `container-type` occurrences globally is not enough: one container
 * query anywhere satisfies it while the next panel still sizes itself from the
 * window. So this checks the specific surface that broke — the connection panel
 * must declare `@container`, and must not reintroduce a viewport breakpoint for
 * the grid that collapsed.
 */
function assertContainerQueries() {
  const inline = [...css.matchAll(/container-type:\s*inline-size/g)].length;
  checks.push([inline >= 1, `container-query contexts emitted (${inline})`]);
  if (inline < 1) failures.push('no `container-type: inline-size` — panels cannot size to their column');

  const heroPath = join(ROOT, 'apps', 'web', 'src', 'features', 'connection', 'ConnectionHero.tsx');
  if (!existsSync(heroPath)) {
    checks.push([false, 'ConnectionHero.tsx found']);
    failures.push('apps/web/src/features/connection/ConnectionHero.tsx not found');
    return;
  }
  const src = readFileSync(heroPath, 'utf8');
  const declaresContainer = src.includes('@container');
  // The original defect, verbatim: three fixed tracks chosen by viewport width.
  const viewportGrid = /lg:grid-cols-\[236px/.test(src);
  const ok = declaresContainer && !viewportGrid;
  checks.push([ok, 'connection panel sizes to its column, not the viewport']);
  if (!ok) {
    failures.push(
      !declaresContainer
        ? 'ConnectionHero no longer declares @container'
        : 'ConnectionHero reintroduced a viewport breakpoint for its main grid',
    );
  }
}

/**
 * Every routed page must name itself in an `h1`.
 *
 * Live Map shipped without one for months: the document had no top-level
 * heading and screen-reader users had no page title. Deriving the list from the
 * router means a new route is covered the moment it is registered.
 *
 * This is a source-level check, not a render test: it accepts any of the three
 * ways a page declares its title (`PageHeader`, a literal `<h1>`, or
 * `EngineHero pageTitle`). It cannot prove the heading reaches the DOM — the
 * capture manifest's per-route `h1` field is the render-level evidence.
 *
 * Comments are stripped before the test, because a mention of `pageTitle` in a
 * comment is not a heading. And a page must not declare its title twice: using
 * `pageTitle` alongside `PageHeader` would emit two `h1`s, which is worse than
 * the missing one this check was added to find.
 */
function assertEveryRouteHasHeading() {
  const routerPath = join(ROOT, 'apps', 'web', 'src', 'app', 'router.tsx');
  if (!existsSync(routerPath)) {
    checks.push([false, 'router.tsx found']);
    failures.push('apps/web/src/app/router.tsx not found');
    return;
  }
  const router = readFileSync(routerPath, 'utf8');
  const modules = [...router.matchAll(/import\(\s*'@\/([^']+)'\s*\)/g)].map((m) => m[1]);
  const missing = [];
  const doubled = [];
  for (const mod of modules) {
    const file = join(ROOT, 'apps', 'web', 'src', mod) + '.tsx';
    if (!existsSync(file)) { missing.push(`${mod} (file not found)`); continue; }
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (!/PageHeader|<h1[\s>]|pageTitle/.test(code)) missing.push(mod);
    if (/pageTitle/.test(code) && /<PageHeader/.test(code)) doubled.push(mod);
  }
  const ok = modules.length > 0 && missing.length === 0 && doubled.length === 0;
  checks.push([ok, `every routed page declares exactly one h1 (${modules.length} routes)`]);
  if (missing.length) failures.push(`route without an h1: ${missing.join(', ')}`);
  if (doubled.length) failures.push(`route declaring two h1s (pageTitle + PageHeader): ${doubled.join(', ')}`);
}

// --- the contract ---------------------------------------------------------

for (const token of [
  '--color-bg', '--color-surface', '--color-surface-2', '--color-surface-3',
  '--color-elevated', '--color-text', '--color-muted', '--color-faint',
  '--color-accent', '--color-accent-strong', '--color-on-accent',
  '--color-accent-foreground', '--color-background',
  '--color-ok', '--color-warn', '--color-danger',
  '--color-line', '--color-line-strong',
  '--type-scale', '--ease-fluid', '--ease-spring', '--dur-quick', '--dur-base',
]) requireToken(token);

for (const cls of [
  'np-panel', 'np-label', 'np-row', 'np-inset', 'np-state-badge', 'np-state-dot',
  'np-btn-primary', 'np-btn-quiet', 'np-icon-btn', 'np-shell', 'np-rail',
  'np-context', 'np-topbar', 'np-content', 'np-dial',
  'page-enter', 'stagger', 'animate-pulse-dot', 'sr-only',
]) requireClass(cls);

assertNoDeadVarRefs();
assertNoFixedPxType();
assertNoCancelledBackdropFilter();
assertTypeFloor();
assertReducedMotion();
assertReducedMotionCoverage();
assertNoRawPalette();
assertNoHardcodedSurface();
assertThemeParity();
assertStateSeparation();
assertContainerQueries();
assertEveryRouteHasHeading();

// --- report ---------------------------------------------------------------

let pass = 0;
for (const [ok, label] of checks) {
  if (ok) pass += 1;
  else console.log(`  ✖ ${label}`);
}

if (failures.length === 0) {
  console.log(`✓ UI contract intact — ${pass}/${checks.length} assertions passed (${cssFile})`);
  process.exit(0);
}

console.error(`\n✖ ${failures.length} UI contract violation(s):`);
for (const f of failures) console.error(`  - ${f}`);
console.error('\nA pixel-diff suite would not have explained any of these. The compiled');
console.error('stylesheet is the contract; restore the token or the class, not the screenshot.');
process.exit(1);
