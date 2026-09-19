import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';

/**
 * The provider's bring-up goes through the shared core-process owner
 * (./coreProcess) — the same spawn/readiness/cleanup path the local cores use.
 * Only the OWNER is faked here; everything else in connect (settings, argv,
 * the SOCKS5 relay check, exit-IP proof) is real, so these tests say what
 * actually happens when the owner answers ok or refuses.
 */
const h = vi.hoisted(() => ({
  spawnCoreProcess: vi.fn(),
}));

vi.mock('../src/services/coreProcess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/coreProcess')>();
  return { ...actual, spawnCoreProcess: h.spawnCoreProcess };
});

import {
  AetherProvider,
  aetherFlagsFor,
  buildAetherArgs,
  fetchExitIpThroughSocks,
  parseAetherSettings,
  socks5Connect,
  socks5RelayCheck,
  DEFAULT_AETHER_SETTINGS,
} from '../src/vpn/aetherProvider';

/**
 * Aether provider contracts:
 *   - settings parsing is defensive (corrupt → defaults, junk values rejected)
 *   - CLI flags map 1:1 onto the real binary's documented interface
 *   - the SOCKS5 client completes a real handshake against a real in-process
 *     SOCKS5 server and fails against garbage
 *   - exit-IP proof only claims an IP when the response actually carried one
 */

let servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

/* ------------------- connect + the shared process owner ------------------- */

/** A ChildProcess-shaped stand-in: the provider only ever calls these. */
function fakeChild(): EventEmitter & { kill: () => boolean; exitCode: number | null; pid: number } {
  const child = new EventEmitter() as EventEmitter & { kill: () => boolean; exitCode: number | null; pid: number };
  child.kill = vi.fn(() => true);
  child.exitCode = null;
  child.pid = 4242;
  return child;
}

const PROFILE = {
  id: 'aether-1',
  name: 'Aether live',
  protocol: 'aether',
  endpoint: null,
  publicKeyFingerprint: null,
  allowedIps: null,
  dns: null,
  secretRef: 'aether-secret',
  configPath: '/x',
  createdAt: Date.now(),
} as const;

/**
 * A provider whose binary is "installed" and whose vault returns no settings,
 * with hooks that record what the provider told the connection log.
 */
function provider(opts: { bindPort: number }) {
  const records: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const p = new AetherProvider(
    { get: () => null } as never,
    os.tmpdir(),
    {
      recordConnection: (rec: Record<string, unknown>) => records.push(rec),
      updateConnection: (_id: string, patch: Record<string, unknown>) => updates.push(patch),
    } as never,
    { bindPort: opts.bindPort },
  );
  // `available` is set by init() from a real `-v` self-check; the install path
  // is covered elsewhere, so stand it up directly here.
  (p as unknown as { available: boolean }).available = true;
  return { p, records, updates };
}

beforeEach(() => {
  h.spawnCoreProcess.mockReset();
});

