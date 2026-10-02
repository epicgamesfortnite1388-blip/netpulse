import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every design token in this app is named `--color-*` and declared in
 * styles/tokens.css. A component that writes `text-[var(--text-muted)]`
 * against a token that does not exist is not a styling error you can see: the
 * declaration is invalid at computed-value time, so an inherited property
 * silently falls back to `inherit` and a non-inherited one to its initial
 * value. The span then renders as ordinary body text and reads as correct to
 * every gate — the contrast check measures the colour that actually painted and
 * finds it compliant.
 *
 * That is exactly what happened: 26 muted labels rendered as full-brightness
 * text, 11 hairlines rendered in the text colour, and 6 field backgrounds
 * rendered transparent. So the references are checked here, not by eye.
 */

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');
const STYLES = join(SRC, 'styles');

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

const tsx = walk(SRC, '.tsx');
const css = walk(STYLES, '.css');

/** Custom properties the stylesheets actually declare. */
function declared(): Set<string> {
  const out = new Set<string>();
  for (const f of css) {
    for (const m of readFileSync(f, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g)) out.add(m[1]);
  }
  return out;
}

/** Every custom property a component asks for. */
function referenced(): { file: string; token: string; line: number }[] {
  const out: { file: string; token: string; line: number }[] = [];
  for (const f of tsx) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/var\((--[a-z0-9-]+)/g)) {
        out.push({ file: relative(ROOT, f), token: m[1], line: i + 1 });
      }
    });
  }
  return out;
}

describe('design token references', () => {
  it('finds components and stylesheets (guards against a broken glob)', () => {
    expect(tsx.length).toBeGreaterThan(20);
    expect(css.length).toBeGreaterThan(0);
  });

  it('declares the muted/line/surface/accent tokens components rely on', () => {
    const d = declared();
    for (const t of ['--color-muted', '--color-line', '--color-surface-2', '--color-accent']) {
      expect(d.has(t), `${t} is not declared in styles/`).toBe(true);
    }
  });

  it('never references an undeclared custom property', () => {
    const d = declared();
    const offenders = referenced()
      .filter((r) => !d.has(r.token))
      .map((r) => `${r.file}:${r.line}  ${r.token}`);
    expect(
      offenders,
      `these resolve to nothing and silently fall back to inherit/initial:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('uses no arbitrary colour escape hatch left over from the v3 token names', () => {
    // text-[var(--text-muted)], border-[var(--border)], bg-[var(--bg-inset)]
    // and border-[var(--accent)] are Tailwind v3 names this app never adopted.
    const stale = ['--text-muted', '--border', '--bg-inset', '--accent', '--foreground', '--card', '--primary'];
    const hits: string[] = [];
    for (const f of tsx) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const t of stale) {
            if (line.includes(`var(${t})`) || line.includes(`-${t}]`)) {
              hits.push(`${relative(ROOT, f)}:${i + 1}  ${t}`);
            }
          }
        });
    }
    expect(hits, `use the generated utilities instead:\n${hits.join('\n')}`).toEqual([]);
  });
});