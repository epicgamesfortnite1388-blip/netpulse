#!/usr/bin/env node
/**
 * Layout gate: no route may overflow horizontally, and no text may render below
 * 12px, at 1024px and 1440px in BOTH themes. Walks every route of the real
 * packaged desktop app over CDP and fails on any violation.
 *
 * Why this exists: no other gate looks at geometry. Text contrast does not care
 * that /health scrolled the whole document 97px sideways at 1024px because a
 * check row's detail text held one unbreakable Windows path and the flex item
 * refused to shrink below its min-content width. A sideways scroll is also easy
 * to miss by eye, because the app still looks correct until you notice the
 * scrollbar.
 *
 * Failures:
 *   - the document scrolls horizontally (the symptom a user actually sees)
 *   - a box is painted outside the viewport horizontally (content pushed out of
 *     sight, even if something further up happens to clip it)
 *   - an overflow:hidden box swallows text with no ellipsis (text silently cut)
 *   - a box whose content overflows it
 *   - a text node rendering below the 12px floor
 *
 * Reported but NOT a failure:
 *   - Deliberate truncation (text-overflow: ellipsis). That is the designed
 *     degradation when text does not fit; the count and total hidden px are the
 *     regression signal, so if a change makes more strings truncate, small text
 *     got worse rather than better.
 *   - Overflow fully accounted for by a rotated (or scaled/translated)
 *     descendant. The Gauge's <svg> is 190px wide but rotated 225deg, so its
 *     axis-aligned bounding box is 190 * sqrt(2) ~= 269px, which reads as a 39px
 *     overflow on the gauge and on three ancestors -- on every page showing a
 *     score. Nothing is actually painted outside, because the content is a
 *     circle and a circle maps onto itself under rotation.
 *
 *     Two things make that exclusion safe rather than a blank cheque. First, it
 *     checks all four displacement properties, because Tailwind v4 emits
 *     `-rotate-[225deg]` as the standalone `rotate` property and not
 *     `transform: rotate(...)` -- checking transform alone misses every rotated
 *     element in the app. Second, the descendant must escape the container's
 *     content edge by at least the full reported overflow, so a rotated icon
 *     poking out by a pixel cannot mask a genuine 40px overflow. That second
 *     condition is also what lets the exclusion work on ancestors, which are
 *     wider than the rotated box itself.
 *
 * The type scale is pinned to 1x for the duration: it is a user preference, so
 * a developer who left theirs at "large" must not see CI fail on layout they
 * never shipped. The pin is applied and then verified, because
 * useTypeScaleApplier owns data-type-scale and would silently reinstate the
 * stored preference mid-run.
 *
 * Usage:
 *   node scripts/audit-layout.mjs                   # build + launch if needed
 *   PROBE_PORT=9334 node scripts/audit-layout.mjs   # reuse a running app
 *   AUDIT_CONTRAST_NO_BUILD=1 node scripts/audit-layout.mjs
 *
 * Exit 0 = every combination clean; 1 = failures, or an untrustworthy run.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.join(root, 'src-tauri', 'target', 'release', 'netpulse-desktop.exe');
const BACKEND = path.join(root, 'src-tauri', 'backend', 'netpulse-backend.js');
const ROUTER = path.join(root, 'apps', 'web', 'src', 'app', 'router.tsx');
const THEMES = ['dark', 'light'];
const WIDTHS = [1024, 1440];
const HEIGHT = 900;

/** The 12px floor, restated here so the gate does not silently inherit a token change. */
const MIN_TEXT_PX = 12;

/**
 * Sub-pixel slack. Fractional rem layout can leave a box a pixel over its
 * neighbour with nothing visibly wrong. Real defects measured on this app were
 * 6px and up, so 2px costs no coverage.
 */
const TOL = 2;

/* ------------------------------------------------------------------- routes */

/** Read the route table from router.tsx so the gate follows new pages automatically. */
function routes() {
  const src = fs.readFileSync(ROUTER, 'utf8');
  const found = new Set();
  if (/index:\s*true/.test(src)) found.add('/');
  for (const m of src.matchAll(/\bpath:\s*'([^']*)'/g)) {
    const raw = m[1].trim();
    if (raw.includes(':')) continue;            // dynamic: resolved from the API below
    found.add('/' + raw.replace(/^\/+|\/+$/g, ''));
  }
  return [...found];
}

