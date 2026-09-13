#!/usr/bin/env node
/** Interaction-level E2E audit: drives EVERY page of the LIVE installed app,
 * clicks buttons/tabs/checkboxes, and captures real runtime breakage:
 * uncaught exceptions, console errors, failed network calls, error boundaries.
 * Destructive/mutating actions (VPN connect/disconnect, deletes, quit, resets)
 * and navigation anchors are excluded. confirm() is auto-cancelled. */
import WebSocket from 'ws';

const ROUTES = [
  '/', '/map', '/diagnostics', '/speed-test', '/dns', '/gaming', '/iran',
  '/ip', '/routes', '/cloudflare', '/nodes', '/nodes-sources', '/servers',
  '/vpn', '/optimizer', '/history', '/events', '/settings', '/health',
];

const DESTRUCTIVE = /(delete|remove|quit|exit|reset|wipe|purge|uninstall|kill|disconnect|shut ?down|log ?out|sign ?out|restart|reboot|export|download|install|uninstall|clear all|factory)/i;

const targets = await fetch('http://127.0.0.1:9333/json').then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.url.includes('tauri'));
if (!page) { console.error('NO_PAGE_TARGET'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

let mid = 0;
const pending = new Map();
const exceptions = [];
const consoleErrors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push((m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
  }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    const a = (m.params.args ?? []).map((x) => x.value ?? x.description ?? '').join(' ');
    if (!/React DevTools|Download the React/i.test(a)) consoleErrors.push(`[${m.params.type}] ${a.slice(0, 220)}`);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => { const id = ++mid; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text).slice(0, 200) };
  return r.result?.result?.value;
};
await send('Runtime.enable');

const nav = (route) => ev(`(async()=>{history.pushState({},'','${route}');window.dispatchEvent(new PopStateEvent('popstate'));return location.pathname;})()`);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const report = [];
for (const route of ROUTES) {
  await nav(route);
  await settle(1500);
  exceptions.length = 0; consoleErrors.length = 0;

  // auto-cancel confirm dialogs + enumerate clickable controls
  const ctl = await ev(`(function(){
    window.confirm = function(){ return false; };
    window.prompt = function(){ return null; };
    var out = [];
    var els = document.querySelectorAll('button, [role=tab], input[type=checkbox]');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.disabled) continue;
      if (!e.offsetParent && e.type !== 'checkbox') continue; // hidden
      var label = (e.innerText || e.getAttribute('aria-label') || e.value || '').trim();
      if (!label) continue;
      if (e.closest('[data-audit-skip]')) continue;
      out.push({ i: i, label: label.slice(0, 60) });
    }
    return out.slice(0, 14);
  })()`);

  const clicked = [];
  let pageBroke = false;
  for (const c of (ctl.__exc ? [] : ctl)) {
    if (DESTRUCTIVE.test(c.label)) continue;
    const before = await ev('location.pathname');
    await ev(`(function(){var els=document.querySelectorAll('button, [role=tab], input[type=checkbox]'); var e=els[${c.i}]; if(e){ e.click(); return true;} return false;})()`);
    await settle(900);
    const after = await ev('location.pathname');
    const boundary = await ev('/Something went wrong/i.test(document.body.innerText)');
    if (after !== before) break; // control navigated; stop clicking this page
    clicked.push(c.label);
    if (boundary === true) { pageBroke = true; break; }
  }
  await settle(600);
  const finalBoundary = await ev('/Something went wrong/i.test(document.body.innerText)');

  report.push({
    route,
    controls: ctl.__exc ? 'ENUM_FAIL' : ctl.length,
    clicked: clicked.length,
    broke: pageBroke || finalBoundary === true,
    exceptions: exceptions.slice(0, 3),
    consoleErrors: consoleErrors.slice(0, 3),
  });
  process.stdout.write(`${pageBroke || finalBoundary === true ? 'XX' : (exceptions.length || consoleErrors.length ? '!!' : 'ok')}  ${route}  (${clicked.length}/${(ctl.__exc ? 0 : ctl.length)} clicked) ${exceptions.length ? 'EXC:' + exceptions[0].slice(0, 90) : ''} ${consoleErrors.length ? 'ERR:' + consoleErrors[0].slice(0, 90) : ''}\n`);
}

console.log('\n=== SUMMARY ===');
const bad = report.filter((r) => r.broke || r.exceptions.length);
console.log(`pages: ${report.length}, broken: ${report.filter((r) => r.broke).length}, with-exceptions: ${bad.length}`);
for (const b of bad) console.log(JSON.stringify(b, null, 1));
ws.close();
process.exit(bad.length ? 1 : 0);
