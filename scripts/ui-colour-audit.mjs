#!/usr/bin/env node
/**
 * Colour and contrast audit — measured from the rendered interface.
 *
 * ## Why this exists
 *
 * A contrast figure quoted from a design token is a statement about a variable,
 * not about what a user sees. Tokens get overridden by a later layer, a component
 * can sit on a surface it was not designed for, and a gradient background has no
 * single "background colour" at all. So this script never reads a token: it asks
 * the browser for the computed `color` and the computed background of the element
 * that actually paints behind it, then computes the ratio from those resolved
 * values.
 *
 * It also answers two questions that cannot be answered by reading CSS:
 *
 *   - Are raw Tailwind palette utilities still reaching the DOM? A class string
 *     can be assembled at runtime, so the only honest check is the rendered
 *     class list.
 *   - Do the engine identities actually differ? "Distinct tint" is a claim about
 *     computed colour, and eight engines sharing one computed colour would be
 *     invisible in a screenshot review.
 *
 * ## Usage
 *
 *     node scripts/ui-colour-audit.mjs --base http://127.0.0.1:5173 --out evidence/colour
 *
 * Flags:
 *   --base <url>     Dev server origin (default http://127.0.0.1:5173)
 *   --out <dir>      Output directory (default evidence/colour)
 *   --width/--height Viewport (default 1440x900)
 *   --only <a,b>     Only audit these routes
 *
 * Exit code is 1 when a measured contrast falls below its WCAG AA threshold, or
 * when a raw palette utility is found. That makes it usable as a gate.
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
const OUT = path.resolve(flag('out', 'evidence/colour'));
const WIDTH = Number(flag('width', 1440));
const HEIGHT = Number(flag('height', 900));
const ONLY = flag('only', '').split(',').map((s) => s.trim()).filter(Boolean);

const ROUTES = [
  { id: 'dashboard', route: '/' },
  { id: 'vpn', route: '/vpn' },
  { id: 'nani', route: '/nani' },
  { id: 'diagnostics', route: '/diagnostics' },
  { id: 'nodes', route: '/nodes' },
  { id: 'settings', route: '/settings' },
  { id: 'engines', route: '/engines' },
  { id: 'map', route: '/map' },
].filter((r) => ONLY.length === 0 || ONLY.includes(r.id));

const THEMES = ['dark', 'light'];

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * The in-page audit. Everything here runs inside the browser, against the
 * rendered document — no token is read and no colour is hard-coded.
 */
const PAGE_AUDIT = `(() => {
  const parseColor = (str) => {
    if (!str) return null;
    const m = str.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };

  // Composite a possibly-translucent colour over an opaque backdrop.
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });

  const relLum = (c) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };

  const ratio = (a, b) => {
    const l1 = relLum(a);
    const l2 = relLum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  const hex = (c) =>
    '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

  /**
   * The colour actually painted behind an element.
   *
   * Walks ancestors compositing translucent layers, and when an ancestor paints
   * a gradient it returns every stop so the caller can take the worst case. A
   * gradient is the reason a token-based contrast check is not enough: there is
   * no single backdrop, so the honest figure is the one over the least
   * favourable stop.
   */
  const backdrop = (el) => {
    let node = el;
    let acc = null; // accumulated colour over opaque base
    const stops = [];
    while (node && node !== document.documentElement.parentElement) {
      const cs = getComputedStyle(node);
      const img = cs.backgroundImage;
      if (img && img !== 'none' && img.includes('gradient')) {
        const found = [...img.matchAll(/rgba?\\([^)]+\\)/g)].map((m) => parseColor(m[0])).filter(Boolean);
        for (const f of found) stops.push(f);
      }
      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0) {
        if (bg.a >= 1) {
          acc = acc ? over(acc, bg) : bg;
          break;
        }
        acc = acc ? over(acc, bg) : bg;
      }
      node = node.parentElement;
    }
    const base = acc ?? { r: 255, g: 255, b: 255, a: 1 };
    if (stops.length === 0) return { kind: 'solid', color: base };
    // Composite each gradient stop over the solid backdrop found so far.
    return { kind: 'gradient', colors: stops.map((s) => over(s, base)) };
  };

  const RAW_PALETTE =
    /\\b(?:bg|text|border|from|to|via|ring|fill|stroke|divide|outline|shadow|accent|caret|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\\b/;

  const rawPalette = [];
  for (const el of document.querySelectorAll('*')) {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (!cls) continue;
    const m = cls.match(RAW_PALETTE);
    if (m) rawPalette.push({ tag: el.tagName.toLowerCase(), match: m[0], cls: cls.slice(0, 160) });
  }

  // Every text-bearing element, deduplicated by (fg, bg) pair.
  const samples = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const text = (el.textContent || '').trim();
    if (!text) continue;
    // Only elements that render their own text.
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const fg0 = parseColor(cs.color);
    if (!fg0) continue;
    const bd = backdrop(el);
    const bgs = bd.kind === 'solid' ? [bd.color] : bd.colors;
    let worst = null;
    for (const bg of bgs) {
      const fg = over(fg0, bg);
      const r = ratio(fg, bg);
      if (worst === null || r < worst.ratio) worst = { ratio: r, fg: hex(fg), bg: hex(bg) };
    }
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    // WCAG AA: 3.0 for large text (>=24px, or >=18.66px bold), 4.5 otherwise.
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const key = worst.fg + '|' + worst.bg + '|' + (large ? 'L' : 'N');
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push({
      text: text.slice(0, 48),
      tag: el.tagName.toLowerCase(),
      className: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
      fontSize: size,
      fontWeight: weight,
      large,
      fg: worst.fg,
      bg: worst.bg,
      backdrop: bd.kind,
      ratio: Number(worst.ratio.toFixed(2)),
      required: large ? 3 : 4.5,
      pass: worst.ratio >= (large ? 3 : 4.5),
    });
  }

  // Engine identity colours, as computed.
  const engineGlyphs = [...document.querySelectorAll('[data-engine-glyph]')].map((el) => {
    const cs = getComputedStyle(el);
    return { id: el.getAttribute('data-engine-glyph'), color: cs.color, background: cs.backgroundImage.slice(0, 120) };
  });

  return { rawPalette, samples, engineGlyphs, theme: document.documentElement.dataset.theme || 'default' };
})()`;

