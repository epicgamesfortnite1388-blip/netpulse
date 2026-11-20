#!/usr/bin/env node
/**
 * DOM probe — reports geometry for a selector so layout claims can be checked
 * against numbers instead of a scaled screenshot.
 *
 *   node scripts/ui-probe.mjs --route / --select ".np-panel" --select "main"
 *
 * Prints, per match: box, scrollHeight vs clientHeight (clipping), and computed
 * font-size. Also reports any element inside <main> whose right edge exceeds the
 * content box, which is how a horizontal overflow shows up before it is visible.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const BASE = flag('base', 'http://127.0.0.1:5173').replace(/\/$/, '');
const ROUTE = flag('route', '/');
const WIDTH = Number(flag('width', 1440));
const HEIGHT = Number(flag('height', 900));
const SEL = args.reduce((acc, a, i) => (a === '--select' ? [...acc, args[i + 1]] : acc), []);
const SETTLE = Number(flag('settle', 3000));

function findChromium() {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const root = path.join(local, 'ms-playwright');
  if (existsSync(root)) {
    for (const d of readdirSync(root)) {
      if (!d.startsWith('chromium-')) continue;
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
        const p = path.join(root, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const bin = findChromium();
  const port = 9500 + Math.floor(Math.random() * 200);
  const child = spawn(
    bin,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(os.tmpdir(), `np-probe-${port}`)}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      '--hide-scrollbars',
      '--no-first-run',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  try {
    let version;
    for (let i = 0; i < 60 && !version; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) version = await r.json();
      } catch {
        await sleep(250);
      }
    }
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m.result ?? m.error);
        pending.delete(m.id);
      }
    });
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    await s('Page.enable');
    await s('Runtime.enable');
    await s('Page.navigate', { url: `${BASE}/` });
    await sleep(2000);
    await s('Page.navigate', { url: `${BASE}${ROUTE}` });
    await sleep(SETTLE);

    const expr = `(() => {
      const sels = ${JSON.stringify(SEL)};
      const out = [];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          out.push({
            sel,
            cls: (el.className || '').toString().slice(0, 90),
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
            scrollH: el.scrollHeight, clientH: el.clientHeight,
            scrollW: el.scrollWidth, clientW: el.clientWidth,
            font: cs.fontSize, overflowY: cs.overflowY,
            // Colour is part of the contract, so it is measured rather than
            // judged from a downscaled screenshot.
            color: cs.color,
            bg: cs.backgroundColor,
            border: cs.borderTopColor,
          });
        }
      }
      // anything poking past the content box
      const main = document.querySelector('main') || document.body;
      const mb = main.getBoundingClientRect();
      const over = [];
      for (const el of main.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.right > mb.right + 1 || r.left < mb.left - 1) {
          over.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 60), right: Math.round(r.right), left: Math.round(r.left) });
          if (over.length > 6) break;
        }
      }
      return { mainW: Math.round(mb.width), boxes: out, overflow: over, rootFont: getComputedStyle(document.documentElement).fontSize };
    })()`;

    const res = await s('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(JSON.stringify(res.result?.value ?? res, null, 2));
    ws.close();
  } finally {
    child.kill();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
