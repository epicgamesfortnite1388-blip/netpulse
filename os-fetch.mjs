import { spawnSync } from 'node:child_process';
import { registry } from './capture.mjs';

const EVIDENCE = 'C:/Users/RADIN/AppData/Local/Temp/netpulse-vpnproof/evidence';

/**
 * Fetch the exit trace the way a real OS client would: read the HKCU system
 * proxy (same helper the evidence captures use — this file's own inline
 * PowerShell reader ate its backslashes and always reported "no proxy"), then
 * fetch https://www.cloudflare.com/cdn-cgi/trace through it with curl.
 *
 * - `-x http://<reg proxy>` overrides _curlrc's stale 127.0.0.1:10809 entry.
 * - `-k`: the hermetic proof endpoint (traceBoth) serves a self-signed
 *   CN=www.cloudflare.com cert; TLS trust is not what this step proves.
 */
export async function osFetchThroughProxy() {
  const reg = registry();
  if (reg.proxyEnable !== 1 || !reg.proxyServer) {
    return { viaProxy: null, registry: reg, note: 'no system proxy active (ProxyEnable=0 or ProxyServer empty)' };
  }
  const proxy = reg.proxyServer;
  const started = Date.now();
  const target = 'https://www.cloudflare.com/cdn-cgi/trace';
  const r = spawnSync('curl.exe', ['-s', '-k', '--max-time', '12', '-x', 'http://' + proxy, target], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024,
    windowsHide: true,
  });
  const elapsedMs = Date.now() - started;
  if (r.error) {
    return { viaProxy: proxy, registry: reg, ip: null, loc: null, note: 'spawn failed: ' + r.error.message };
  }
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
  const ip = (out.match(/^ip=(.*)$/m) || [])[1] ?? null;
  const fl = (out.match(/^fl=(.*)$/m) || [])[1] ?? null;
  const loc = (out.match(/^loc=(.*)$/m) || [])[1] ?? null;
  if (!ip) {
    return { viaProxy: proxy, registry: reg, ip: null, loc: null, fl, elapsedMs, curlExit: r.status, note: (out.slice(0, 200) || 'empty response') };
  }
  return { viaProxy: proxy, registry: reg, ip, fl, loc, elapsedMs, curlExit: r.status, raw: out.slice(0, 300) };
}
