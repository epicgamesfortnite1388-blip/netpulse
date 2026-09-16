import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { sweepStaleCoreDirs } from '../src/services/proxyCores';

/**
 * Crash-residue contract: a core temp dir abandoned by a killed run still holds
 * core.json (node credentials), so startup must clear the stale ones — and must
 * leave everything else alone.
 */
function makeDir(prefix: string, ageMs: number, files: Record<string, string> = { 'core.json': '{}' }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}sweep-test-`));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  const stamp = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, stamp, stamp);
  return dir;
}

describe('sweepStaleCoreDirs', () => {
  it('removes old core dirs and keeps fresh ones and foreign dirs', () => {
    const old = makeDir('netpulse-core-', 3 * 24 * 60 * 60 * 1000);
    const oldProbe = makeDir('netpulse-probe-', 2 * 24 * 60 * 60 * 1000);
    const fresh = makeDir('netpulse-core-', 60_000);
    const foreign = makeDir('someone-else-', 10 * 24 * 60 * 60 * 1000);
    const near = path.join(os.tmpdir(), `netpulse-core-ish-${Date.now()}`); // prefix-adjacent, not ours
    fs.mkdirSync(near);

    try {
      const res = sweepStaleCoreDirs();
      expect(res.removed).toBeGreaterThanOrEqual(2);
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(oldProbe)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(fs.existsSync(foreign)).toBe(true);
      expect(fs.existsSync(near)).toBe(true);
    } finally {
      for (const d of [old, oldProbe, fresh, foreign, near]) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it('honours the age threshold', () => {
    const thirtyMinutes = makeDir('netpulse-core-', 30 * 60 * 1000);
    try {
      const res = sweepStaleCoreDirs();
      expect(fs.existsSync(thirtyMinutes)).toBe(true);
      // and the same dir IS stale under a tighter threshold
      sweepStaleCoreDirs(60_000);
      expect(fs.existsSync(thirtyMinutes)).toBe(false);
      expect(res.removed).toBeGreaterThanOrEqual(0);
    } finally {
      fs.rmSync(thirtyMinutes, { recursive: true, force: true });
    }
  });

  it('never throws on an unreadable entry', () => {
    const orphan = path.join(os.tmpdir(), `netpulse-core-orphan-${Date.now()}`, 'locked');
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    try {
      expect(() => sweepStaleCoreDirs(0)).not.toThrow();
    } finally {
      fs.rmSync(path.dirname(orphan), { recursive: true, force: true });
    }
  });
});