describe('aether connect through the shared core-process owner', () => {
  it('starts the binary through the owner, proves the relay, and adopts the child', async () => {
    const port = await startFakeSocks({ replyOk: true, httpBody: '{"ip":"203.0.113.7"}' });
    const child = fakeChild();
    const cleanup = vi.fn();
    h.spawnCoreProcess.mockResolvedValue({
      ok: true,
      process: { child, readyPort: port, output: '', cleanup },
    });
    const { p, updates } = provider({ bindPort: port });

    const status = await p.connect({ ...PROFILE });

    // One spawn, through the owner, with Aether's own long bring-up budget.
    expect(h.spawnCoreProcess).toHaveBeenCalledTimes(1);
    const spec = h.spawnCoreProcess.mock.calls[0]![0] as Record<string, unknown>;
    expect(spec['bin']).toMatch(/aether(\.exe)?$/);
    expect((spec['args'] as string[]).join(' ')).toContain(`127.0.0.1:${port}`);
    expect(spec['readyPort']).toBe(port);
    expect(spec['readyTimeoutMs']).toBe(120_000);
    expect(spec['label']).toBe('Aether');

    // The relay check and the exit-IP proof are real, so `verified` means it.
    expect(status.connected).toBe(true);
    expect(status.verification).toBe('verified');
    expect(status.verifiedPublicIp).toBe('203.0.113.7');
    expect(updates.some((u) => u['status'] === 'connected')).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();

    await p.disconnect();
    expect(child.kill).toHaveBeenCalled();
  });

  it('reports a port that is already in use instead of waiting and blaming the tunnel', async () => {
    const child = fakeChild();
    h.spawnCoreProcess.mockResolvedValue({
      ok: false,
      failure: 'port_clash',
      error: `port 1819 is already in use — the Aether was not spawned`,
      output: '',
      exitCode: null,
    });
    const { p, updates } = provider({ bindPort: 1819 });

    await expect(p.connect({ ...PROFILE })).rejects.toThrow(/already in use/);
    expect((await p.status()).connected).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    expect(updates[0]!['status']).toBe('error');
    expect(String(updates[0]!['error'])).toMatch(/already in use/);
  });

  it('keeps its own wording for a bring-up that simply never answered', async () => {
    h.spawnCoreProcess.mockResolvedValue({
      ok: false,
      failure: 'timeout',
      error: 'Aether did not become ready in 120000ms',
      output: '',
      exitCode: null,
    });
    const { p } = provider({ bindPort: 1819 });

    await expect(p.connect({ ...PROFILE })).rejects.toThrow(/SOCKS5 port 1819 never opened/);
  });

  it('prefers the binary’s own words when it explained itself', async () => {
    h.spawnCoreProcess.mockResolvedValue({
      ok: false,
      failure: 'exited',
      error: 'Aether exited during startup (code 1) — no output',
      output: 'starting\npanic: no usable route to the outside\n',
      exitCode: 1,
    });
    const { p, updates } = provider({ bindPort: 1819 });

    await expect(p.connect({ ...PROFILE })).rejects.toThrow(/panic: no usable route/);
    expect(String(updates[0]!['error'])).toMatch(/panic: no usable route/);
  });

  it('reports a missing binary as such, never as a tunnel that never opened', async () => {
    h.spawnCoreProcess.mockResolvedValue({
      ok: false,
      failure: 'spawn_error',
      error: 'Aether spawn failed: ENOENT',
      output: '',
      exitCode: null,
    });
    const { p } = provider({ bindPort: 1819 });

    await expect(p.connect({ ...PROFILE })).rejects.toThrow(/ENOENT/);
  });

  it('tears the process down when the port answers but nothing relays', async () => {
    // A port that accepts TCP but is not a SOCKS5 proxy: the readiness step is
    // satisfied, the relay proof is not. A started process is not a tunnel.
    const port = await startFakeSocks({ replyOk: false, httpBody: '' });
    const cleanup = vi.fn();
    h.spawnCoreProcess.mockResolvedValue({
      ok: true,
      process: { child: fakeChild(), readyPort: port, output: '', cleanup },
    });
    const { p, updates } = provider({ bindPort: port });

    await expect(p.connect({ ...PROFILE })).rejects.toThrow(/not relaying/);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((await p.status()).connected).toBe(false);
    expect(updates[0]!['status']).toBe('error');
  }, 20_000);
});

