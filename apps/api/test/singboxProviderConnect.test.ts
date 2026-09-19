import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The sing-box provider's start goes through the shared core-process owner
 * (./coreProcess) — the same spawn/readiness/cleanup path the local cores and
 * Aether use. Only the OWNER is faked here, so these tests say what actually
 * happens when it answers ok or refuses.
 *
 * The constraint that shapes every assertion: the materialized config carries
 * the real credential, so it lives in the provider's private dir (never
 * %TEMP%) and is deleted after the process starts or fails. The provider must
 * NOT hand that config directory to the owner as `tempDir` — the owner deletes
 * a tempDir recursively, which would take every other profile's config with it.
 */
const h = vi.hoisted(() => ({
  spawnCoreProcess: vi.fn(),
}));

vi.mock('../src/services/coreProcess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/coreProcess')>();
  return { ...actual, spawnCoreProcess: h.spawnCoreProcess };
});

import { FileSecretVault, SingboxProvider } from '../src/vpn/vpnService';

import type { ImportedProfile } from '../src/vpn/vpnService';

/** A ChildProcess-shaped stand-in: the provider only ever calls these. */
function fakeChild() {
  const listeners = new Map<string, Array<() => void>>();
  const child = {
    pid: 5150,
    exitCode: null as number | null,
    kill: vi.fn(() => true),
    on: vi.fn((event: string, fn: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return child;
    }),
    /** Fire the provider's own close handler, as a real exit would. */
    emit(event: string) {
      for (const fn of listeners.get(event) ?? []) fn();
    },
  };
  return child;
}

let configDir = '';
let vaultFile = '';
let dirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-sbtest-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

beforeEach(() => {
  h.spawnCoreProcess.mockReset();
  configDir = scratch();
  vaultFile = path.join(scratch(), 'vault');
});

const MIXED_PORT = 2080;

/** A provider whose binary is "installed"; importProfile gives a real profile. */
async function providerWithProfile(): Promise<{ p: SingboxProvider; profile: ImportedProfile; updates: Array<Record<string, unknown>> }> {
  const updates: Array<Record<string, unknown>> = [];
  const p = new SingboxProvider(
    new FileSecretVault(vaultFile),
    configDir,
    {
      recordConnection: () => {},
      updateConnection: (_id: string, patch: Record<string, unknown>) => updates.push(patch),
      event: () => {},
    },
    MIXED_PORT,
  );
  // `available`/`launchPath` come from a real install check in init(); the
  // install path is covered elsewhere, so stand it up directly here.
  const target = p as unknown as { available: boolean; launchPath: string | null };
  target.available = true;
  target.launchPath = 'C:/fake/cores/sing-box.exe';
  const profile = await p.importProfile({
    configText: 'vless://11111111-2222-3333-4444-555555555555@example.com:443?security=tls#Test%20node',
    protocol: 'custom',
  });
  return { p, profile, updates };
}

/** The materialized credential config, as the provider names it. */
function realConfigPath(profileId: string): string {
  return path.join(configDir, 'tmp', `netpulse-sb-${profileId}.json`);
}

