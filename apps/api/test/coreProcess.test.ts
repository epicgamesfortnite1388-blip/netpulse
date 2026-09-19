import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { portIsFree, reservePort, spawnCoreProcess } from '../src/services/coreProcess';

/**
 * The one owner of the local-core lifecycle. These tests drive REAL processes
 * (this file's own node binary) rather than fakes, because the contract is
 * about what happens to a process and its credential-bearing config dir:
 *
 *   - ready means the inbound answers, and nothing else
 *   - a failed start leaves no child behind and no temp dir
 *   - the output tail is bounded, and it is what explains a startup failure
 *   - a port taken after reservation is its own failure, never blamed on the
 *     node or mistaken for readiness
 */

const NODE_BIN = process.execPath;

/** A script that answers on `port` and stays alive, like a core's inbound. */
function listenScript(port: number): string {
  return `require('net').createServer((s) => s.end()).listen(${port}, '127.0.0.1')`;
}

function tempDirForConfig(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-core-test-'));
}

describe('spawnCoreProcess', () => {
  it('resolves once the inbound answers, then kills the child and removes the config dir', async () => {
    const port = await reservePort();
    const tempDir = tempDirForConfig();
    fs.writeFileSync(path.join(tempDir, 'core.json'), '{"secret":"node-password"}');

    const started = await spawnCoreProcess({
      bin: NODE_BIN,
      args: ['-e', listenScript(port)],
      readyPort: port,
      readyTimeoutMs: 5_000,
      tempDir,
      label: 'core',
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(fs.existsSync(tempDir)).toBe(true); // the core needs it while running

    started.process.cleanup();
    expect(started.process.child.killed).toBe(true);
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it('reports a process that dies during startup with its own words', async () => {
    const port = await reservePort();
    const tempDir = tempDirForConfig();

    const started = await spawnCoreProcess({
      bin: NODE_BIN,
      args: ['-e', "console.log('FATAL: unknown cipher method: aes-256-cfb'); process.exit(23)"],
      readyPort: port,
      readyTimeoutMs: 5_000,
      tempDir,
      label: 'core',
    });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.failure).toBe('exited');
    expect(started.exitCode).toBe(23);
    // The core's own error line, not a generic message.
    expect(started.error).toContain('unknown cipher method');
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it('times out a core that stays alive without answering, and cleans it up', async () => {
    const port = await reservePort();
    const tempDir = tempDirForConfig();

    const started = await spawnCoreProcess({
      bin: NODE_BIN,
      args: ['-e', 'setTimeout(() => {}, 30_000)'],
      readyPort: port,
      readyTimeoutMs: 900,
      tempDir,
      label: 'core',
    });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.failure).toBe('timeout');
    expect(started.error).toMatch(/did not become ready in 900ms/);
    // No zombie and no leaked config.
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it('uses the caller’s timeout sentence when one is given, so the hint survives', async () => {
    const port = await reservePort();
    const started = await spawnCoreProcess({
      bin: NODE_BIN,
      args: ['-e', 'setTimeout(() => {}, 30_000)'],
      readyPort: port,
      readyTimeoutMs: 900,
      label: 'TUN gateway',
      timeoutMessage: (ms, output) => `${output || ''} no device in ${ms}ms (device creation may be blocked)`,
    });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error).toContain('device creation may be blocked');
    expect(started.error).toContain('900ms');
  });

  it('classifies an unexecutable binary as a spawn error, not a node failure', async () => {
    const port = await reservePort();
    const started = await spawnCoreProcess({
      bin: 'definitely-not-a-real-core-binary-xyz',
      args: ['run'],
      readyPort: port,
      readyTimeoutMs: 2_000,
      label: 'core',
    });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.failure).toBe('spawn_error');
    expect(started.error).toMatch(/core spawn failed/);
  });

  it('refuses a port something else already answers on, without spawning anything', async () => {
    const net = await import('node:net');
    const squatter = net.createServer();
    const port: number = await new Promise((resolve) => {
      squatter.listen(0, '127.0.0.1', () => resolve((squatter.address() as net.AddressInfo).port));
    });
    const tempDir = tempDirForConfig();
    const spawnFn = vi.fn();

    try {
      const started = await spawnCoreProcess({
        bin: NODE_BIN,
        args: ['-e', listenScript(port)],
        readyPort: port,
        readyTimeoutMs: 2_000,
        tempDir,
        label: 'core',
        spawnFn: spawnFn as never,
      });

      // The squatter's answer must never be read as our core being ready.
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.failure).toBe('port_clash');
      expect(started.error).toContain(`port ${port}`);
      expect(spawnFn).not.toHaveBeenCalled();
      // The config dir holds the node's credentials, so a refusal that never
      // spawned still removes it.
      expect(fs.existsSync(tempDir)).toBe(false);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it('keeps only a bounded tail of a chatty core’s output', async () => {
    const port = await reservePort();
    const started = await spawnCoreProcess({
      bin: NODE_BIN,
      args: [
        '-e',
        `process.stdout.write('y'.repeat(6000)); ${listenScript(port)}`,
      ],
      readyPort: port,
      readyTimeoutMs: 5_000,
      label: 'core',
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.process.output.length).toBeLessThanOrEqual(2_000);
    expect(started.process.output.endsWith('y')).toBe(true); // the TAIL, not the head
    started.process.cleanup();
  });

  it('is safe to clean up twice', async () => {
    const port = await reservePort();
    const started = await spawnCoreProcess({
      bin: NODE_BIN,
      args: ['-e', listenScript(port)],
      readyPort: port,
      readyTimeoutMs: 5_000,
      label: 'core',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    started.process.cleanup();
    expect(() => started.process.cleanup()).not.toThrow();
  });
});

describe('portIsFree', () => {
  it('is false while a listener holds the port and true after it closes', async () => {
    const net = await import('node:net');
    const srv = net.createServer();
    const port: number = await new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port));
    });
    expect(await portIsFree(port)).toBe(false);
    await new Promise((resolve) => srv.close(resolve));
    expect(await portIsFree(port)).toBe(true);
  });

  it('reserves distinct free ports', async () => {
    const [a, b] = await Promise.all([reservePort(), reservePort()]);
    expect(a).not.toBe(b);
  });
});
