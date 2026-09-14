/**
 * Live engine success-path proof: runs the REAL proxyProbeWithEngine (the
 * exact function the sidecar's node test route calls) against a loopback
 * xray ss-server, tunneling a real HTTPS request end-to-end:
 *
 *   probe → xray client (mixed inbound on ephemeral port)
 *         → CONNECT httpbin.org:443 through the tunnel
 *         → ss encryption → loopback ss-server (real xray, freedom outbound)
 *         → Internet → 200 OK
 *
 * The app's API cannot target loopback nodes because validateNodeHost
 * deliberately refuses private hosts (SSRF guard) — this script bypasses
 * only that import guard, not any engine code.
 *
 * Run: npx tsx scripts/tmp-engine-live.ts
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { proxyProbeWithEngine } from '../apps/api/src/services/proxyEngineRunner';
import { findEngineBinary } from '../apps/api/src/services/proxyCores';

import type { ParsedNodeConfig } from '@netpulse/shared';

const PW = 'np-loopback-test-pw-0123456789abcdef';
const SERVER_PORT = 18443;

async function main(): Promise<void> {
  const xray = findEngineBinary('xray');
  if (!xray) {
    console.log('FAIL: xray binary not found in cores dir');
    process.exit(1);
  }
  console.log(`xray binary: ${xray}`);

  // 1. Real xray ss-server on loopback
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-engine-live-'));
  const serverConfig = path.join(tmp, 'server.json');
  fs.writeFileSync(
    serverConfig,
    JSON.stringify({
      log: { loglevel: 'warning' },
      inbounds: [
        {
          port: SERVER_PORT,
          protocol: 'shadowsocks',
          settings: { method: 'chacha20-ietf-poly1305', password: PW },
        },
      ],
      outbounds: [{ protocol: 'freedom', settings: {} }],
    }),
  );
  const server = spawn(xray, ['run', '-c', serverConfig], { stdio: 'ignore' });
  try {
    const up = await waitForPort(SERVER_PORT, 10_000);
    if (!up) {
      console.log('FAIL: local ss-server did not start');
      process.exit(1);
    }
    console.log(`ss-server listening on 127.0.0.1:${SERVER_PORT}`);

    // 2. The node config a user's v2ray source would carry (loopback here)
    const config: ParsedNodeConfig = {
      protocol: 'shadowsocks',
      host: '127.0.0.1',
      port: SERVER_PORT,
      transport: 'tcp',
      security: 'none',
      encryption: 'chacha20-ietf-poly1305',
    };

    // 3. Real engine probe — xray client spawn, config gen, CONNECT tunnel
    const result = await proxyProbeWithEngine(config, {
      secret: PW,
      // NP_ENGINE_PREFERRED=sing-box exercises the sing-box client core too
      preferred: (process.env['NP_ENGINE_PREFERRED'] as 'auto' | 'xray' | 'sing-box') ?? 'auto',
      testUrl: 'https://httpbin.org/ip',
      timeoutMs: 25_000,
    });

    console.log('engine:', result.engine);
    console.log('status:', result.status);
    console.log('latencyMs:', result.latencyMs);
    console.log('httpStatus:', result.httpStatus);
    console.log('tlsVersion:', result.tlsVersion);
    console.log('failureKind:', result.failureKind ?? 'none');
    console.log('error:', result.error ?? 'none');
    const success = result.status === 'done' && result.httpStatus === 200 && result.engine !== null;
    console.log(success ? `RESULT: SUCCESS — full encrypted round-trip through real ${result.engine}` : 'RESULT: FAILED');
    process.exit(success ? 0 : 1);
  } finally {
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = (): void => {
      const s = net.connect({ host: '127.0.0.1', port, timeout: 800 });
      s.on('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => {
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tryOnce, 300);
      });
      s.on('timeout', () => {
        s.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

void main();
