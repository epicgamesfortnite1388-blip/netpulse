import { WebSocket } from 'ws';

const BASE = 'http://127.0.0.1:9222';
const sidecarPort = 47615;

// wait for CDP page target
async function waitForPageTarget() {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const list = await (await fetch(`${BASE}/json/list`)).json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
  }
  throw new Error('CDP page target never appeared');
}

// wait for sidecar port
async function waitForSidecar() {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const s = await fetch(`http://127.0.0.1:${sidecarPort}/api/v1/meta/health`, { method: 'GET', signal: AbortSignal.timeout(2000) });
      // 401 is fine — sidecar is up
      return true;
    } catch (e) {
      if (e instanceof Error && e.name === 'TimeoutError') continue;
      // connection refused -> not up yet
    }
  }
  throw new Error('sidecar never came up');
}

const pageTarget = await waitForPageTarget();
console.log('CDP page:', pageTarget.title, pageTarget.url);

const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
await new Promise(res => { ws.onopen = res; });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
  setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout '+method)); } }, 25000);
});
await send('Runtime.enable');

// wait for Tauri runtime to expose invoke
async function waitForInvoke() {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const v = await send('Runtime.evaluate', { expression: 'typeof window.__TAURI__.core.invoke', returnByValue: true });
      if (v.result.value === 'function') return true;
    } catch {}
  }
  throw new Error('core.invoke never became available');
}
await waitForInvoke();
console.log('core.invoke is available');

// grab bootstrap token
const boot = await send('Runtime.evaluate', {
  expression: '(()=>{ const inv = window.__TAURI__.core.invoke; return inv("bootstrap").then(b => ({token: b.token, api_base: b.api_base, ws_base: b.ws_base})); })()',
  returnByValue: true,
  awaitPromise: true,
}).then(r => r.result.value);
console.log('token:', boot.token.slice(0, 16) + '...' + boot.token.slice(-8));
console.log('api_base:', boot.api_base);
console.log('ws_base:', boot.ws_base);

// write to a file for the proof driver
const fs = await import('node:fs');
fs.writeFileSync('C:/Users/RADIN/AppData/Local/Temp/netpulse-vpnproof/evidence/g4-boot.json', JSON.stringify({
  appPid: 30524,
  cdpid: pageTarget.id,
  token: boot.token,
  api_base: boot.api_base,
  ws_base: boot.ws_base,
  bootTime: Date.now(),
}, null, 2));
console.log('wrote g4-boot.json');
ws.close();
