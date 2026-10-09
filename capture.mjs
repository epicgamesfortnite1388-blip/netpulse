import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const VPROOT = 'C:/Users/RADIN/AppData/Local/Temp/netpulse-vpnproof';
const EVIDENCE = VPROOT + '/evidence';
const { token, api_base } = JSON.parse(readFileSync(EVIDENCE + '/g4-boot.json', 'utf8'));
const AUTH = 'Bearer ' + token;

async function http(method, path, body) {
  const url = api_base + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, {
      method: method.toUpperCase(),
      headers: { authorization: AUTH, 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: resp.status, timeMs: 0, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function get(path) { return http('GET', path); }
async function post(path, body) { return http('POST', path, body); }

function registry() {
  const tmp = EVIDENCE + '/.reg-ps.ps1';
  const psPath = 'HKCU:\\\\\Software\\\\\\Microsoft\\\\\\Windows\\\\\\CurrentVersion\\\\\\Internet Settings';
  const script = '[PSCustomObject]@{ ProxyEnable = (Get-ItemProperty "' + psPath + '" -Name ProxyEnable -EA SilentlyContinue).ProxyEnable; ProxyServer = (Get-ItemProperty "' + psPath + '" -Name ProxyServer -EA SilentlyContinue).ProxyServer } | ConvertTo-Json';
  writeFileSync(tmp, script, 'utf8');
  let out;
  try {
    out = execSync('powershell -NoProfile -File "' + tmp + '"', { encoding: 'utf8', timeout: 10000 }).toString().trim();
  } catch (e) {
    return { proxyEnable: 0, proxyServer: null };
  }
  try {
    const obj = JSON.parse(out);
    const pe = obj.ProxyEnable;
    const ps = obj.ProxyServer;
    return {
      proxyEnable: (pe === 1 || pe === true) ? 1 : 0,
      proxyServer: (ps !== null && ps !== undefined) ? ps : null
    };
  } catch {
    return { proxyEnable: 0, proxyServer: null };
  }
}

function listeningPorts() {
  const out = execSync('netstat -ano 2>&1', { encoding: 'utf8' });
  const ports = [];
  for (const line of out.trim().split('\n')) {
    const m = line.match(/:\s*(\d+)\s.*?LISTENING\s+(\d+)/);
    if (m) ports.push({ port: parseInt(m[1]), pid: parseInt(m[2]) });
  }
  return ports;
}

function xrayProcs() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq xray.exe" /FO CSV /NH 2>&1', { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map(line => {
      const m = line.match(/"([^"]*)"?\s*,\s*"?(\d+)"?/);
      return m ? { name: m[1].trim(), pid: parseInt(m[2]) } : null;
    }).filter(Boolean);
  } catch { return []; }
}

async function killswitchState() {
  try {
    const r = await get('/vpn/killswitch');
    return r.body?.killSwitch ?? null;
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

async function capture(name, extra) {
  const t = Date.now();
  const reg = registry();
  const ports = listeningPorts();
  const xray = xrayProcs();
  const status = await get('/vpn/tunnel/status');
  const ks = await killswitchState();
  const o = {
    capturedAt: t,
    registry: reg,
    listeningPorts: ports,
    xrayProcs: xray,
    tunnel: status.body?.tunnel ?? null,
    killswitch: ks,
    httpStatus: status.status,
    httpTimeMs: status.timeMs,
    ...extra
  };
  writeFileSync(EVIDENCE + '/g4-' + name + '.json', JSON.stringify(o, null, 2));
  return o;
}

export { capture, get, post, registry, killswitchState, token, api_base };
