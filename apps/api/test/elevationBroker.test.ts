import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RealtimeBus } from '../src/realtime/bus';
import { ElevationBroker, ELEVATION_TTL_MS } from '../src/vpn/elevationBroker';

import type { Logger } from '../src/logger';

/* Real entry points under test: the two endpoints the Rust bridge calls
 * (fetchForBridge / resolveFromBridge) plus the connect flow's wait().
 * Focus: nonce binding, single-use, TTL, allow-listed descriptors, and the
 * path/hash containment that keeps the privileged launch honest. */

const tmpDirs: string[] = [];

function makeDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-elev-'));
  tmpDirs.push(dir);
  return dir;
}

function makeBroker(dataDir = makeDataDir()) {
  const bus = new RealtimeBus();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const broker = new ElevationBroker({ appDataDir: dataDir, bus, log });
  return { broker, dataDir };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ElevationBroker', () => {
  it('registers an op with a nonce and serves the descriptor to the nonce-holder', () => {
    const { broker, dataDir } = makeBroker();
    const configPath = path.join(dataDir, 'vpn-profiles', 'tmp', 'netpulse-wg-x.conf');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '[Interface]\nPrivateKey = AAA');

    const reg = broker.registerWireGuardInstall({ opId: crypto.randomUUID(), configPath });
    const descriptor = broker.fetchForBridge(reg.opId, reg.nonce);

    expect(descriptor.action).toBe('wireguard-install-tunnel');
    expect(descriptor.exe).toMatch(/wireguard\.exe$/i);
    expect(descriptor.args[0]).toBe('/installtunnelservice');
    expect(descriptor.args[1]).toBe(configPath);
    expect(descriptor.configSha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex'));
    // the descriptor never contains config contents or key material
    expect(JSON.stringify(descriptor)).not.toContain('PrivateKey');
  });

  it('rejects descriptor fetches with a missing or wrong nonce', () => {
    const { broker, dataDir } = makeBroker();
    const configPath = path.join(dataDir, 'a.conf');
    fs.writeFileSync(configPath, 'x');
    const reg = broker.registerWireGuardInstall({ opId: 'op-1', configPath });

    expect(() => broker.fetchForBridge(reg.opId, null)).toThrow();
    expect(() => broker.fetchForBridge(reg.opId, '0'.repeat(48))).toThrow(/nonce/i);
    // the correct nonce still works after failed attempts
    expect(broker.fetchForBridge(reg.opId, reg.nonce).action).toBe('wireguard-install-tunnel');
  });

  it('refuses unknown opIds', () => {
    const { broker } = makeBroker();
    expect(() => broker.fetchForBridge('does-not-exist', '0'.repeat(48))).toThrow(/pending/i);
  });

  it('rejects configs outside the app data dir and non-.conf paths', () => {
    const { broker } = makeBroker();
    const outside = path.join(os.tmpdir(), 'evil.conf');
    fs.writeFileSync(outside, 'x');
    try {
      expect(() => broker.registerWireGuardInstall({ opId: 'op-2', configPath: outside })).toThrow(/outside/i);
      expect(() => broker.registerWireGuardInstall({ opId: 'op-3', configPath: 'relative/path.txt' })).toThrow();
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('refuses registration when no allow-listed wireguard.exe exists (test env)', () => {
    // In the CI/test environment wireguard.exe may exist; if it does, this
    // test is vacuously satisfied by the registration above. Only assert when
    // the allow-list is empty on this machine.
    const installed = ['C:\\Program Files\\WireGuard\\wireguard.exe', 'C:\\Program Files (x86)\\WireGuard\\wireguard.exe'].some((p) => fs.existsSync(p));
    if (installed) return; // skip honestly: allow-list is populated here
    const { broker, dataDir } = makeBroker();
    const configPath = path.join(dataDir, 'a.conf');
    fs.writeFileSync(configPath, 'x');
    expect(() => broker.registerWireGuardInstall({ opId: 'op-4', configPath })).toThrow(/WireGuard is not installed/i);
  });

  it('wait() honors a custom timeout and reports expiry honestly', async () => {
    const { broker, dataDir } = makeBroker();
    const configPath = path.join(dataDir, 'a.conf');
    fs.writeFileSync(configPath, 'x');
    broker.registerWireGuardInstall({ opId: 'op-5', configPath });
    const waitPromise = broker.wait('op-5', 50);
    await expect(waitPromise).resolves.toMatchObject({ ok: false, declined: false, source: 'expired' });
    // the op is gone afterwards
    await expect(broker.wait('op-5', 50)).resolves.toMatchObject({ source: 'unknown-op' });
  });

  it('sweep on registration fails expired ops and resolves their waiters', async () => {
    const { broker, dataDir } = makeBroker();
    const configPath = path.join(dataDir, 'a.conf');
    fs.writeFileSync(configPath, 'x');
    const reg = broker.registerWireGuardInstall({ opId: 'op-5b', configPath });
    const waitPromise = broker.wait(reg.opId);
    // Force expiry, then trigger a sweep via a second registration.
    (broker as unknown as { pending: Map<string, { expiresAt: number }> }).pending.get(reg.opId)!.expiresAt = Date.now() - 1;
    fs.writeFileSync(configPath, 'x2');
    broker.registerWireGuardInstall({ opId: 'op-5c', configPath });
    await expect(waitPromise).resolves.toMatchObject({ ok: false, declined: false, source: 'expired' });
    // expired ops cannot be fetched by the bridge even with the right nonce
    expect(() => broker.fetchForBridge(reg.opId, reg.nonce)).toThrow(/pending|expired/i);
  });

  it('wait() resolves with the bridge outcome exactly once (single-use)', async () => {
    const { broker, dataDir } = makeBroker();
    const configPath = path.join(dataDir, 'a.conf');
    fs.writeFileSync(configPath, 'x');
    const reg = broker.registerWireGuardInstall({ opId: 'op-6', configPath });
    const waitPromise = broker.wait(reg.opId);

    expect(broker.resolveFromBridge(reg.opId, reg.nonce, { ok: true, error: null })).toBe(true);
    await expect(waitPromise).resolves.toMatchObject({ ok: true, declined: false, source: 'bridge' });
    // second resolve: no-op, no crash
    expect(broker.resolveFromBridge(reg.opId, reg.nonce, { ok: false, error: 'late' })).toBe(false);
  });

  it('rejects bridge results with a wrong nonce (op stays pending for the real bridge)', async () => {
    const { broker, dataDir } = makeBroker();
    const configPath = path.join(dataDir, 'a.conf');
    fs.writeFileSync(configPath, 'x');
    const reg = broker.registerWireGuardInstall({ opId: 'op-7', configPath });
    const waitPromise = broker.wait(reg.opId);

    expect(broker.resolveFromBridge(reg.opId, 'wrong-nonce-wrong-nonce', { ok: true, error: null })).toBe(false);
    // the real bridge can still land the result
    expect(broker.resolveFromBridge(reg.opId, reg.nonce, { ok: true, error: null })).toBe(true);
    await expect(waitPromise).resolves.toMatchObject({ ok: true });
  });

  it('marks declined outcomes when the bridge reports ELEVATION_DECLINED', async () => {
    const { broker, dataDir } = makeBroker();
    const configPath = path.join(dataDir, 'a.conf');
    fs.writeFileSync(configPath, 'x');
    const reg = broker.registerWireGuardInstall({ opId: 'op-8', configPath });
    const waitPromise = broker.wait(reg.opId);
    broker.resolveFromBridge(reg.opId, reg.nonce, { ok: false, error: 'ELEVATION_DECLINED: The user declined the elevation prompt' });
    await expect(waitPromise).resolves.toMatchObject({ ok: false, declined: true });
  });

  it('refreshDescriptorHash re-hashes after the config changes', () => {
    const { broker, dataDir } = makeBroker();
    const configPath = path.join(dataDir, 'vpn-profiles', 'tmp', 'netpulse-wg-y.conf');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'version-1');
    const reg = broker.registerWireGuardInstall({ opId: 'op-9', configPath });
    const hash1 = broker.fetchForBridge(reg.opId, reg.nonce).configSha256;
    fs.writeFileSync(configPath, 'version-2-with-more-content');
    broker.refreshDescriptorHash(reg.opId, reg.nonce);
    const hash2 = broker.fetchForBridge(reg.opId, reg.nonce).configSha256;
    expect(hash2).not.toBe(hash1);
    expect(hash2).toBe(crypto.createHash('sha256').update('version-2-with-more-content').digest('hex'));
  });

  it('declares the constant TTL sane (2 minutes, not zero)', () => {
    expect(ELEVATION_TTL_MS).toBeGreaterThanOrEqual(60_000);
    expect(ELEVATION_TTL_MS).toBeLessThanOrEqual(600_000);
  });
});
