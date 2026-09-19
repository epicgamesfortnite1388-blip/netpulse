import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkLatestReleases,
  coresDir,
  installedEngineVersions,
  resetEngineManagerCachesForTests,
} from '../src/services/engineManager';
import { engineVersionIsCurrent } from '@netpulse/shared';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-engmgr-'));
  process.env['NETPULSE_DATA_DIR'] = tmpDir;
  delete process.env['NETPULSE_CORES_DIR'];
  resetEngineManagerCachesForTests();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['NETPULSE_DATA_DIR'];
  resetEngineManagerCachesForTests();
});

describe('installedEngineVersions', () => {
  it('reports null for every core when nothing is installed (no invented version)', async () => {
    const versions = await installedEngineVersions({ force: true });
    expect(versions).toEqual({ xray: null, 'sing-box': null, v2ray: null, hysteria: null });
  });

  it('returns a version only for cores whose binary exists and answers', async () => {
    fs.mkdirSync(coresDir(), { recursive: true });
    // A real Windows exe cannot be faked cheaply; instead assert the presence
    // path: a present-but-unrunnable file yields null, never a guess.
    fs.writeFileSync(path.join(coresDir(), process.platform === 'win32' ? 'xray.exe' : 'xray'), 'not a real binary');
    const versions = await installedEngineVersions({ force: true });
    expect(versions.xray).toBeNull();
    expect(versions['sing-box']).toBeNull();
  });
});

describe('checkLatestReleases', () => {
  it('reports each engine\'s latest official tag, with release links', async () => {
    const lookup = async (repo: string) => ({
      tag_name: repo === 'XTLS/Xray-core' ? 'v26.3.27' : repo === 'SagerNet/sing-box' ? 'v1.14.0' : 'v5.53.0',
      html_url: `https://github.com/${repo}/releases/tag/latest`,
      assets: [],
    });
    const check = await checkLatestReleases({ force: true, lookup });
    expect(check.cached).toBe(false);
    expect(check.releases.map((r) => [r.id, r.latestTag])).toEqual([
      ['xray', 'v26.3.27'],
      ['sing-box', 'v1.14.0'],
      ['v2ray', 'v5.53.0'],
      ['hysteria', 'v5.53.0'], // lookup stub returns the same tag for any repo
    ]);
    expect(check.releases.every((r) => r.error === null && r.url?.includes('github.com'))).toBe(true);
  });

  it('reports a failed lookup per engine instead of a stale or invented tag', async () => {
    const lookup = async (repo: string) => {
      if (repo === 'SagerNet/sing-box') throw new Error('release lookup failed: HTTP 403 for SagerNet/sing-box');
      return { tag_name: 'v26.3.27', html_url: 'https://github.com/x/releases/tag/v26.3.27', assets: [] };
    };
    const check = await checkLatestReleases({ force: true, lookup });
    const sing = check.releases.find((r) => r.id === 'sing-box')!;
    expect(sing.latestTag).toBeNull();
    expect(sing.error).toContain('403');
    // the other engines still report honestly
    expect(check.releases.find((r) => r.id === 'xray')?.latestTag).toBe('v26.3.27');
  });

  it('serves the second call from cache without another lookup', async () => {
    let calls = 0;
    const lookup = async () => {
      calls += 1;
      return { tag_name: 'v1.0.0', html_url: null, assets: [] };
    };
    const first = await checkLatestReleases({ force: true, lookup });
    expect(first.cached).toBe(false);
    const second = await checkLatestReleases({ lookup });
    expect(second.cached).toBe(true);
    expect(calls).toBe(4); // one per engine on the fresh call only
    expect(second.releases).toEqual(first.releases);
  });
});

describe('engineVersionIsCurrent', () => {
  it('matches the tag\'s version inside the core\'s own version line', () => {
    expect(engineVersionIsCurrent('Xray 26.3.27 (Xray, Penetrates Everything.)', 'v26.3.27')).toBe(true);
    expect(engineVersionIsCurrent('sing-box version 1.14.0', 'v1.14.0')).toBe(true);
    expect(engineVersionIsCurrent('V2Ray 5.53.0 (V2Fly…)', 'v5.53.0')).toBe(true);
  });

  it('reports an update when the versions differ, and unknown when it cannot tell', () => {
    expect(engineVersionIsCurrent('Xray 26.3.27', 'v26.4.0')).toBe(false);
    expect(engineVersionIsCurrent(null, 'v1.0.0')).toBeNull();
    expect(engineVersionIsCurrent('sing-box version 1.14.0', null)).toBeNull();
  });
});
