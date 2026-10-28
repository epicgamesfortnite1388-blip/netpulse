/**
 * Prove that what the Worker provisions is what the app can actually dial.
 *
 * The gap this closes: `POST /api/v1/provision` returns configs in the Worker's
 * own JSON shape, and the app converts them into sing-box outbounds before
 * importing. Unit tests cover the conversion and `sing-box check` covers
 * syntax, but neither proves the converted config reaches the real server. This
 * script runs the exact conversion the app uses against a real provision
 * response, then optionally connects through each protocol and reports the
 * egress address it observed.
 *
 * USAGE
 *   npx tsx scripts/proof-provision-import.ts --in provision.json [--out dir]
 *       [--run] [--singbox <path>] [--rewrite '{"xray-vmess-ws":"127.0.0.1:18443"}']
 *       [--expect <egress-ip>]
 *
 *   --in        the saved JSON body of a /api/v1/provision response
 *   --out       write the generated sing-box configs here (default: temp dir)
 *   --run       actually connect and check egress (default: check only)
 *   --rewrite   per-protocol `host:port` override, for testing over a tunnel
 *               (an SSH local forward to the node's loopback, for example)
 *   --expect    the egress address the tunnel should produce
 *
 * Exit codes: 0 every config converted and, with --run, carried traffic;
 * 1 a conversion or egress check failed; 2 the script could not run
 * (no input file, no sing-box binary).
 *
 * No credential is printed. The generated configs contain real per-user
 * credentials, so `--out` defaults to a private temp directory and the caller is
 * told where it is.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { toImportRequest } from '../packages/shared/src/cloud/provisionConfig';

type Provisioned = { name: string; protocol: string; config: string; id?: string };

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

async function main(): Promise<void> {
const inputPath = arg('--in');
if (!inputPath || !fs.existsSync(inputPath)) fail(2, 'usage: --in <provision.json> (the /api/v1/provision response body)');

const outDir = arg('--out') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'np-provision-proof-'));
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

const rewriteArg = arg('--rewrite');
const rewrite: Record<string, string> = rewriteArg
  ? (JSON.parse(fs.existsSync(rewriteArg) ? fs.readFileSync(rewriteArg, 'utf8') : rewriteArg) as Record<string, string>)
  : {};
const expectEgress = arg('--expect');
const shouldRun = process.argv.includes('--run');
const singbox = arg('--singbox') ?? 'sing-box';

const body = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as { provisioned?: Provisioned[] };
if (!Array.isArray(body.provisioned)) fail(2, 'input is not a /api/v1/provision response (missing `provisioned`)');

const results: Array<{ protocol: string; converted: boolean; reason?: string; checked: boolean; egress?: string | null }> = [];

for (const entry of body.provisioned) {
  const conversion = toImportRequest({ id: entry.id ?? '', name: entry.name, protocol: entry.protocol, config: entry.config });
  if (!conversion.ok) {
    results.push({ protocol: entry.protocol, converted: false, reason: conversion.reason, checked: false });
    console.log(`[SKIP] ${entry.protocol}: ${conversion.reason}`);
    continue;
  }

  const outbound = JSON.parse(conversion.request.configText) as Record<string, unknown>;
  const target = rewrite[entry.protocol];
  if (target) {
    const idx = target.lastIndexOf(':');
    outbound.server = target.slice(0, idx);
    outbound.server_port = Number(target.slice(idx + 1));
  }
  const socksPort = 21000 + results.length;
  const config = {
    log: { level: 'warn', timestamp: true },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: socksPort }],
    outbounds: [outbound],
    route: { auto_detect_interface: true },
  };
  const file = path.join(outDir, `${entry.protocol}.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });

  const check = spawnSync(singbox, ['check', '-c', file], { encoding: 'utf8' });
  const checked = check.status === 0;
  if (!checked) console.log(`[FAIL] ${entry.protocol}: sing-box rejected the config: ${(check.stderr || check.stdout).trim().slice(0, 300)}`);

  let egress: string | null = null;
  if (shouldRun && checked) {
    const child = spawn(singbox, ['run', '-c', file], { stdio: 'ignore', windowsHide: true });
    const started = Date.now();
    while (Date.now() - started < 3000) {
      const probe = spawnSync('curl.exe', ['-s', '--max-time', '8', '--socks5-hostname', `127.0.0.1:${socksPort}`, 'https://api.ipify.org'], { encoding: 'utf8' });
      if (probe.status === 0 && probe.stdout.trim()) {
        egress = probe.stdout.trim();
        break;
      }
      spawnSync(process.platform === 'win32' ? 'powershell' : 'sleep', process.platform === 'win32' ? ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400'] : ['0.4']);
    }
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }

  results.push({ protocol: entry.protocol, converted: true, checked, egress });
  const egressNote = shouldRun ? ` egress=${egress ?? 'none'}` : '';
  console.log(`[${checked ? 'OK' : 'FAIL'}] ${entry.protocol}${egressNote}`);
}

console.log(`\nconfigs: ${outDir}`);
if (shouldRun) {
  const bad = results.filter((r) => r.converted && (!r.checked || !r.egress || (expectEgress && r.egress !== expectEgress)));
  console.log(bad.length === 0 ? 'ALL PROVISIONED CONFIGS CONNECTED' : `${bad.length} protocol(s) did not reach the expected egress`);
  process.exit(bad.length === 0 ? 0 : 1);
}
const failed = results.filter((r) => r.converted && !r.checked);
process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('proof-provision-import failed:', err);
  process.exit(2);
});