async function main() {
  const bin = findChromium();
  if (!bin) throw new Error('no chromium/chrome/edge found');
  mkdirSync(OUT, { recursive: true });

  const port = 9500 + Math.floor(Math.random() * 200);
  const userData = path.join(os.tmpdir(), `np-colour-${port}`);
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
    await send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const results = [];
    for (const route of ROUTES) {
      for (const theme of THEMES) {
        await send('Page.navigate', { url: BASE + route.route });
        await sleep(1400);
        await send('Runtime.evaluate', {
          expression: `(() => {
            document.documentElement.dataset.theme = ${JSON.stringify(theme)};
          })()`,
        });
        await sleep(500);

        const audit = (await send('Runtime.evaluate', { expression: PAGE_AUDIT, returnByValue: true })).result.value;
        if (!audit) throw new Error(`audit returned nothing on ${route.route}`);

        const failing = audit.samples.filter((s) => !s.pass);
        results.push({ route: route.route, id: route.id, theme, ...audit, failing });

        process.stdout.write(
          `  ${route.id.padEnd(12)} ${theme.padEnd(5)}  text=${String(audit.samples.length).padStart(3)}  fail=${String(failing.length).padStart(2)}  rawPalette=${audit.rawPalette.length}  glyphs=${audit.engineGlyphs.length}\n`,
        );
      }
    }

    const allFailing = results.flatMap((r) => r.failing.map((f) => ({ route: r.route, theme: r.theme, ...f })));
    const allRaw = results.flatMap((r) => r.rawPalette.map((p) => ({ route: r.route, theme: r.theme, ...p })));

    writeFileSync(
      path.join(OUT, 'colour-audit.json'),
      `${JSON.stringify({ base: BASE, width: WIDTH, height: HEIGHT, results, allFailing, allRaw }, null, 2)}\n`,
      'utf8',
    );

    process.stdout.write(`\ncontrast failures: ${allFailing.length}\n`);
    for (const f of allFailing.slice(0, 20)) {
      process.stdout.write(
        `  ${f.route} ${f.theme}  ${f.ratio}:1 (needs ${f.required})  fg=${f.fg} bg=${f.bg}  "${f.text}"  .${f.className.split(' ').slice(0, 3).join('.')}\n`,
      );
    }
    process.stdout.write(`raw palette utilities: ${allRaw.length}\n`);
    for (const p of allRaw.slice(0, 20)) {
      process.stdout.write(`  ${p.route} ${p.theme}  ${p.match}  <${p.tag}>\n`);
    }

    if (allFailing.length > 0 || allRaw.length > 0) process.exitCode = 1;
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
  process.stderr.write(`ui-colour-audit: ${err.message}\n`);
  process.exit(1);
});
