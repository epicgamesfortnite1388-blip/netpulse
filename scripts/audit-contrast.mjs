#!/usr/bin/env node
/**
 * Text-contrast gate: every visible text node in the web app must meet WCAG AA
 * in BOTH themes (dark and light). Walks every route of the real packaged
 * desktop app over CDP and fails on any sub-AA text.
 *
 * Why this exists: the light theme shipped in Settings but was never checked.
 * The dark theme passes; the light one silently shipped 1,448 sub-AA text
 * nodes (worst 1.08:1) because almost every failure came from three roots —
 * a too-light `--color-faint`, Badge tones that were not token-driven, and
 * hardcoded `text-white` on themed surfaces. This gate makes that class of
 * bug impossible to reintroduce.
 *
 * Contrast is measured the way a reader actually sees it: every background is
 * composited with alpha over its ancestors before the ratio is computed.
 * Ignoring alpha (measuring `bg-ok/10` as if it were opaque) reports false
 * failures, which is how an earlier ad-hoc probe mis-scored the app.
 *
 * The same walk also checks custom-property integrity: a `var()` reference
 * that resolves to nothing makes its declaration fall back to `inherit` or
 * `initial` rather than erroring, so a token name that does not exist paints
 * silently in the wrong colour (that is how `border-[var(--border)]` drew
 * hairlines in body-text colour and `bg-[var(--bg-inset)]` painted
 * transparent). That failure is invisible to text contrast, so it is gated
 * here too, in both themes.
 *
 * Usage:
 *   node scripts/audit-contrast.mjs                 # build+launch if needed
 *   PROBE_PORT=9334 node scripts/audit-contrast.mjs # reuse a running app
 *   AUDIT_CONTRAST_NO_BUILD=1 node scripts/audit-contrast.mjs
 *
 * Exit code 0 = every text node meets AA in both themes and no var() falls
 * back to inherit/initial; 1 = failures.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { appFreshness } from './lib/fresh-app.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.join(root, 'src-tauri', 'target', 'release', 'netpulse-desktop.exe');
const BACKEND = path.join(root, 'src-tauri', 'backend', 'netpulse-backend.js');
const ROUTER = path.join(root, 'apps', 'web', 'src', 'app', 'router.tsx');
const THEMES = ['dark', 'light'];

/** WCAG 2.1 AA: 4.5:1 normal text, 3:1 for large text (>=24px, or >=18.66px bold). */
const AA_NORMAL = 4.5;
const AA_LARGE = 3;
const LARGE_PX = 24;
const LARGE_BOLD_PX = 18.66;

/* ------------------------------------------------------------------ routes */

/** Read the route table out of router.tsx so the gate follows new pages. */
function routes() {
  const src = fs.readFileSync(ROUTER, 'utf8');
  const found = new Set();
  if (/index:\s*true/.test(src)) found.add('/');
  for (const m of src.matchAll(/\bpath:\s*'([^']*)'/g)) {
    const raw = m[1].trim();
    if (raw.includes(':')) continue;          // dynamic: resolved separately
    found.add('/' + raw.replace(/^\/+|\/+$/g, ''));
  }
  return [...found];
}

/* ------------------------------------------------------------- build/launch */

function run(label, args, opts = {}) {
  process.stdout.write(`[contrast] ${label}…\n`);
  const res = spawnSync(args[0], args.slice(1), { cwd: root, stdio: 'inherit', shell: false, ...opts });
  if (res.status !== 0) {
    process.stderr.write(`[contrast] ${label} failed (exit ${res.status})\n`);
    process.exit(res.status ?? 1);
  }
}

/** The sidecar bundle the app falls back to when run from the repo. */
function ensureBackend() {
  if (fs.existsSync(BACKEND)) return;
  if (process.env.AUDIT_CONTRAST_NO_BUILD) {
    process.stderr.write(`[contrast] ${BACKEND} is missing and AUDIT_CONTRAST_NO_BUILD=1; cannot run\n`);
    process.exit(1);
  }
  run('staging the desktop backend (npm run build:desktop-backend)', ['npm', 'run', 'build:desktop-backend']);
}

/** A real app: `cargo build` alone yields a dev-URL binary with no assets.
 *  It must also be a CURRENT app — see scripts/lib/fresh-app.mjs. */
