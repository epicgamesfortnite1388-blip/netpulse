#!/usr/bin/env node
/**
 * UI capture harness — real rendered screenshots of the running app.
 *
 * The repo has no browser-automation dependency (deliberately: no pixel-diff
 * baseline store, see reports/UI_MASTER_12). This script therefore drives a
 * locally installed Chromium directly over the DevTools protocol using Node's
 * built-in WebSocket, so visual QA needs no new npm dependency.
 *
 * Usage:
 *   node scripts/ui-capture.mjs --base http://127.0.0.1:5173 --out evidence/ui2
 *   node scripts/ui-capture.mjs --only dashboard,nani --scale 1.25
 *
 * Flags:
 *   --base <url>      Dev server origin (default http://127.0.0.1:5173)
 *   --out <dir>       Output directory (default evidence/ui2)
 *   --only <a,b>      Only capture these shot ids
 *   --width/--height  Viewport (default 1440x900)
 *   --scale <n>       Device scale factor (default 1)
 *   --theme <d|l>     Force theme via localStorage before load
 *   --type-scale <n>  Force the user text-size preference (1, 1.15, 1.25…)
 *   --settle <ms>     Extra settle time after network idle (default 900)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};

const BASE = flag('base', 'http://127.0.0.1:5173').replace(/\/$/, '');
const OUT = path.resolve(flag('out', 'evidence/ui2'));
const WIDTH = Number(flag('width', 1440));
const HEIGHT = Number(flag('height', 900));
const SCALE = Number(flag('scale', 1));
const THEME = flag('theme', '');
const TYPE_SCALE = flag('type-scale', '');
const SETTLE = Number(flag('settle', 900));
// Theme and text size are backend settings, not localStorage, so they are
// applied to <html> after load. This exercises the exact CSS the product uses.
const DOM_THEME = flag('dom-theme', '');
// The app keys the ramp off `<html data-type-scale>` with NAMED steps, not a
// multiplier. An earlier version wrote the raw number here, matched no selector,
// and produced a run of screenshots that were silently captured at 100%.
const SCALE_STEPS = { 1: '', 1.125: 'large', 1.25: 'xl' };
const DOM_SCALE_RAW = flag('dom-scale', '');
const DOM_SCALE = DOM_SCALE_RAW
  ? (SCALE_STEPS[Number(DOM_SCALE_RAW)] ?? null)
  : '';
if (DOM_SCALE === null) {
  process.stderr.write(
    `ui-capture: --dom-scale ${DOM_SCALE_RAW} is not a supported text size. Use one of ${Object.keys(SCALE_STEPS).join(', ')}.\n`,
  );
  process.exit(1);
}
const FULL = args.includes('--full');
const ONLY = flag('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Detail pages (a single node, a single server) have no stable id to hard-code
// into SHOTS, so allow one ad-hoc route per run.
const AD_HOC_PATH = flag('path', '');
const AD_HOC_LABEL = flag('label', 'Ad hoc route');
// Progressive-disclosure level to select before capture (1..4).
const DETAIL = flag('detail', '');
// Select a tab by visible text before capture. Lets one run reach a VPN engine
// surface or a NANI tab without hard-coding a shot for every combination.
const TAB = flag('tab', '');

/** The shots we care about. `route` is the SPA path, `after` runs before capture. */
const SHOTS = [
  { id: '01-dashboard', route: '/', label: 'Dashboard' },
  { id: '02-vpn', route: '/vpn', label: 'VPN & engines' },
  { id: '03-nani-overview', route: '/nani', label: 'NANI overview' },
  { id: '04-nani-hypotheses', route: '/nani', label: 'NANI hypotheses', after: 'nani:hypotheses' },
  { id: '05-nani-evidence', route: '/nani', label: 'NANI evidence', after: 'nani:evidence' },
  { id: '06-nani-live', route: '/nani', label: 'NANI live events', after: 'nani:live' },
  { id: '07-nani-network', route: '/nani', label: 'NANI network', after: 'nani:network' },
  { id: '08-copilot', route: '/copilot', label: 'Copilot' },
  { id: '09-nodes', route: '/nodes', label: 'Nodes' },
  { id: '10-settings', route: '/settings', label: 'Settings' },
  { id: '11-diagnostics', route: '/diagnostics', label: 'Diagnostics' },
  { id: '12-history', route: '/history', label: 'History' },
  { id: '13-servers', route: '/servers', label: 'Servers' },
  { id: '14-map', route: '/map', label: 'Live map' },
  { id: '15-speed-test', route: '/speed-test', label: 'Speed test' },
  { id: '16-dns', route: '/dns', label: 'DNS lab' },
  { id: '17-iran', route: '/iran', label: 'Iran connectivity' },
  { id: '18-mission', route: '/mission', label: 'Mission control' },
  { id: '19-events', route: '/events', label: 'Events' },
  { id: '20-engines', route: '/engines', label: 'Engines' },
];

