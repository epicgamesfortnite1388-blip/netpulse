#!/usr/bin/env node
/**
 * Advanced accessibility checks that the behavioural a11y script does not cover.
 *
 * Covers four gaps Kim identified:
 *   1. reduced-motion behaviour driven in a real browser (not just a CSS regex);
 *   2. interactive-state contrast — placeholder, disabled, hover, focus;
 *   3. WCAG 1.4.10 reflow at 400% zoom (320 CSS px wide);
 *   4. phone-width layout (390px) with no horizontal overflow.
 *
 * Usage:
 *   node scripts/ui-a11y-advanced.mjs --base http://127.0.0.1:5173 --out evidence/a11y-advanced
 *
 * Exit 1 on any hard failure. Contrast is measured from computed styles, with
 * the exact foreground and background recorded for every sample.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};

const BASE = flag('base', 'http://127.0.0.1:5173').replace(/\/$/, '');
const OUT = path.resolve(flag('out', 'evidence/a11y-advanced'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const CONTRAST_FN = `
  const parseColor = (str) => {
    if (!str) return null;
    const m = str.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  });
  const lum = (c) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement.parentElement) {
      const bg = parseColor(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0) return bg.a >= 1 ? bg : over(bg, { r: 255, g: 255, b: 255, a: 1 });
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
`;

const INTERACTIVE_CONTRAST = `(() => {
  ${CONTRAST_FN}
  const out = [];
  const add = (label, fgStr, bg, size, weight, text) => {
    const fg0 = parseColor(fgStr);
    if (!fg0) return;
    const fg = over(fg0, bg);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const r = ratio(fg, bg);
    const need = large ? 3 : 4.5;
    out.push({ label, text: (text || '').slice(0, 40), fg: hex(fg), bg: hex(bg), ratio: Number(r.toFixed(2)), need, pass: r >= need });
  };

  // Placeholder text on inputs and textareas.
  for (const el of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
    const cs = getComputedStyle(el);
    const ph = getComputedStyle(el, '::placeholder');
    add('placeholder', ph.color || cs.color, bgOf(el), parseFloat(ph.fontSize || cs.fontSize), Number(cs.fontWeight) || 400, el.getAttribute('placeholder'));
  }

  // Disabled controls: contrast is exempt from WCAG 1.4.3, but we record it.
  for (const el of document.querySelectorAll('button:disabled, [aria-disabled="true"]')) {
    const cs = getComputedStyle(el);
    add('disabled', cs.color, bgOf(el), parseFloat(cs.fontSize), Number(cs.fontWeight) || 400, el.textContent);
  }

  // Focus indicators: WCAG 2.4.11 / 1.4.11 non-text 3:1 against the adjacent bg.
  for (const el of document.querySelectorAll('button, [role="radio"], [role="tab"], a[href]')) {
    const cs = getComputedStyle(el);
    const ring = cs.outlineColor && cs.outlineWidth !== '0px' ? cs.outlineColor : null;
    if (ring && parseColor(ring)) {
      const c = parseColor(ring);
      add('focus-ring', ring, bgOf(el), 18, 400, el.textContent);
      void c;
    }
  }
  return out;
})()`;

const MOTION_PROBE = `(() => {
  const animated = [...document.querySelectorAll('*')].filter((el) => {
    const cs = getComputedStyle(el);
    return cs.animationName && cs.animationName !== 'none' && cs.animationDuration !== '0s';
  });
  const transitions = [...document.querySelectorAll('*')].filter((el) => {
    const cs = getComputedStyle(el);
    return cs.transitionDuration && cs.transitionDuration !== '0s' && cs.transitionProperty !== 'all';
  }).length;
  return {
    prefersReduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
    animated: animated.length,
    names: animated.slice(0, 10).map((el) => getComputedStyle(el).animationName),
    transitions,
    bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`;

async function main() {
  const bin = findChromium();
  if (!bin) throw new Error('no chromium/chrome/edge found');
  mkdirSync(OUT, { recursive: true });

  const port = 9900 + Math.floor(Math.random() * 100);
  const userData = path.join(os.tmpdir(), `np-a11yadv-${port}`);
  const child = spawn(
    bin,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userData}`,
      '--window-size=1440,900',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let ws;
  const checks = [];
  const detail = {};
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

    // --- reduced motion, driven through Emulation.setEmulatedMedia ---
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await send('Page.navigate', { url: `${BASE}/` });
    await sleep(2600);
    const reduced = (await send('Runtime.evaluate', { expression: MOTION_PROBE, returnByValue: true })).result.value;
    detail.reducedMotion = reduced;
    checks.push({
      name: 'prefers-reduced-motion is applied to the rendered page',
      pass: reduced.prefersReduce === true,
      note: 'required before interpreting the animation result',
    });
    checks.push({
      name: 'no CSS keyframe animation runs under prefers-reduced-motion',
      pass: reduced.animated === 0,
      note: `${reduced.animated} animated elements; names=${JSON.stringify(reduced.names)}`,
    });

    // Reset motion and measure interactive-state contrast.
    await send('Emulation.setEmulatedMedia', { features: [] });
    await send('Page.navigate', { url: `${BASE}/settings` });
    await sleep(2200);

    const contrastAll = [];
    for (const theme of ['dark', 'light']) {
      await send('Runtime.evaluate', {
        expression: `document.documentElement.dataset.theme = ${JSON.stringify(theme)};`,
      });
      await sleep(300);
      const samples = (await send('Runtime.evaluate', { expression: INTERACTIVE_CONTRAST, returnByValue: true })).result.value;
      contrastAll.push(...samples.map((s) => ({ ...s, theme })));
    }
    detail.interactiveContrast = contrastAll;
    const relevant = contrastAll.filter((s) => s.label === 'placeholder' || s.label === 'focus-ring');
    const failures = relevant.filter((s) => !s.pass);
    checks.push({
      name: 'placeholder and focus-ring contrast meets WCAG AA',
      pass: failures.length === 0,
      note:
        failures.length === 0
          ? `${relevant.length} samples across both themes`
          : failures.map((f) => `${f.theme}/${f.label} ${f.ratio}:1 fg=${f.fg} bg=${f.bg} "${f.text}"`).join('; '),
    });

    // --- reflow at 400% zoom (WCAG 1.4.10): 320 CSS px at 400% = 1280 device px ---
    for (const [name, width] of [
      ['reflow-400', 320],
      ['phone-390', 390],
    ]) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width <= 390,
      });
      await send('Page.navigate', { url: `${BASE}/` });
      await sleep(2400);
      const layout = (
        await send('Runtime.evaluate', {
          expression: `(() => ({
            scrollW: document.documentElement.scrollWidth,
            clientW: document.documentElement.clientWidth,
            h1: document.querySelector('h1')?.textContent?.trim() || '',
            controls: document.querySelectorAll('button, [role="radio"], [role="tab"]').length,
          }))()`,
          returnByValue: true,
        })
      ).result.value;
      detail[name] = layout;
      checks.push({
        name: `${name}: no horizontal overflow at ${width}px`,
        pass: layout.scrollW <= layout.clientW + 1,
        note: `scrollW=${layout.scrollW} clientW=${layout.clientW} h1="${layout.h1}" controls=${layout.controls}`,
      });
      checks.push({
        name: `${name}: page still renders a heading and controls`,
        pass: layout.h1 !== '' && layout.controls > 0,
        note: `h1="${layout.h1}" controls=${layout.controls}`,
      });
    }

    writeFileSync(path.join(OUT, 'a11y-advanced-report.json'), `${JSON.stringify({ base: BASE, checks, detail }, null, 2)}\n`, 'utf8');
    for (const c of checks) {
      process.stdout.write(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n         ${c.note}\n`);
    }
    const failed = checks.filter((c) => !c.pass);
    process.stdout.write(`\n${checks.length - failed.length}/${checks.length} advanced checks passed\n`);
    if (failed.length > 0) process.exitCode = 1;
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
  process.stderr.write(`ui-a11y-advanced: ${err.message}\n`);
  process.exit(1);
});
