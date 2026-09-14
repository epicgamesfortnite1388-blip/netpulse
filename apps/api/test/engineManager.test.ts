import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { coresDir, extractFileFromZip, installEngine, probeBinaryVersion } from '../src/services/engineManager';

/**
 * Engine-manager contract: a core binary may only land in the cores dir
 * after (1) download from an allowlisted https host, (2) digest verification
 * against the release's published checksum, and (3) a successful
 * `version` self-check. Every failure path must be honest, never a fake
 * success. Network-touching paths are tested for their GUARDS only (no
 * external fetch in tests); extraction and validation run fully offline.
 */

const tmps: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'np-engmgr-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('coresDir', () => {
  it('prefers NETPULSE_CORES_DIR over the data dir', () => {
    const a = tmpDir();
    const b = tmpDir();
    process.env['NETPULSE_CORES_DIR'] = a;
    process.env['NETPULSE_DATA_DIR'] = b;
    expect(coresDir()).toBe(a);
    delete process.env['NETPULSE_CORES_DIR'];
    expect(coresDir()).toBe(path.join(b, 'cores'));
    delete process.env['NETPULSE_DATA_DIR'];
  });
});

describe('extractFileFromZip', () => {
  it('extracts the wanted entry from a stored (uncompressed) zip and ignores others', async () => {
    // Build a real zip in memory: two stored entries.
    const { createZip } = await import('./helpers/makeZip');
    const zipPath = path.join(tmpDir(), 't.zip');
    createZip(zipPath, [
      { name: 'folder/readme.txt', data: Buffer.from('ignore me') },
      { name: 'xray.exe', data: Buffer.from('MZfake-binary') },
    ]);
    const out = path.join(tmpDir(), 'out.exe');
    const ok = await extractFileFromZip(zipPath, 'xray.exe', out);
    expect(ok).toBe(true);
    expect(fs.readFileSync(out, 'utf8')).toBe('MZfake-binary');
  });

  it('returns false when the archive does not contain the wanted file', async () => {
    const { createZip } = await import('./helpers/makeZip');
    const zipPath = path.join(tmpDir(), 't.zip');
    createZip(zipPath, [{ name: 'other.exe', data: Buffer.from('x') }]);
    const out = path.join(tmpDir(), 'out.exe');
    expect(await extractFileFromZip(zipPath, 'xray.exe', out)).toBe(false);
  });

  it('rejects a non-zip file with an honest error', async () => {
    const zipPath = path.join(tmpDir(), 't.zip');
    fs.writeFileSync(zipPath, 'this is not a zip archive at all.........');
    await expect(extractFileFromZip(zipPath, 'xray.exe', path.join(tmpDir(), 'o'))).rejects.toThrow(/not a valid zip/);
  });
});

describe('probeBinaryVersion', () => {
  it('returns null for a file that is not an executable', async () => {
    const dir = tmpDir();
    const bin = path.join(dir, process.platform === 'win32' ? 'fake.exe' : 'fake');
    fs.writeFileSync(bin, 'not a real binary');
    fs.chmodSync(bin, 0o755);
    expect(await probeBinaryVersion(bin, 5_000)).toBeNull();
  });
});

describe('installEngine guards', () => {
  it('rejects an invalid version tag without any network fetch reaching the disk', async () => {
    // version regex is enforced at the schema layer; the manager itself must
    // fail honestly on an unknown tag rather than install latest.
    const out = await installEngine('xray', 'no/slashes/allowed/../etc');
    expect(out.status).toBe('failed');
    expect(out.path).toBeNull();
  });

  it('never writes into the cores dir on failure', async () => {
    const dir = tmpDir();
    process.env['NETPULSE_CORES_DIR'] = dir;
    process.env['NETPULSE_DATA_DIR'] = path.join(dir, 'data');
    await installEngine('v2ray', 'definitely-not-a-real-tag-xyz');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(files).toEqual([]);
    delete process.env['NETPULSE_CORES_DIR'];
    delete process.env['NETPULSE_DATA_DIR'];
  });
});