function findChromium() {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const roots = [path.join(local, 'ms-playwright')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('chromium devtools endpoint never became reachable');
}

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

async function main() {
  const bin = findChromium();
  if (!bin) throw new Error('no chromium/chrome/edge found');
  mkdirSync(OUT, { recursive: true });

  const port = 9300 + Math.floor(Math.random() * 200);
  const userData = path.join(os.tmpdir(), `np-ui-capture-${port}`);
  const child = spawn(
    bin,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userData}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
      '--disable-lcd-text',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  try {
    const version = await cdpTargets(port);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const s = new Session(ws);

    const { targetId } = await s.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await s.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (m, p) => s.send(m, p, sessionId);

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: SCALE,
      mobile: false,
    });

    // Seed preferences before the first document script runs.
    const seed = {};
    if (THEME) seed['netpulse-theme'] = THEME === 'l' ? 'light' : 'dark';
    if (TYPE_SCALE) seed['netpulse-type-scale'] = TYPE_SCALE;
    if (Object.keys(seed).length) {
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try{${Object.entries(seed)
          .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)})`)
          .join(';')}}catch(e){}`,
      });
    }

    // First load: let the SPA mint its session cookie through the dev proxy.
    await send('Page.navigate', { url: `${BASE}/` });
    await sleep(2500);

    const shots = AD_HOC_PATH
      ? [{ id: 'ad-hoc', route: AD_HOC_PATH, label: AD_HOC_LABEL }]
      : ONLY.length ? SHOTS.filter((s2) => ONLY.includes(s2.id)) : SHOTS;
    const manifest = [];

    for (const shot of shots) {
      await send('Page.navigate', { url: `${BASE}${shot.route}` });
      await sleep(SETTLE + 600);

      if (DOM_THEME || DOM_SCALE) {
        await send('Runtime.evaluate', {
          expression: `(() => {
            const de = document.documentElement;
            ${DOM_THEME ? `de.dataset.theme = ${JSON.stringify(DOM_THEME === 'l' ? 'light' : 'dark')};` : ''}
            ${DOM_SCALE ? `de.dataset.typeScale = ${JSON.stringify(DOM_SCALE)};` : ''}
          })()`,
        });
        await sleep(400);
      }

      // Progressive-disclosure state. The level control is a radiogroup, so the
      // requested level is selected by index and then READ BACK — a screenshot
      // labelled "Expert" that is actually showing Essential would be exactly the
      // class of silent no-op this harness was already caught doing for text size.
      //
      // It runs twice, around the tab step, because the two orders are both
      // required: on NANI the level decides which tabs exist, so it must be set
      // before the tab can be clicked; on VPN the active engine decides how deep
      // the page can go, so the tab must be clicked before Expert can be offered.
      // Applying the level, switching tab, then applying it again satisfies both.
      const applyDetail = async () => {
        if (!DETAIL) return;
        const wanted = Number(DETAIL) - 1;
        const res = (await send('Runtime.evaluate', {
          expression: `(() => {
            const group = document.querySelector('[role="radiogroup"][aria-label="Detail level"]');
            if (!group) return { ok: false, reason: 'no detail control on this route' };
            const options = group.querySelectorAll('[role="radio"]');
            if (!options[${wanted}]) return { ok: false, reason: 'level index out of range (' + options.length + ' options)' };
            options[${wanted}].click();
            return { ok: true };
          })()`,
          returnByValue: true,
        })).result.value;
        if (!res.ok) {
          process.stderr.write(`ui-capture: detail level ${DETAIL} could not be selected on ${shot.route} (${res.reason})\n`);
          process.exit(1);
        }
        // React commits on a later tick: the read-back below is what proves the
        // level applied, not this call returning.
        await sleep(350);
      };

      await applyDetail();

      const tabWanted = shot.after?.startsWith('nani:') ? shot.after.slice(5) : TAB || null;
      if (tabWanted) {
        const tab = tabWanted;
        // Radix activates a tab on pointer down, so a synthetic `.click()` is
        // not enough — dispatch a real press at the trigger's centre.
        const box = await send('Runtime.evaluate', {
          expression: `(() => {
            // Any tablist, not just the first: the VPN rail and the NANI tab bar
            // are different tablists on different routes, and a page can grow a
            // second one. Search them all and take the first text match.
            const want = ${JSON.stringify(tab)}.toLowerCase();
            const btns = [...document.querySelectorAll('[role="tablist"] [role="tab"]')];
            if (btns.length === 0) return { error: 'no tabs on this route' };
            const hit = btns.find(b => (b.textContent || '').toLowerCase().includes(want));
            if (!hit) return { error: btns.map(b => b.textContent.trim()).join('|') };
            const r = hit.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: hit.textContent.trim() };
          })()`,
          returnByValue: true,
        });
        const pt = box.result?.value;
        if (pt && pt.x) {
          for (const type of ['mousePressed', 'mouseReleased']) {
            await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
          }
          process.stdout.write(`      [tab] ${pt.label}\n`);
        } else {
          process.stdout.write(`      [tab] not found: ${JSON.stringify(pt)}\n`);
        }
        await sleep(1200);
      }

      // Second application, after the tab switch: the active engine or tab can
      // change how deep this page goes, and the level must be settled before the
      // read-back below is treated as proof.
      await applyDetail();

      // Read back what the page actually resolved, so a selector that matched
      // nothing shows up in the manifest instead of in a wrong screenshot.
      const applied = (await send('Runtime.evaluate', {
        expression: `(() => {
          const de = document.documentElement;
          const cs = getComputedStyle(de);
          const group = document.querySelector('[role="radiogroup"][aria-label="Detail level"]');
          const checkedIndex = group
            ? [...group.querySelectorAll('[role="radio"]')].findIndex((el) => el.getAttribute('aria-checked') === 'true')
            : -1;
          return {
            theme: de.dataset.theme || 'default',
            typeScaleAttr: de.dataset.typeScale || 'default',
            typeScale: cs.getPropertyValue('--type-scale').trim(),
            rootFont: cs.fontSize,
            detailLevel: checkedIndex >= 0 ? checkedIndex + 1 : null,
          };
        })()`,
        returnByValue: true,
      })).result.value;
      if (DOM_SCALE && applied.typeScale !== String(SCALE_STEPS[Number(DOM_SCALE_RAW)] === '' ? 1 : DOM_SCALE_RAW)) {
        process.stderr.write(`ui-capture: text scale did not apply (--type-scale resolved to ${applied.typeScale})\n`);
        process.exit(1);
      }
      if (DETAIL && applied.detailLevel !== Number(DETAIL)) {
        process.stderr.write(`ui-capture: detail level ${DETAIL} did not apply on ${shot.route} (resolved ${applied.detailLevel})\n`);
        process.exit(1);
      }

      const metrics = await send('Runtime.evaluate', {
        expression: `(() => {
          const de = document.documentElement;
          const scroller = document.querySelector('.np-content') || de;
          // scrollHeight is clamped to the viewport on a page shorter than the
          // window, so it cannot tell 415px of content from 570px. Measure the
          // bottom-most child instead, which is what "how long is this page"
          // actually means and is what disclosure is supposed to change.
          const top = scroller.getBoundingClientRect().top + scroller.scrollTop;
          let contentH = 0;
          for (const el of scroller.children) {
            const r = el.getBoundingClientRect();
            if (r.height > 0) contentH = Math.max(contentH, r.bottom - top);
          }
          return {
            title: document.title,
            scrollW: scroller.scrollWidth, clientW: scroller.clientWidth,
            scrollH: scroller.scrollHeight, clientH: scroller.clientHeight,
            contentH: Math.round(contentH),
            docScrollW: de.scrollWidth, docClientW: de.clientWidth,
            h1: [...document.querySelectorAll('h1')].map(h => h.textContent.trim()).slice(0,3),
            rootFont: getComputedStyle(de).fontSize,
          };
        })()`,
        returnByValue: true,
      });

      const { data } = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: FULL,
      });
      const file = path.join(OUT, `${shot.id}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));

      const m = metrics.result.value;
      manifest.push({ id: shot.id, label: shot.label, route: shot.route, file: path.relative(process.cwd(), file), applied, ...m });
      const overflow = m.scrollW > m.clientW + 1 ? ` HORIZ-OVERFLOW +${m.scrollW - m.clientW}px` : '';
      process.stdout.write(`  ${shot.id.padEnd(22)} ${String(m.scrollH).padStart(5)}px tall  content=${String(m.contentH).padStart(5)}px  h1=${JSON.stringify(m.h1[0] ?? '')}${overflow}\n`);
    }

    writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ base: BASE, width: WIDTH, height: HEIGHT, scale: SCALE, theme: THEME || 'default', typeScale: DOM_SCALE_RAW || 'default', shots: manifest }, null, 2));
    process.stdout.write(`\nwrote ${manifest.length} shots + manifest.json to ${OUT}\n`);
    ws.close();
  } finally {
    child.kill();
  }
}

main().catch((err) => {
  process.stderr.write(`ui-capture failed: ${err.message}\n`);
  process.exit(1);
});
