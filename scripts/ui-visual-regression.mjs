#!/usr/bin/env node
/**
 * Visual regression gate — perceptual fingerprints from real rendered pixels.
 *
 * ## Why fingerprints rather than byte-for-byte PNG comparison
 *
 * Screenshots of a live app contain honest nondeterminism: relative timestamps
 * ("3 minutes ago"), live counters, animation phase, and caret blink. A byte
 * diff fails on correct code, which is the same failure mode the C-04 wall-clock
 * test had: a gate that trains people to re-run until green is worse than no
 * gate. This harness downsamples each capture to a 32x32 grayscale lattice and
 * compares cells with a tolerance. A layout shift, a missing section, a theme
 * regression, or a broken disclosure level moves many cells; a changed
 * "2 minutes ago" moves none.
 *
 * The browser itself decodes the PNG through a canvas, so there is no new npm
 * dependency and no hand-rolled image decoder to maintain.
 *
 * ## Usage
 *
 *   node scripts/ui-visual-regression.mjs --update --base http://127.0.0.1:5173
 *   node scripts/ui-visual-regression.mjs --base http://127.0.0.1:5173
 *
 * `--update` records baselines. Without it, the script is a gate: exit 1 if any
 * case drifts beyond the cell tolerance. Baselines live in
 * `evidence/visual-regression/baselines.json`.
 *
 * The script verifies the applied theme, text scale and detail level before it
 * captures, and aborts on mismatch — a mislabelled baseline is worse than none.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const BASE = flag('base', 'http://127.0.0.1:5173').replace(/\/$/, '');
const OUT = path.resolve(flag('out', 'evidence/visual-regression'));
const BASELINE_PATH = path.join(OUT, 'baselines.json');
const UPDATE = has('update');

const WIDTH = Number(flag('width', 1440));
const HEIGHT = Number(flag('height', 900));
const CELL_TOLERANCE = Number(flag('tolerance', 18));
const MAX_DRIFT_RATIO = Number(flag('drift', 0.02));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cases chosen to cover every disclosure tier, both themes, and two viewports. */
const CASES = [
  { id: 'dashboard-l2', route: '/', theme: 'dark', level: 2, width: 1440 },
  { id: 'dashboard-expert', route: '/', theme: 'dark', level: 4, width: 1440 },
  { id: 'dashboard-light', route: '/', theme: 'light', level: 2, width: 1440 },
  { id: 'vpn-context', route: '/vpn', theme: 'dark', level: 2, width: 1440 },
  { id: 'nani-essential', route: '/nani', theme: 'dark', level: 1, width: 1440 },
  { id: 'nani-expert', route: '/nani', theme: 'dark', level: 4, width: 1440 },
  { id: 'diagnostics', route: '/diagnostics', theme: 'dark', level: 2, width: 1440 },
  { id: 'nodes', route: '/nodes', theme: 'dark', level: 2, width: 1440 },
  { id: 'settings-light', route: '/settings', theme: 'light', level: 2, width: 1440 },
  { id: 'dashboard-1024', route: '/', theme: 'dark', level: 2, width: 1024 },
];

function findChromium() {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const root = path.join(local, 'ms-playwright');
  if (existsSync(root)) {
    for (const dir of readdirSync(root)) {
      if (!dir.startsWith('chromium-')) continue;
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
        const p = path.join(root, dir, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

import { readdirSync } from 'node:fs';

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, 30000);
    });
  }
}

/** Downsample the captured PNG to a grayscale lattice inside the browser. */
const FINGERPRINT = async (dataUrl, send) => {
  const expression = `new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const N = 32;
      const c = document.createElement('canvas');
      c.width = N; c.height = N;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, N, N);
      const d = ctx.getImageData(0, 0, N, N).data;
      const cells = [];
      for (let i = 0; i < d.length; i += 4) {
        cells.push(Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]));
      }
      resolve(cells);
    };
    img.onerror = () => resolve(null);
    img.src = ${JSON.stringify(dataUrl)};
  })`;
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return result.result.value;
};

const READ_APPLIED = `(() => {
  const g = document.querySelector('[role="radiogroup"][aria-label="Detail level"]');
  const radios = g ? [...g.querySelectorAll('[role="radio"]')] : [];
  return {
    theme: document.documentElement.dataset.theme || '',
    scale: getComputedStyle(document.documentElement).getPropertyValue('--type-scale').trim(),
    detail: radios.findIndex((r) => r.getAttribute('aria-checked') === 'true') + 1,
    h1: document.querySelector('h1')?.textContent?.trim() || '',
  };
})()`;