describe('sing-box connect through the shared core-process owner', () => {
  it('starts the binary through the owner and keeps the credential config out of temp', async () => {
    const child = fakeChild();
    const cleanup = vi.fn();
    h.spawnCoreProcess.mockResolvedValue({
      ok: true,
      process: { child, readyPort: MIXED_PORT, output: '', cleanup },
    });
    const { p, profile, updates } = await providerWithProfile();

    const status = await p.connect(profile);

    expect(h.spawnCoreProcess).toHaveBeenCalledTimes(1);
    const spec = h.spawnCoreProcess.mock.calls[0]![0] as Record<string, unknown>;
    expect(spec['bin']).toBe('C:/fake/cores/sing-box.exe');
    expect(spec['args']).toEqual(['run', '-c', realConfigPath(profile.id), '-D', configDir]);
    expect(spec['readyPort']).toBe(MIXED_PORT);
    expect(spec['readyTimeoutMs']).toBe(4_000);
    expect(spec['label']).toBe('sing-box');
    // The owner deletes a `tempDir` recursively — the credential dir must never
    // be handed to it, or stopping one profile would delete every other's config.
    expect(spec['tempDir']).toBeUndefined();

    // The config the core was pointed at is the provider's own private path,
    // never the OS temp dir, and it is gone again once the process is up.
    expect(spec['args']).not.toContain(os.tmpdir());
    expect(fs.existsSync(realConfigPath(profile.id))).toBe(false);

    expect(status.connected).toBe(true);
    expect(status.verification).toBe('verified');
    expect(status.verificationNote).toContain(`127.0.0.1:${MIXED_PORT}`);
    expect(updates.some((u) => u['status'] === 'connected')).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();

    // Teardown is the owner's, once.
    await p.disconnect();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((await p.status()).connected).toBe(false);
  });

  it('surfaces the owner’s classified refusal and deletes the credential config', async () => {
    h.spawnCoreProcess.mockResolvedValue({
      ok: false,
      failure: 'port_clash',
      error: `port ${MIXED_PORT} is already in use — the sing-box was not spawned`,
      output: '',
      exitCode: null,
    });
    const { p, profile, updates } = await providerWithProfile();

    await expect(p.connect(profile)).rejects.toThrow(/already in use/);
    expect((await p.status()).connected).toBe(false);
    expect(updates[0]!['status']).toBe('error');
    expect(String(updates[0]!['error'])).toMatch(/already in use/);
    expect(fs.existsSync(realConfigPath(profile.id))).toBe(false);
  });

  it('carries the core’s own dying words into the failure, never a bare port message', async () => {
    h.spawnCoreProcess.mockResolvedValue({
      ok: false,
      failure: 'exited',
      error: 'sing-box exited during startup (code 1) — FATAL failed to decode config: unknown outbound type',
      output: 'FATAL failed to decode config: unknown outbound type\n',
      exitCode: 1,
    });
    const { p, profile, updates } = await providerWithProfile();

    await expect(p.connect(profile)).rejects.toThrow(/did not come up: sing-box exited during startup \(code 1\)/);
    expect(String(updates[0]!['error'])).toMatch(/unknown outbound type/);
    expect(fs.existsSync(realConfigPath(profile.id))).toBe(false);
  });

  it('keeps its own wording for a bring-up that simply never answered', async () => {
    h.spawnCoreProcess.mockResolvedValue({
      ok: false,
      failure: 'timeout',
      error: `local proxy port ${MIXED_PORT} never opened in 4000ms`,
      output: '',
      exitCode: null,
    });
    const { p, profile } = await providerWithProfile();

    await expect(p.connect(profile)).rejects.toThrow(new RegExp(`local proxy port ${MIXED_PORT} never opened`));
  });

  it('reports a missing binary as such, never as a proxy port that never opened', async () => {
    h.spawnCoreProcess.mockResolvedValue({
      ok: false,
      failure: 'spawn_error',
      error: 'sing-box spawn failed: ENOENT',
      output: '',
      exitCode: null,
    });
    const { p, profile } = await providerWithProfile();

    await expect(p.connect(profile)).rejects.toThrow(/ENOENT/);
  });

  it('reports the process as gone when sing-box exits after a successful start', async () => {
    const child = fakeChild();
    h.spawnCoreProcess.mockResolvedValue({
      ok: true,
      process: { child, readyPort: MIXED_PORT, output: '', cleanup: vi.fn() },
    });
    const { p, profile } = await providerWithProfile();
    await p.connect(profile);
    expect((await p.status()).connected).toBe(true);

    child.exitCode = 1;
    child.emit('close');

    expect((await p.status()).connected).toBe(false);
    expect((await p.status()).since).toBeNull();
  });
});
