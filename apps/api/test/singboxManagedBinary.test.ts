import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectVpnBinaries, findSingBoxLaunch, managedSingBoxPath } from '../src/util/vpnDetect';

/**
 * Managed-binary contract: the app installs sing-box into its own cores dir, so
 * that binary must count as installed for the VPN provider layer — and the
 * provider must spawn THAT path, because spawning the bare name cannot see the
 * cores dir.
 */
let restoreEnv: Array<[string, string | undefined]> = [];
/**
 * MUST await the body: two tests pass `async () => …`, and a detached body
 * outlives this function's `finally` — which deletes `NETPULSE_CORES_DIR`
 * before `findSingBoxLaunch()` reads it. That made the assertion reject in a
 * fire-and-forget promise: the test reported green without ever running its
 * check, and under a shared-thread pool the rejection surfaced as an
 * unhandled error in a *later* file's run. Awaiting keeps the env and tmp dir
 * alive for exactly as long as the assertion needs them.
 */
async function withCoresDir(body: () => void | Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-singbox-detect-'));
  process.env['NETPULSE_CORES_DIR'] = tmp;
  restoreEnv.push(['NETPULSE_CORES_DIR', undefined]);
  try {
    await body();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [key] of restoreEnv) delete process.env[key];
    restoreEnv = [];
  }
}

afterEach(() => {
  for (const [key] of restoreEnv) delete process.env[key];
  restoreEnv = [];
});

describe('managed sing-box detection', () => {
  it('treats the app-managed cores-dir binary as installed', async () => {
    await withCoresDir(() => {
      const name = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
      fs.writeFileSync(path.join(coresPath(), name), '#!/bin/sh\nexit 0\n');
      expect(managedSingBoxPath()).not.toBeNull();
      expect(managedSingBoxPath()).toBe(path.join(coresPath(), process.platform === 'win32' ? 'sing-box.exe' : 'sing-box'));
    });
  });

  it('returns null when nothing is installed', async () => {
    await withCoresDir(() => {
      expect(managedSingBoxPath()).toBeNull();
    });
  });

  it('detectVpnBinaries sees the managed binary', async () => {
    await withCoresDir(async () => {
      const name = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
      fs.writeFileSync(path.join(coresPath(), name), 'x');
      const bins = await detectVpnBinaries();
      expect(bins.singbox).toBe(true);
    });
  });

  it('findSingBoxLaunch returns the managed path, not a bare name', async () => {
    await withCoresDir(async () => {
      const name = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
      const managed = path.join(coresPath(), name);
      fs.writeFileSync(managed, 'x');
      const launch = await findSingBoxLaunch();
      expect(launch).toBe(managed);
    });
  });
});

function coresPath(): string {
  return process.env['NETPULSE_CORES_DIR'] ?? '';
}