/** Minimal in-process SOCKS5 (no-auth) server that also answers HTTP. */
function startFakeSocks(opts: { replyOk: boolean; httpBody: string }): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let stage: 'greeting' | 'connect' | 'http' = 'greeting';
      sock.on('data', (chunk: Buffer) => {
        if (stage === 'greeting') {
          sock.write(Buffer.from([0x05, 0x00]));
          stage = 'connect';
        } else if (stage === 'connect') {
          sock.write(Buffer.from([0x05, opts.replyOk ? 0x00 : 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          stage = 'http';
        } else if (stage === 'http' && opts.replyOk) {
          sock.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${opts.httpBody}`);
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      servers.push({ close: () => srv.close() });
      resolve(addr.port);
    });
  });
}

describe('aether TUN status mapping', () => {
  it('claims no capture until it is requested, then reports `requested`', async () => {
    // TUN is a preference here; the shared gateway handle owns the state. A
    // preference that has not been attempted must never read as a capture.
    const provider = new AetherProvider({} as never, os.tmpdir());
    expect((await provider.status()).tun).toBeNull();

    provider.setTunPreference(true);
    const requested = await provider.status();
    expect(requested.tun).toBe('requested');
    expect(requested.tunBlockedBy).toBeNull();

    provider.setTunPreference(false);
    // Off means no TUN claim at all — not a stale reason from a past attempt.
    const off = await provider.status();
    expect(off.tun).toBeNull();
    expect(off.tunError).toBeNull();
  });
});

describe('aether settings', () => {
  it('null/empty input yields defaults', () => {
    expect(parseAetherSettings(null)).toEqual(DEFAULT_AETHER_SETTINGS);
    expect(parseAetherSettings('not json')).toEqual(DEFAULT_AETHER_SETTINGS);
  });

  it('junk enum values fall back instead of reaching the CLI', () => {
    const s = parseAetherSettings(JSON.stringify({ protocol: 'tor', scanMode: 'warp-speed', noize: 'mega' }));
    expect(s.protocol).toBe('masque');
    expect(s.scanMode).toBe('balanced');
    expect(s.noize).toBe('default');
  });

  it('valid settings round-trip', () => {
    const raw = JSON.stringify({ protocol: 'gool', scanMode: 'ironclad', transport: 'h2', ipVersion: 'both', noize: 'gfw', quickReconnect: false });
    expect(parseAetherSettings(raw)).toEqual({ protocol: 'gool', scanMode: 'ironclad', transport: 'h2', ipVersion: 'both', noize: 'gfw', quickReconnect: false });
  });
});

describe('aether argv', () => {
  it('binds loopback only with its own identity config', () => {
    const args = buildAetherArgs({ bindPort: 1819, configDir: 'D:/data/aether', profileArgs: [] });
    expect(args).toContain('--bind');
    expect(args).toContain('127.0.0.1:1819');
    expect(args.join(' ')).toMatch(/aether\.toml/);
  });

  it('flags map onto the documented CLI', () => {
    const args = aetherFlagsFor({ protocol: 'wg', scanMode: 'thorough', transport: 'h2', ipVersion: 'both', noize: 'gfw', quickReconnect: false });
    expect(args).toContain('--wg');
    expect(args).toContain('--h2');
    expect(args.join(' ')).toContain('--scan thorough');
    expect(args).toContain('--dual');
    expect(args.join(' ')).toContain('--noize gfw');
    expect(args).toContain('--no-quick-reconnect');
  });

  it('masque default flags omit optional switches', () => {
    const args = aetherFlagsFor({ ...DEFAULT_AETHER_SETTINGS });
    expect(args).toEqual(['--masque', '--scan', 'balanced']);
  });
});

describe('socks5 client', () => {
  it('completes handshake+relay against a working proxy', async () => {
    const port = await startFakeSocks({ replyOk: true, httpBody: '' });
    expect(await socks5RelayCheck(port)).toBe(true);
  });

  it('fails when the proxy refuses the CONNECT', async () => {
    const port = await startFakeSocks({ replyOk: false, httpBody: '' });
    expect(await socks5RelayCheck(port)).toBe(false);
  });

  it('fails against a non-SOCKS port', async () => {
    // plain HTTP server — its response will not look like a SOCKS5 greeting
    const srv = net.createServer((sock) => sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const addr = srv.address() as net.AddressInfo;
    servers.push({ close: () => srv.close() });
    expect(await socks5RelayCheck(addr.port)).toBe(false);
  });

  it('extracts the exit IP only from a real response body', async () => {
    const port = await startFakeSocks({ replyOk: true, httpBody: '{"ip":"203.0.113.7"}' });
    expect(await fetchExitIpThroughSocks(port)).toBe('203.0.113.7');
  });

  it('returns null when the body carries no IP', async () => {
    const port = await startFakeSocks({ replyOk: true, httpBody: '{"error":"nope"}' });
    expect(await fetchExitIpThroughSocks(port, 1_000)).toBeNull();
  }, 5_000);

  it('socks5Connect reaches the raw-socket stage with a hostname target', async () => {
    const port = await startFakeSocks({ replyOk: true, httpBody: '' });
    const conn = await socks5Connect(port, 'example.org', 80);
    expect(conn).not.toBeNull();
    conn?.socket.destroy();
  });
});