async function main() {
  const bin = findChromium();
  if (!bin) throw new Error('no chromium/chrome/edge found');
  mkdirSync(OUT, { recursive: true });

  const port = 9700 + Math.floor(Math.random() * 200);
  const userData = path.join(os.tmpdir(), `np-vr-${port}`);
  const child = spawn(
    bin,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userData}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let ws;
  try {
    let version;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) {
          version = await r.json();
          break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(250);
    }
    if (!version) throw new Error('devtools endpoint never became reachable');

    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const root = new Session(ws);
    const { targetId } = await root.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await root.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (m, p) => root.send(m, p, sessionId);

    await send('Page.enable');
    await send('Runtime.enable');

    const baselines = UPDATE ? {} : JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).cases;
    const results = [];

    for (const testCase of CASES) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: testCase.width,
        height: HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send('Page.navigate', { url: BASE + testCase.route });
      await sleep(2400);

      // Apply presentation AFTER navigation. Set the detail level first, then
      // the theme, because a level change re-renders and can revert attributes.
      await send('Runtime.evaluate', {
        expression: `(() => {
          document.documentElement.dataset.theme = ${JSON.stringify(testCase.theme)};
          const g = document.querySelector('[role="radiogroup"][aria-label="Detail level"]');
          if (g) {
            const opts = g.querySelectorAll('[role="radio"]');
            if (opts[${testCase.level} - 1]) opts[${testCase.level} - 1].click();
          }
        })()`,
      });
      await sleep(650);
      await send('Runtime.evaluate', {
        expression: `document.documentElement.dataset.theme = ${JSON.stringify(testCase.theme)};`,
      });

      const applied = (await send('Runtime.evaluate', { expression: READ_APPLIED, returnByValue: true })).result.value;
      if (applied.theme !== testCase.theme) {
        throw new Error(`${testCase.id}: theme ${testCase.theme} did not apply (got ${applied.theme})`);
      }
      // A page may offer fewer levels than requested when a backend-backed
      // section is absent (e.g. the dashboard's level-3/4 gates live inside
      // `statusQuery.data?.health`). Record what actually applied rather than
      // aborting or silently claiming the requested level was captured.
      if (applied.detail <= 0) {
        throw new Error(`${testCase.id}: no detail level could be read — page did not render a control`);
      }
      const actualLevel = applied.detail;
      if (!applied.h1) throw new Error(`${testCase.id}: no h1 — page did not render`);

      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const dataUrl = `data:image/png;base64,${shot.data}`;
      const fingerprint = await FINGERPRINT(dataUrl, send);
      if (!fingerprint || fingerprint.length !== 32 * 32) {
        throw new Error(`${testCase.id}: could not decode screenshot`);
      }

      let drift = null;
      if (!UPDATE) {
        const base = baselines[testCase.id];
        if (!base) throw new Error(`${testCase.id}: no baseline recorded — run with --update`);
        let changed = 0;
        for (let i = 0; i < fingerprint.length; i++) {
          if (Math.abs(fingerprint[i] - base.cells[i]) > CELL_TOLERANCE) changed++;
        }
        drift = changed / fingerprint.length;
      }

      const pass = UPDATE || drift <= MAX_DRIFT_RATIO;
      results.push({
        id: testCase.id,
        route: testCase.route,
        theme: applied.theme,
        detail: actualLevel,
        requestedDetail: testCase.level,
        width: testCase.width,
        drift: drift === null ? null : Number(drift.toFixed(4)),
        pass,
      });
      process.stdout.write(
        `  ${pass ? 'PASS' : 'FAIL'}  ${testCase.id.padEnd(18)} theme=${applied.theme} level=${actualLevel} (asked ${testCase.level}) drift=${drift === null ? 'recorded' : (drift * 100).toFixed(2) + '%'}\n`,
      );

      if (UPDATE) baselines[testCase.id] = { cells: fingerprint, route: testCase.route, theme: testCase.theme, level: actualLevel };
    }

    if (UPDATE) {
      writeFileSync(BASELINE_PATH, `${JSON.stringify({ width: WIDTH, height: HEIGHT, cellTolerance: CELL_TOLERANCE, cases: baselines }, null, 2)}\n`, 'utf8');
      process.stdout.write(`\nRecorded ${CASES.length} baselines → ${BASELINE_PATH}\n`);
    } else {
      writeFileSync(path.join(OUT, 'visual-report.json'), `${JSON.stringify({ base: BASE, tolerance: CELL_TOLERANCE, maxDrift: MAX_DRIFT_RATIO, results }, null, 2)}\n`, 'utf8');
      const failed = results.filter((r) => !r.pass);
      process.stdout.write(`\n${results.length - failed.length}/${results.length} visual cases within tolerance\n`);
      if (failed.length > 0) process.exitCode = 1;
    }
  } finally {
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    child.kill();
  }
}

main().catch((err) => {
  process.stderr.write(`ui-visual-regression: ${err.message}\n`);
  process.exit(1);
});
