import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';

import {
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