/* ------------------------------------------------------------- build / launch */

function run(label, args) {
  process.stdout.write(`[layout] ${label}…\n`);
  const res = spawnSync(args[0], args.slice(1), { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) {
    process.stderr.write(`[layout] ${label} failed (exit ${res.status})\n`);
    process.exit(res.status ?? 1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureBackend() {
  if (fs.existsSync(BACKEND)) return;
  if (process.env.AUDIT_CONTRAST_NO_BUILD) {
    process.stderr.write(`[layout] ${BACKEND} missing and AUDIT_CONTRAST_NO_BUILD=1\n`);
    process.exit(1);
  }
  run('staging the desktop backend', ['npm', 'run', 'build:desktop-backend']);
}

/** A real app: `cargo build` alone yields a dev-URL binary with no assets. */
function ensureApp() {
  if (fs.existsSync(EXE)) return;
  if (process.env.AUDIT_CONTRAST_NO_BUILD) {
    process.stderr.write(`[layout] ${EXE} missing and AUDIT_CONTRAST_NO_BUILD=1\n`);
    process.exit(1);
  }
  run('building the packaged app', ['npx', 'tauri', 'build', '--no-bundle']);
}

function freePort(start) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(freePort(start + 1)));
    s.listen(start, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function cdpTarget(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
      const page = targets.find((t) => t.type === 'page' && t.url.includes('tauri'));
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return null;
}

/* ------------------------------------------------------- in-page measurement */

/**
 * Runs inside the webview. Returns one bucket per failure mode, already
 * separated into fatal and non-fatal by the driver.
 */
const AUDIT_FN = `(() => {
  const TOL = ${TOL};
  const MIN = ${MIN_TEXT_PX};
  const out = { textNodes: 0, tinyText: 0, tinySamples: [], offscreen: [], clipped: [],
                overflow: [], artifacts: [], truncCount: 0, truncPx: 0, minFontPx: null,
                scale: null, vw: 0 };
  const de = document.documentElement;
  const vw = de.clientWidth;
  out.vw = vw;
  out.scale = (getComputedStyle(de).getPropertyValue('--type-scale') || '').trim();
  out.docOverflow = Math.max(0, de.scrollWidth - vw);

  // Any of these four can take a box outside its own layout box. Note that
  // Tailwind v4 emits \`-rotate-[225deg]\` as the standalone \`rotate\` property,
  // NOT \`transform: rotate(...)\`, so checking transform alone silently misses
  // every rotated element in the app.
  const displaced = (cs) =>
    (cs.transform && cs.transform !== 'none') ||
    (cs.rotate && cs.rotate !== 'none') ||
    (cs.scale && cs.scale !== 'none') ||
    (cs.translate && cs.translate !== 'none');

  const tag = (el) => el.tagName.toLowerCase();
  const cls = (el) => (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean);
  const desc = (el) => (tag(el) + (cls(el).slice(0, 6).length ? '.' + cls(el).slice(0, 6).join('.') : '')).slice(0, 150);
  const ancestry = (el) => {
    const p = [];
    for (let n = el, i = 0; n && n.tagName !== 'HTML' && i < 3; i++, n = n.parentElement) {
      p.push(desc(n));
    }
    return p.join(' < ');
  };
  const snippet = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 48);

  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;

    const scroller = /auto|scroll/.test(cs.overflowX);
    const clips = cs.overflowX === 'hidden' || cs.overflowY === 'hidden';
    const ellipsised = cs.textOverflow === 'ellipsis';
    const over = el.scrollWidth - el.clientWidth;

    if (!scroller && over > TOL && el.clientWidth > 0) {
      if (ellipsised) {
        out.truncCount++; out.truncPx += over;
      } else {
        // A displaced descendant's axis-aligned box is legitimately larger than
        // its layout box, and that inflates scrollWidth on every ancestor.
        //
        // The Gauge is the case in point: its <svg> is 190px wide but rotated
        // 225deg, so its bounding box is 190 * sqrt(2) ~= 269px, which reads as
        // a 39px overflow on the gauge and on each of three ancestors -- on
        // every page that shows a score. Nothing is actually painted outside:
        // the content is a circle, and a circle maps onto itself under
        // rotation, so the painted pixels stay inside the 190px box.
        //
        // Excusing it needs two conditions, or the gate excuses far too much:
        // a displaced descendant must exist, and its box must escape this
        // element's content edge by AT LEAST the reported overflow. That stops a
        // small rotated icon that pokes out by a pixel from masking a real 40px
        // overflow, and it keeps working for ancestors (which are wider than the
        // rotated box itself, so a "wider than the container" test would fail).
        const contentRight = r.left + el.clientLeft + el.clientWidth;
        let escape = -Infinity;
        for (const d of el.querySelectorAll('*')) {
          if (!displaced(getComputedStyle(d))) continue;
          escape = Math.max(escape, d.getBoundingClientRect().right - contentRight);
        }
        const excuse = escape >= over - TOL;
        const rec = { el: desc(el), path: ancestry(el), by: over, escape: escape === -Infinity ? 0 : Math.round(escape), text: snippet(el) };
        (excuse ? out.artifacts : out.overflow).push(rec);
      }
    }

    if (clips && !ellipsised && over > TOL && el.clientWidth > 0 && el.children.length === 0) {
      out.clipped.push({ el: desc(el), path: ancestry(el), by: over, text: snippet(el) });
    }

    if ((r.right > vw + TOL || r.left < -TOL) && r.width > 0) {
      out.offscreen.push({ el: desc(el), path: ancestry(el), left: Math.round(r.left), right: Math.round(r.right), vw });
    }
  }

  let min = Infinity;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n = w.nextNode();
  while (n) {
    const t = (n.nodeValue || '').trim();
    if (t && n.parentElement) {
      const cs = getComputedStyle(n.parentElement);
      if (cs.display !== 'none' && cs.visibility !== 'hidden') {
        const fs = parseFloat(cs.fontSize);
        if (!isNaN(fs)) {
          out.textNodes++;
          if (fs < min) min = fs;
          if (fs < MIN) {
            out.tinyText++;
            if (out.tinySamples.length < 4) {
              out.tinySamples.push({ fs: Math.round(fs * 10) / 10, text: t.replace(/\\s+/g, ' ').slice(0, 36), el: desc(n.parentElement) });
            }
          }
        }
      }
    }
    n = w.nextNode();
  }
  out.minFontPx = min === Infinity ? null : Math.round(min * 100) / 100;
  return out;
})()`;

/* -------------------------------------------------------------------- driver */

function die(msg) {
  process.stderr.write(`[layout] ${msg}\n`);
  process.exit(1);
}

async function main() {
  const list = routes();
  process.stdout.write(`[layout] routes: ${list.length} · widths: ${WIDTHS.join(', ')} · themes: ${THEMES.join(', ')}\n`);

  const reuse = Boolean(process.env.PROBE_PORT);
  const port = Number(process.env.PROBE_PORT) || (await freePort(9334));
  let child = null;
  let target = reuse ? await cdpTarget(port, 2) : null;

  if (!target) {
    ensureBackend();
    ensureApp();
    process.stdout.write(`[layout] launching the app with CDP on 127.0.0.1:${port}\n`);
    child = spawn(EXE, [], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    });
    target = await cdpTarget(port);
    if (!target) {
      child.kill();
      die('the app never exposed a CDP page (is another instance already running? it holds the single-instance lock)');
    }
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let mid = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => { const i = ++mid; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description?.split('\n')[0] ?? 'evaluate failed');
    }
    return r.result?.result?.value;
  };
  await send('Runtime.enable');

  // A dynamic route is only reachable with a real id, so ask the running backend
  // for one: the node detail page is covered rather than silently skipped.
  const nodeRoute = await evaluate(`(async () => {
    try {
      const m = await window.__TAURI__.core.invoke('bootstrap');
      const r = await fetch(m.api_base + '/nodes?limit=1', { headers: { authorization: 'Bearer ' + m.token } });
      if (!r.ok) return null;
      const j = await r.json();
      const n = (j.nodes || j.items || j.data || [])[0];
      return n ? '/nodes/' + encodeURIComponent(String(n.id)) : null;
    } catch { return null; }
  })()`);
  if (nodeRoute) list.push(nodeRoute);
  else process.stdout.write('[layout] no node id available; /nodes/:id is NOT covered\n');

  let emulating = false;

  /**
   * Resize, then confirm the viewport really moved. An unverified width would
   * mean the gate reports "clean at 1024" while having measured 1440 — worse
   * than no gate, because it looks like coverage.
   */
  async function setWidth(w) {
    let how = 'window-bounds';
    const gw = await send('Browser.getWindowForTarget', {});
    const winId = gw.result?.windowId;
    if (winId == null) how = 'emulation';
    else {
      const r = await send('Browser.setWindowBounds', { windowId: winId, bounds: { width: w, height: HEIGHT } });
      if (r.error) how = 'emulation';
    }
    if (how === 'emulation') {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
      emulating = true;
    }
    await sleep(800);
    const got = await evaluate('[innerWidth, document.documentElement.clientWidth]');
    if (!got) die(`could not read the viewport after asking for ${w}px`);
    const [inner, client] = got.map(Number);
    // A visible scrollbar costs a few px, so accept the viewport being at or
    // just under the request, but never the wrong width entirely.
    if (Math.abs(client - w) > 16 || Math.abs(inner - w) > 16) {
      die(`asked for a ${w}px viewport but the page is ${inner}/${client}px — refusing to measure the wrong width`);
    }
    return client;
  }

  const failures = [];
  let measured = 0;
  let minFont = Infinity;
  let artifacts = 0;
  let truncCount = 0;
  let truncPx = 0;
  let textNodes = 0;

  for (const width of WIDTHS) {
    const client = await setWidth(width);
    for (const theme of THEMES) {
      // Theme must be set without a reload afterwards; a reload resets the route.
      await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true`);
      await sleep(400);

      for (const route of list) {
        await evaluate(`history.pushState({}, '', ${JSON.stringify(route)}); window.dispatchEvent(new PopStateEvent('popstate')); true`);
        await sleep(route === '/' ? 2600 : 1700);
        // Expand collapsed sections so their content is really laid out, then
        // dismiss anything that opened, so we do not measure a search dialog.
        await evaluate(`(() => {
          for (const b of document.querySelectorAll('main [aria-expanded="false"]')) { try { b.click(); } catch {} }
          return true;
        })()`);
        await sleep(400);
        for (const type of ['keyDown', 'keyUp']) {
          await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        }
        await sleep(400);
        // Re-pin the scale: it is a user preference, and useTypeScaleApplier
        // would otherwise reinstate the stored one after a refetch mid-run.
        await evaluate(`document.documentElement.dataset.typeScale = 'default'; true`);
        await sleep(200);

        let m;
        try {
          m = await evaluate(AUDIT_FN);
        } catch (err) {
          failures.push({ theme, width, route, kind: 'probe-error', el: String(err.message) });
          process.stdout.write(`  FAIL ${theme.padEnd(5)} ${String(width).padEnd(4)} ${route.padEnd(30)} probe-error: ${err.message}\n`);
          continue;
        }
        measured++;
        textNodes += m.textNodes;
        if (m.minFontPx != null) minFont = Math.min(minFont, m.minFontPx);
        artifacts += m.artifacts.length;
        truncCount += m.truncCount;
        truncPx += m.truncPx;

        // A blank or errored page measures clean and means nothing.
        if (m.textNodes === 0) {
          failures.push({ theme, width, route, kind: 'blank', el: 'rendered no text at all' });
          process.stdout.write(`  FAIL ${theme.padEnd(5)} ${String(width).padEnd(4)} ${route.padEnd(30)} blank (no text rendered)\n`);
          continue;
        }
        if (m.scale !== '1') {
          failures.push({ theme, width, route, kind: 'scale', el: `--type-scale is ${m.scale}, expected 1` });
          process.stdout.write(`  FAIL ${theme.padEnd(5)} ${String(width).padEnd(4)} ${route.padEnd(30)} scale pin failed (--type-scale=${m.scale})\n`);
          continue;
        }

        const parts = [];
        if (m.docOverflow > TOL) parts.push(`docOverflow=${m.docOverflow}`);
        if (m.offscreen.length) parts.push(`offscreen=${m.offscreen.length}`);
        if (m.clipped.length) parts.push(`clipped=${m.clipped.length}`);
        if (m.overflow.length) parts.push(`overflow=${m.overflow.length}`);
        if (m.tinyText) parts.push(`tiny=${m.tinyText}`);

        if (parts.length) {
          for (const f of m.overflow) failures.push({ theme, width, route, kind: 'overflow', ...f });
          for (const f of m.offscreen) failures.push({ theme, width, route, kind: 'offscreen', ...f });
          for (const f of m.clipped) failures.push({ theme, width, route, kind: 'clipped', ...f });
          for (const f of m.tinySamples) failures.push({ theme, width, route, kind: 'tiny', ...f });
          if (m.docOverflow > TOL) {
            failures.push({ theme, width, route, kind: 'docOverflow', by: m.docOverflow, el: 'documentElement' });
          }
          process.stdout.write(`  FAIL ${theme.padEnd(5)} ${String(width).padEnd(4)} ${route.padEnd(30)} ${parts.join(' ')}\n`);
        } else {
          process.stdout.write(
            `  ok   ${theme.padEnd(5)} ${String(width).padEnd(4)} ${route.padEnd(30)} text=${m.textNodes} minFont=${m.minFontPx}px art=${m.artifacts.length} trunc=${m.truncCount}\n`,
          );
        }
      }
    }
  }

  if (emulating) await send('Emulation.clearDeviceMetricsOverride', {});
  ws.close();
  if (child) child.kill();
  await sleep(600);

  const combos = THEMES.length * WIDTHS.length * list.length;
  process.stdout.write(`\n[layout] measured ${measured}/${combos} combinations · ${textNodes} text nodes · smallest font ${minFont === Infinity ? 'n/a' : minFont + 'px'}\n`);
  process.stdout.write(`[layout] non-fatal: ${artifacts} rotated-element artifact(s), ${truncCount} deliberate truncation(s) hiding ${truncPx}px\n`);

  // A gate that measured nothing must not pass: cheap insurance against a probe
  // that silently stopped working.
  if (measured < combos) {
    process.stderr.write(`[layout] only ${measured}/${combos} combinations measured — refusing to pass.\n`);
    process.exit(1);
  }

  if (failures.length) {
    const byKind = new Map();
    for (const f of failures) {
      const key = `${f.kind}  ${f.el ?? ''}`.trim();
      if (!byKind.has(key)) byKind.set(key, { n: 0, sample: f });
      byKind.get(key).n += 1;
    }
    process.stderr.write('\n[layout] FAIL — grouped by cause:\n');
    for (const [key, v] of [...byKind].sort((a, b) => b[1].n - a[1].n)) {
      const s = v.sample;
      const explain =
        s.kind === 'tiny' ? `${s.fs}px is under the ${MIN_TEXT_PX}px floor: "${s.text}"`
        : s.kind === 'docOverflow' ? `the document scrolls ${s.by}px sideways`
        : s.kind === 'probe-error' || s.kind === 'blank' || s.kind === 'scale' ? s.el
        : `${s.by ?? ''}${s.by ? 'px ' : ''}"${s.text ?? ''}" — in ${s.path ?? ''}`;
      process.stderr.write(`  ${String(v.n).padStart(3)}x  ${key}\n         eg ${explain}\n         on ${s.theme} ${s.width}px ${s.route}\n`);
    }
    process.stderr.write(`\n[layout] ${failures.length} failure(s). Floor ${MIN_TEXT_PX}px, tolerance ${TOL}px.\n`);
    process.exit(1);
  }

  process.stdout.write(
    `[layout] PASS — no horizontal overflow and nothing under ${MIN_TEXT_PX}px, at ${WIDTHS.join(' and ')} in ${THEMES.join(' and ')}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[layout] ${err?.stack ?? err}\n`);
  process.exit(1);
});
