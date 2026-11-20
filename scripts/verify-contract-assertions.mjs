#!/usr/bin/env node
/**
 * Negative test for `assert-ui-contract.mjs`.
 *
 * An assertion that has never failed is an assertion nobody has verified. This
 * takes the real compiled stylesheet, applies one targeted mutation at a time,
 * and checks that the contract rejects it — and rejects it for the right reason.
 *
 * Run: node scripts/verify-contract-assertions.mjs   (needs a prior `vite build`)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const ASSETS = join(ROOT, 'apps', 'web', 'dist', 'assets');
const cssFile = readdirSync(ASSETS).find((f) => /^index-.*\.css$/.test(f));
if (!cssFile) {
  console.error('✖ no compiled stylesheet — run `vite build` in apps/web first.');
  process.exit(1);
}
const BASE = readFileSync(join(ASSETS, cssFile), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'ui-contract-'));

/** Run the contract against a mutated stylesheet; return its combined output. */
function run(css) {
  const file = join(dir, 'mutant.css');
  writeFileSync(file, css);
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [join(ROOT, 'scripts', 'assert-ui-contract.mjs')], {
        env: { ...process.env, UI_CONTRACT_CSS: file },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** Replace the body of EVERY bare `html[data-theme=light]{…}` block. */
function mutateLight(css, fn) {
  return css.replace(/(html\[data-theme=['"]?light['"]?\]\{)([^}]*)(\})/g, (_m, open, body, close) => {
    return open + fn(body) + close;
  });
}

const CASES = [
  {
    name: 'clean baseline passes',
    mutate: (c) => c,
    expectCode: 0,
    expectText: 'assertions passed',
  },
  {
    name: 'raw palette utility is rejected',
    mutate: (c) => `${c}\n.bg-amber-500{background-color:#f59e0b}`,
    expectCode: 1,
    expectText: 'raw palette utilities',
  },
  {
    name: 'hard-coded hex text colour is rejected',
    mutate: (c) => `${c}\n.text-\\[\\#f87171\\]{color:#f87171}`,
    expectCode: 1,
    expectText: 'hard-coded colour utilities',
  },
  {
    name: 'hard-coded oklch border is rejected',
    mutate: (c) => `${c}\n.border-\\[oklch\\(70\\%_0\\.1_20\\)\\]{border-color:red}`,
    expectCode: 1,
    expectText: 'hard-coded colour utilities',
  },
  {
    name: 'a token missing from the light block is rejected',
    mutate: (c) => mutateLight(c, (b) => b.replace(/--color-warn:[^;]+;/, '')),
    expectCode: 1,
    expectText: 'missing from the light-theme block',
  },
  {
    name: 'warn colliding with ok is rejected',
    mutate: (c) =>
      mutateLight(c, (b) => {
        const ok = b.match(/--color-ok:\s*([^;]+)/)?.[1];
        return ok ? b.replace(/--color-warn:[^;]+/, `--color-warn:${ok}`) : b;
      }),
    expectCode: 1,
    expectText: 'state colours collide',
  },
  {
    name: 'removing the animation-family rule is rejected',
    mutate: (c) => c.replace(/\[class\*=animate-\]:not\(\[class\*=animate-spin\]\)\{[^}]*\}/, ''),
    expectCode: 1,
    expectText: 'does not cover animate-* utilities',
  },
  {
    name: 'a fixed-px font size is rejected',
    mutate: (c) => `${c}\n.x{font-size:11px}`,
    expectCode: 1,
    expectText: 'fixed px font sizes',
  },
  {
    name: 'a missing primitive class is rejected',
    // Delete the rule outright. Renaming `.np-dial` to `.np-dial-renamed` would
    // still satisfy a substring check — which is the trap this case exists for.
    mutate: (c) => c.replace(/\.np-dial[^{]*\{[^}]*\}/g, ''),
    expectCode: 1,
    expectText: 'np-dial',
  },
];

let pass = 0;
const failures = [];
for (const c of CASES) {
  const res = run(c.mutate(BASE));
  const codeOk = res.code === c.expectCode;
  const textOk = res.out.includes(c.expectText);
  if (codeOk && textOk) {
    pass += 1;
    console.log(`  ✓ ${c.name}`);
  } else {
    failures.push(`${c.name} — exit ${res.code} (want ${c.expectCode}), text ${textOk ? 'ok' : `missing "${c.expectText}"`}`);
    console.log(`  ✖ ${c.name}`);
  }
}

if (failures.length === 0) {
  console.log(`\n✓ contract assertions verified — ${pass}/${CASES.length} mutants rejected correctly`);
  process.exit(0);
}
console.error(`\n✖ ${failures.length} assertion(s) did not behave as specified:`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
