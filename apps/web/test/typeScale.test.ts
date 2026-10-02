import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The type scale is a convention, and conventions rot. 9px/10px/11px type was
 * being written as a bracket value at each call site (49 sites at 10px alone),
 * which put 514 of /nodes' 1202 text nodes under 12px and already overflowed
 * 150 boxes at a 1024px window. These tests make the floor a property of the
 * build rather than a thing to remember.
 */

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');
const TOKENS = join(SRC, 'styles', 'tokens.css');
const SETTINGS_MODEL = join(ROOT, '..', '..', 'packages', 'shared', 'src', 'models', 'settings.ts');

/** Every .tsx under src, so a new page cannot opt out silently. */
function tsxFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const files = tsxFiles();
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

/**
 * `text-[13px]`, `text-[10px]`, `font-size-[0.8rem]` — a numeric inline size.
 * Deliberately numeric: `text-[var(--color-accent)]` is a colour escape hatch
 * and is none of this test's business.
 */
const BRACKET_SIZE = /(?:^|[\s"'`])(text-\[[\d.]+(?:px|rem|em|pt)\]|font-size-\[[^\]]+\])/g;

/**
 * `--text-*` declarations, parsed for their BASE size at scale 1. The value may
 * be a bare length (`0.75rem`, `12px`) or the scaled form the user type-scale
 * preference introduced (`calc(0.75rem * var(--type-scale))`); both state the
 * same 1x size, and that size is what the 12px floor is a statement about --
 * the preference only ever multiplies it upward.
 */
function declaredTextTokens(css: string): { name: string; px: number; raw: string }[] {
  const out: { name: string; px: number; raw: string }[] = [];
  for (const m of css.matchAll(/--text-([\w-]+):\s*([^;]+);/g)) {
    const size = m[2].match(/([\d.]+)(px|rem)/);
    if (!size) continue;
    out.push({
      name: m[1],
      px: size[2] === 'px' ? Number(size[1]) : Number(size[1]) * 16,
      raw: m[2].trim(),
    });
  }
  return out;
}

describe('type scale tokens', () => {
  it('declares a 12px floor and a 13px step in tokens.css', () => {
    const css = readFileSync(TOKENS, 'utf8');
    expect(css).toMatch(/--text-micro:\s*calc\(\s*0\.75rem/);
    expect(css).toMatch(/--text-mini:\s*calc\(\s*0\.8125rem/);
  });

  it('never declares a token below the 12px floor', () => {
    const declared = declaredTextTokens(readFileSync(TOKENS, 'utf8'));
    expect(declared.length).toBeGreaterThan(0);
    for (const t of declared) {
      expect(t.px, `--text-${t.name} is ${t.px}px, below the 12px floor`).toBeGreaterThanOrEqual(12);
    }
  });

  it('scales every ramp token, so no step can silently opt out', () => {
    // A token left unscaled would sit at its 1x size while the rest of the ramp
    // grew, inverting the hierarchy the preference is supposed to preserve.
    const declared = declaredTextTokens(readFileSync(TOKENS, 'utf8'));
    expect(declared.length).toBeGreaterThan(0);
    const unscaled = declared.filter((t) => !/var\(--type-scale\)/.test(t.raw)).map((t) => t.name);
    expect(unscaled, `not multiplied by --type-scale: ${unscaled.join(', ')}`).toEqual([]);
  });
});

describe('user type scale preference', () => {
  it('defaults to 1x so an unset preference is not a surprise', () => {
    const css = readFileSync(TOKENS, 'utf8');
    expect(css).toMatch(/:root\s*\{[^}]*--type-scale:\s*1\s*;/);
  });

  it('offers ascending steps that never shrink below 1x', () => {
    const css = readFileSync(TOKENS, 'utf8');
    const steps = [...css.matchAll(/\[data-type-scale=['"](\w+)['"]\]\s*\{\s*--type-scale:\s*([\d.]+)\s*;/g)]
      .map((m) => ({ step: m[1], value: Number(m[2]) }));
    expect(steps.length).toBeGreaterThan(0);
    // Steps only ever multiply, so the 12px floor cannot be undercut by
    // choosing a larger one.
    for (const s of steps) expect(s.value, `${s.step} shrinks text`).toBeGreaterThanOrEqual(1);
    const values = steps.map((s) => s.value);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it('matches the steps the settings contract and UI offer', () => {
    // One source of truth: a step in CSS that the UI cannot select is dead, and
    // a step in the contract with no CSS rule silently does nothing.
    const cssSteps = new Set(
      [...readFileSync(TOKENS, 'utf8').matchAll(/\[data-type-scale=['"](\w+)['"]\]/g)].map((m) => m[1]),
    );
    const declared = new Set(
      readFileSync(SETTINGS_MODEL, 'utf8')
        .match(/TypeScaleSetting = ([^;]+);/)![1]
        .split('|')
        .map((part) => part.replace(/['\s]/g, ''))
        .filter(Boolean),
    );
    for (const s of declared) {
      if (s === 'default') continue; // the 1x :root default, not an attribute
      expect(cssSteps.has(s), `TypeScaleSetting "${s}" has no [data-type-scale] rule`).toBe(true);
    }
  });
});

describe('components', () => {
  it('finds components to check (guards against a broken glob)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('contains no arbitrary font sizes at all', () => {
    const offenders: string[] = [];
    for (const [file, src] of sources) {
      for (const m of src.matchAll(BRACKET_SIZE)) {
        offenders.push(`${relative(ROOT, file)}: ${m[1]}`);
      }
    }
    expect(offenders, `use text-micro / text-mini / text-xs / text-sm instead:\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('renders no text below the 12px floor', () => {
    // Belt and braces: catches a rem value that is under 0.75rem too.
    const offenders: string[] = [];
    for (const [file, src] of sources) {
      for (const m of src.matchAll(/(?:^|[\s"'`])text-\[([\d.]+)(px|rem|em)\]/g)) {
        const px = m[2] === 'px' ? Number(m[1]) : Number(m[1]) * 16;
        if (px < 12) offenders.push(`${relative(ROOT, file)}: text-[${m[1]}${m[2]}] = ${px}px`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('keeps the ad-hoc 13px step on the shared token, not per call site', () => {
    const bare = [...sources.values()].filter((s) => /text-\[13px\]/.test(s)).length;
    expect(bare).toBe(0);
    const using = [...sources.values()].filter((s) => /text-mini\b/.test(s)).length;
    expect(using).toBeGreaterThan(5);
  });
});