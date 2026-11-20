/**
 * NetPulse UI visual-QA harness (no new dependencies).
 *
 * Spawns a headless Microsoft Edge window, attaches over the Chrome DevTools
 * Protocol, and captures real rendered screenshots of the running app. This
 * mirrors scripts/lib/cdp-app.mjs (the repo's established CDP pattern): the
 * browser must be spawned from Node with `stdio: 'ignore'`, because launching a
 * GUI-subsystem .exe from a shell makes the shell exit immediately and the
 * browser is reaped. Node's global WebSocket (Node 22) drives CDP directly.
 *
 * Usage:
 *   node reports/ui-transformation/tools/cdp.mjs <config.json>
 *
 * config.json:
 *   {
 *     "port": 9444,
 *     "base": "http://localhost:5173",
 *     "out": "E:/.../screenshots",
 *     "prefix": "before",
 *     "width": 1440, "height": 900,
 *     "shots": [{ "name": "dashboard", "path": "/", "wait": 1800,
 *                 "theme": "dark", "js": "...", "waitAfterJs": 300,
 *                 "width": 1024, "height": 768 }]
 *   }
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const configPath = process.argv[2];
if (!configPath) {
  console.error('usage: node cdp.mjs <config.json>');
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const PORT = String(cfg.port || 9444);
const OUT = cfg.out;
const PROFILE = cfg.profile || path.resolve(process.cwd(), '../.ui-cdp-profile');
fs.mkdirSync(OUT, { recursive: true });

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const exe = cfg.browser || EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) throw new Error('no Chromium browser found');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(
  exe,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`,
    `--window-size=${cfg.width || 1440},${cfg.height || 900}`,
    cfg.base + '/',
  ],
  { stdio: 'ignore', detached: false, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` } },
);

async function targetList() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

let pageTarget = null;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const list = await targetList();
    pageTarget = list.find((t) => t.type === 'page' && t.url.startsWith('http')) ?? list.find((t) => t.type === 'page');
    if (pageTarget) break;
  } catch {
    /* browser still starting */
  }
  await sleep(500);
}
if (!pageTarget) {
  console.error('NO_PAGE_TARGET');
  browser.kill();
  process.exit(3);
}

const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const js = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

await send('Page.enable');
await send('Runtime.enable');

const results = [];
for (const shot of cfg.shots) {
  const width = shot.width || cfg.width || 1440;
  const height = shot.height || cfg.height || 900;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  // Full reload per route so each capture is a genuine cold render of that
  // screen, not a client-side transition from whatever was open before.
  const url = cfg.base + (shot.path || '/');
  await send('Page.navigate', { url });
  await sleep(shot.wait || 1800);

  if (shot.theme) {
    await js(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(shot.theme)}); 'ok'`);
    await sleep(300);
  }
  if (shot.js) {
    const res = await js(shot.js);
    if (shot.waitAfterJs) await sleep(shot.waitAfterJs);
    results.push({ kind: 'interaction', name: shot.name, result: res });
  }

  // DOM diagnostics: a blank or unhydrated page must never be mistaken for a
  // valid screenshot. `scrollW > clientW` also flags horizontal overflow.
  const diag = await js(`(() => ({
    title: document.title,
    bodyLen: (document.body.innerText || '').length,
    h1: (document.querySelector('h1') || {}).innerText || null,
    rootChildren: (document.getElementById('root') || {}).childElementCount ?? -1,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    theme: document.documentElement.getAttribute('data-theme'),
  }))()`);

  const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = `${OUT}/${cfg.prefix}-${shot.name}.png`;
  fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
  console.log(JSON.stringify({ file, url: shot.path, width, height, ...diag }));
  results.push({ kind: 'shot', name: shot.name, file, diag });
}

ws.close();
browser.kill();
fs.writeFileSync(`${OUT}/${cfg.prefix}-manifest.json`, JSON.stringify(results, null, 2));
console.log('DONE', results.length);