function ensureApp() {
  const noBuild = Boolean(process.env.AUDIT_CONTRAST_NO_BUILD);
  const verdict = appFreshness({ root, exe: EXE, noBuild });
  if (verdict.fresh) {
    process.stdout.write(`[contrast] binary is fresh (newer than ${path.relative(root, verdict.newest.file)})\n`);
    return;
  }
  if (noBuild) {
    process.stderr.write(`[contrast] binary is ${verdict.reason} and AUDIT_CONTRAST_NO_BUILD=1; cannot run\n`);
    process.exit(1);
  }
  run(`binary is ${verdict.reason}, building the packaged app (npx tauri build --no-bundle)`, ['npx', 'tauri', 'build', '--no-bundle']);
  const after = appFreshness({ root, exe: EXE, noBuild: true });
  if (!after.fresh) {
    process.stderr.write(`[contrast] the build did not produce a binary newer than its sources (${after.reason})\n`);
    process.exit(1);
  }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 * Runs in the webview. For every element that directly renders text, resolve the
 * colour it is actually painted on by compositing each ancestor's background
 * (with alpha) down to the first opaque one, then compare.
 */
const AUDIT_FN = `(() => {
  // Convert any CSS colour the browser understands into sRGB + alpha by
  // painting it: Tailwind v4 emits oklch()/lab() for many tokens, and parsing
  // those as if they were "r,g,b" numbers silently mis-scores them.
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const parse = (c) => {
    if (!c || c === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    if (d[3] === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  // What is this text painted on? Walk up compositing translucent layers.
  const backdrop = (el) => {
    const stack = [];
    let node = el;
    while (node && node !== document.documentElement.parentNode) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) {
        stack.push(bg);
        if (bg.a === 1) break;
      }
      node = node.parentElement;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length) continue;                 // only direct text
    const text = (el.textContent || '').trim();
    if (!text) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;  // not rendered
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.opacity === '0') continue;
    const fg = parse(s.color);
    if (!fg) continue;
    const bg = backdrop(el);
    const painted = fg.a < 1 ? over(fg, bg) : fg;
    const r = ratio(painted, bg);
    const size = parseFloat(s.fontSize);
    const weight = parseInt(s.fontWeight, 10) || 400;
    const large = size >= ${LARGE_PX} || (weight >= 700 && size >= ${LARGE_BOLD_PX});
    const need = large ? ${AA_LARGE} : ${AA_NORMAL};
    if (r + 0.005 < need) {
      out.push({
        text: text.slice(0, 40),
        ratio: Math.round(r * 100) / 100,
        need,
        size: Math.round(size * 10) / 10,
        cls: String(el.className).slice(0, 72),
        fg: s.color,
        bg: 'rgb(' + [Math.round(bg.r), Math.round(bg.g), Math.round(bg.b)].join(', ') + ')',
      });
    }
  }
  return out;
})()`;

/* ------------------------------------------------- custom-property integrity */

/**
 * Runs in the webview. A `var()` that resolves to nothing does not leave the
 * declaration empty -- the property drops to its initial/inherited value. For
 * an inherited property that means `inherit`, for a non-inherited one
 * `initial`. That is exactly how a missing border token ends up painting
 * `currentColor` and a missing background token ends up transparent, and it
 * is invisible both to review and to the text-contrast gate above. This check
 * makes that class of bug fail CI.
 *
 * Two independent signals:
 *   missing  a var() referenced by any rule that is never declared anywhere.
 *            Viewport-independent, so this has full coverage.
 *   live     a rule that matches an element *right now* whose var() does not
 *            resolve on that element, i.e. the silent fallback is in effect.
 *            Only rules under a currently-matching @media/@supports qualify,
 *            otherwise every `xl:` variant would report while the window is
 *            narrow.
 *
 * `var(--x, fallback)` is exempt: an explicit fallback is a deliberate choice,
 * not a silent one, and the app uses that form on purpose.
 *
 * @property rules count as declarations. Tailwind v4 emits 57 of them
 * (--tw-translate-x and friends); missing them would report every utility
 * that references a --tw-* variable as undeclared.
 */
const VARS_FN = String.raw`(() => {
  const declared = new Set();
  const allRules = [];   // every style rule, active or not
  const liveRules = [];  // only rules that can apply at the current viewport
  let sheetCount = 0;
  let ruleCount = 0;
  let refTotal = 0;

  const RE = /var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g;

  const scan = (list, active) => {
    for (const rule of list) {
      ruleCount++;
      if (rule.syntax && rule.name) {
        declared.add(rule.name.charAt(0) === '-' ? rule.name : '--' + rule.name);
      }
      if (rule.style && rule.style.length) {
        const props = [];
        for (let i = 0; i < rule.style.length; i++) {
          const p = rule.style[i];
          const v = rule.style.getPropertyValue(p);
          if (p.charAt(0) === '-' && p.charAt(1) === '-') declared.add(p);
          props.push({ p: p, v: v });
        }
        if (rule.selectorText) {
          // References are read from cssText, NOT from rule.style. Chromium
          // expands "border-color: var(--x)" into four longhands whose
          // specified values read back EMPTY when --x does not resolve, so
          // iterating rule.style misses exactly the shorthand case that caused
          // the original bug (a border token silently painting currentColor).
          const entry = { sel: rule.selectorText, raw: rule.cssText || '', props: props };
          allRules.push(entry);
          if (active) liveRules.push(entry);
        }
      }
      if (rule.cssRules) {
        let childActive = active;
        try {
          if (rule.media && rule.media.mediaText) {
            childActive = active && window.matchMedia(rule.media.mediaText).matches;
          } else if (rule.conditionText) {
            childActive = active && CSS.supports(rule.conditionText);
          }
        } catch (e) { /* leave childActive as-is */ }
        try { scan(rule.cssRules, childActive); } catch (e) {}
      }
    }
  };

  for (const sheet of document.styleSheets) {
    let list;
    try { list = sheet.cssRules; } catch (e) { continue; }  // cross-origin sheet
    if (!list) continue;
    sheetCount++;
    scan(list, true);
  }

  const missing = [];
  const fallbackOnly = [];
  const seenRef = new Set();
  const noteRef = (name, hasFallback, where, snippet) => {
    refTotal++;
    if (declared.has(name)) return;
    const key = name + '|' + (hasFallback ? 'fb' : 'no');
    if (seenRef.has(key)) return;
    seenRef.add(key);
    (hasFallback ? fallbackOnly : missing).push({ name: name, where: where, snippet: snippet });
  };
  const eachRef = (r, fn) => {
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(r.raw))) {
      fn(
        m[1],
        m[2] === ',',
        r.sel,
        r.raw.slice(Math.max(0, m.index - 24), m.index + 46).replace(/\s+/g, ' '),
      );
    }
  };

  for (const r of allRules) eachRef(r, noteRef);

  // Inline style attributes carry var() too and live in no stylesheet.
  for (const el of document.querySelectorAll('[style]')) {
    const v = el.getAttribute('style') || '';
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(v))) {
      noteRef(m[1], m[2] === ',', 'inline style on <' + el.tagName.toLowerCase() + '>');
    }
  }

  // Class names are extracted from the ESCAPED selectorText and matched with
  // getElementsByClassName rather than querySelector. Both alternatives fail:
  // the escaped form (.text-\[var\(--x\)\]) matches no element, and the
  // unescaped form (.text-[var(--x)]) is not a valid selector because [...] is
  // attribute-selector syntax. So a querySelector-based live check silently
  // matches nothing for every arbitrary-value and opacity utility -- exactly
  // the classes most likely to carry a var().
  const classesOf = (sel) => {
    const out = [];
    let i = 0;
    while (i < sel.length) {
      if (sel[i] === '\\') { i += 2; continue; }
      if (sel[i] === '.') {
        i++;
        let seg = '';
        while (i < sel.length) {
          const c = sel[i];
          if (c === '\\') { seg += c + sel[i + 1]; i += 2; continue; }
          if (c === ':' || c === '[' || c === ']' || c === '>' || c === '+' ||
              c === '~' || c === ',' || c === ' ' || c === '\t') break;
          seg += c;
          i++;
        }
        const name = seg.replace(/\\(.)/g, '$1');
        if (name) out.push(name);
        continue;
      }
      i++;
    }
    return out;
  };

  const live = [];
  const seenLive = new Set();
  for (const r of liveRules) {
    const names = classesOf(r.sel);
    let el = null;
    for (const n of names) {
      const found = document.getElementsByClassName(n);
      if (found.length) { el = found[0]; break; }
    }
    if (!el) continue;
    const cs = getComputedStyle(el);
    eachRef(r, (name, hasFallback, _sel, snippet) => {
      if (hasFallback) return;                          // explicit fallback
      if (cs.getPropertyValue(name).trim()) return;     // resolves fine
      const key = name + '|' + names.join('.');
      if (seenLive.has(key)) return;
      seenLive.add(key);
      live.push({
        name: name, sel: names.join('.'), snippet: snippet,
        tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60),
      });
    });
  }

  return {
    sheets: sheetCount,
    rules: ruleCount,
    declared: declared.size,
    refs: refTotal,
    missing: missing,
    fallbackOnly: fallbackOnly,
    live: live,
    // A vacuous pass is worse than no gate at all, so prove the scan really
    // read the stylesheet and really parsed var() references out of it.
    selfCheck: {
      sawStylesheet: sheetCount > 0 && ruleCount > 50,
      sawThemeToken: declared.has('--color-text') && declared.has('--color-accent'),
      sawVarRef: refTotal > 0,
    },
  };
})()`;

/* ------------------------------------------------------------------- driver */

async function main() {
  const list = routes();
  process.stdout.write(`[contrast] routes: ${list.length} (${list.join(' ')})\n`);

  const port = Number(process.env.PROBE_PORT || 0) || (await freePort(9334));
  let child = null;
  let target = process.env.PROBE_PORT ? await cdpTarget(port, 2) : null;

  if (!target) {
    ensureBackend();
    ensureApp();
    process.stdout.write(`[contrast] launching the app with CDP on 127.0.0.1:${port}\n`);
    child = spawn(EXE, [], {
      cwd: root,
      detached: false,
      stdio: 'ignore',
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    });
    target = await cdpTarget(port);
    if (!target) {
      if (child) child.kill();
      process.stderr.write('[contrast] the app never exposed a CDP page\n');
      process.exit(1);
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
  const send = (method, params = {}) => new Promise((r) => { const i = ++mid; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed');
    return r.result?.result?.value;
  };

  await send('Runtime.enable');

  // A dynamic route (nodes/:id) is only reachable with a real id — ask the
  // running backend for one so the detail page is covered too, not skipped.
  const nodeId = await evaluate(`(async () => {
    try {
      const m = await window.__TAURI__.core.invoke('bootstrap');
      const r = await fetch(m.api_base + '/nodes?limit=1', { headers: { authorization: 'Bearer ' + m.token } });
      if (!r.ok) return null;
      const j = await r.json();
      const n = (j.nodes || j.items || j.data || [])[0];
      return n ? String(n.id) : null;
    } catch { return null; }
  })()`);
  if (nodeId) list.push('/nodes/' + encodeURIComponent(nodeId));
  else process.stdout.write('[contrast] no node id available; the nodes/:id route is not covered\n');

  const failures = [];
  const varFailures = [];
  const missingSeen = new Set();
  const fallbackSeen = new Set();
  const liveSeen = new Set();
  let scChecked = false;
  let varStats = { declared: 0, sheets: 0, rules: 0, refs: 0 };
  for (const theme of THEMES) {
    // useTheme.ts applies the theme by setting this attribute; do the same
    // without persisting a settings change.
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; 1`);
    await sleep(400);
    let themeTotal = 0;
    for (const route of list) {
      await evaluate(`history.pushState({}, '', ${JSON.stringify(route)}); window.dispatchEvent(new PopStateEvent('popstate')); 1`);
      await sleep(route === '/' ? 2600 : 1700);
      let found = [];
      try {
        found = (await evaluate(AUDIT_FN)) ?? [];
      } catch (err) {
        process.stderr.write(`[contrast] ${theme} ${route}: ${err.message}\n`);
      }
      themeTotal += found.length;
      if (found.length) {
        const worst = [...found].sort((a, b) => a.ratio - b.ratio)[0];
        process.stdout.write(
          `  ${theme.padEnd(5)} ${route.padEnd(15)} sub-AA=${String(found.length).padStart(4)}  worst ${worst.ratio}:1 (need ${worst.need}) "${worst.text}" [${worst.cls}]\n`,
        );
        for (const f of found) failures.push({ theme, route, ...f });
      } else {
        process.stdout.write(`  ${theme.padEnd(5)} ${route.padEnd(15)} sub-AA=   0\n`);
      }

      // Custom-property integrity, evaluated on this route's live DOM. The
      // "does not resolve right now" half is per-route by nature: whether a
      // rule has a matching element depends entirely on what the page
      // rendered, so running it once per theme would only ever see whichever
      // route happened to be last.
      let vres;
      try {
        vres = await evaluate(VARS_FN);
      } catch (err) {
        throw new Error(`custom-property audit threw at ${theme} ${route}: ${err.message}`);
      }
      if (!scChecked) {
        const sc = vres.selfCheck || {};
        if (!sc.sawStylesheet || !sc.sawThemeToken || !sc.sawVarRef) {
          throw new Error(
            `custom-property audit self-check failed (stylesheet=${sc.sawStylesheet} ` +
            `themeToken=${sc.sawThemeToken} varRef=${sc.sawVarRef}) -- the check would pass vacuously`,
          );
        }
        scChecked = true;
      }
      varStats = {
        declared: vres.declared,
        sheets: vres.sheets,
        rules: vres.rules,
        refs: Math.max(varStats.refs, vres.refs),
      };
      for (const m of vres.missing) {
        if (!missingSeen.has(m.name)) {
          missingSeen.add(m.name);
          varFailures.push({ theme, kind: 'undeclared', ...m });
        }
      }
      for (const f of vres.fallbackOnly) fallbackSeen.add(f.name);
      for (const l of vres.live) {
        const k = theme + '|' + l.name + '|' + l.snippet;
        if (liveSeen.has(k)) continue;
        liveSeen.add(k);
        varFailures.push({ theme, kind: 'unresolvable', ...l });
      }
    }
    process.stdout.write(`[contrast] ${theme}: ${themeTotal} sub-AA text node(s)\n`);
    process.stdout.write(
      `[contrast] ${theme}: ${varStats.declared} custom properties declared across ` +
      `${varStats.sheets} sheet(s)/${varStats.rules} rules, ${varStats.refs} var() reference(s), ` +
      `${missingSeen.size} undeclared, ${varFailures.filter((f) => f.theme === theme && f.kind === 'unresolvable').length} unresolvable in a live rule\n`,
    );
    if (fallbackSeen.size) {
      process.stdout.write(
        `[contrast] ${theme}: ${fallbackSeen.size} undeclared var() reference(s) carry an explicit ` +
        `fallback (allowed, not a silent failure): ${[...fallbackSeen].join(', ')}\n`,
      );
    }
  }

  ws.close();
  if (child) child.kill();
  await sleep(600);

  if (varFailures.length) {
    const byVar = new Map();
    for (const f of varFailures) {
      const k = `${f.kind === 'undeclared' ? 'never declared' : 'does not resolve'}  ${f.name}`;
      if (!byVar.has(k)) byVar.set(k, { n: 0, sample: f });
      byVar.get(k).n += 1;
    }
    process.stderr.write('\n[contrast] FAIL — custom properties referenced but not usable:\n');
    for (const [k, v] of [...byVar].sort((a, b) => b[1].n - a[1].n)) {
      const s = v.sample;
      const where = `${s.sel || ''}  ${s.snippet || s.where || ''}`.trim();
      process.stderr.write(`  ${String(v.n).padStart(3)}x  ${k}\n         at ${where}\n`);
    }
    process.stderr.write(
      `\n[contrast] ${varFailures.length} custom-property failure(s). A var() that does not ` +
      `resolve makes the declaration fall back to inherit/initial, which is why it renders ` +
      `instead of erroring.\n`,
    );
  }

  if (failures.length) {
    const byClass = new Map();
    for (const f of failures) {
      const k = `${f.theme}  ${f.cls}`;
      if (!byClass.has(k)) byClass.set(k, { n: 0, sample: f });
      byClass.get(k).n += 1;
    }
    process.stderr.write('\n[contrast] FAIL — sub-AA text, grouped by cause:\n');
    for (const [k, v] of [...byClass].sort((a, b) => b[1].n - a[1].n).slice(0, 25)) {
      const s = v.sample;
      process.stderr.write(
        `  ${String(v.n).padStart(4)}x  ${k}\n         eg "${s.text}" ${s.ratio}:1 fg=${s.fg} bg=${s.bg} size=${s.size}px\n`,
      );
    }
    process.stderr.write(`\n[contrast] ${failures.length} failing node(s). AA needs ${AA_NORMAL}:1 (normal) / ${AA_LARGE}:1 (large).\n`);
  }
  if (failures.length || varFailures.length) process.exit(1);
  process.stdout.write(
    '[contrast] PASS — every text node meets AA in dark and light, ' +
    'and no var() reference falls back to inherit/initial\n',
  );
}

main().catch((err) => {
  process.stderr.write(`[contrast] ${err?.stack ?? err}\n`);
  process.exit(1);
});
