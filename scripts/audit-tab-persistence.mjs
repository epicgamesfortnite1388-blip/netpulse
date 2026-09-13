#!/usr/bin/env node
/** E2E regression: UI state must survive tab switches on the installed app.
 *
 * Covers the two failure classes behind "when I switch tabs everything resets":
 *   1. Form/filter persistence — user-controlled state round-trips through
 *      sessionStorage-backed usePersistentState and holds on remount.
 *   2. In-flight re-attachment — a background test started before navigating
 *      away keeps its persisted testId; the page re-attaches on return (live
 *      spinner) and the finished result re-renders after completion.
 *
 * Prerequisite: launch the app with
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
 */
import WebSocket from 'ws';

const targets = await fetch('http://127.0.0.1:9333/json').then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.url.includes('tauri'));
if (!page) { console.error('NO_PAGE_TARGET'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

let mid = 0;
const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++mid; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description ?? 'exception' };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nav = (path) => ev(`(function(){ const a = Array.from(document.querySelectorAll('a')).find(x => x.getAttribute('href') === '${path}'); if (a) { a.click(); return true; } return false; })()`);

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : '')); };

/* ---------- 1. filter/form persistence round-trips ---------- */

await nav('/nodes');
await sleep(2500);
await ev(`(function(){ const inp = document.querySelector('input[placeholder*="fingerprint" i]'); if (inp) { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; setter.call(inp,'wireguard'); inp.dispatchEvent(new Event('input',{bubbles:true})); } return !!inp; })()`);
await sleep(800);
const searchBefore = await ev(`(document.querySelector('input[placeholder*="fingerprint" i]')||{}).value ?? null`);

await nav('/cloudflare');
await sleep(2000);
await ev(`(function(){ const t = document.querySelectorAll('textarea')[0]; if (t) { const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; setter.call(t,'104.16.0.0/24\\n172.64.0.0/24'); t.dispatchEvent(new Event('input',{bubbles:true})); } return !!t; })()`);
await sleep(400);
const cidrBefore = await ev(`(document.querySelectorAll('textarea')[0]||{}).value ?? null`);

// THE round-trip
await nav('/');
await sleep(1500);
await nav('/nodes');
await sleep(2500);
const searchAfter = await ev(`(document.querySelector('input[placeholder*="fingerprint" i]')||{}).value ?? null`);
check('explorer search survives round-trip', searchBefore === 'wireguard' && searchAfter === 'wireguard', `before=${JSON.stringify(searchBefore)} after=${JSON.stringify(searchAfter)}`);

await nav('/cloudflare');
await sleep(2200);
const cidrAfter = await ev(`(document.querySelectorAll('textarea')[0]||{}).value ?? null`);
check('cloudflare CIDR form survives round-trip', cidrBefore !== null && cidrAfter === cidrBefore, `before=${JSON.stringify((cidrBefore || '').slice(0, 40))} after=${JSON.stringify((cidrAfter || '').slice(0, 40))}`);

const ss = await ev(`({
  nodesSearch: sessionStorage.getItem('np.ui.nodes.search'),
  cfCidr: sessionStorage.getItem('np.ui.cf.cidrText') !== null,
})`);
check('sessionStorage keys present', Boolean(ss) && ss.nodesSearch === '"wireguard"' && ss.cfCidr === true, JSON.stringify(ss));

/* ---------- 2. in-flight test re-attachment ---------- */

await nav('/speed-test');
await sleep(2000);
const clicked = await ev(`(function(){ const btn = Array.from(document.querySelectorAll('button')).find(b => /run speed test|measuring/i.test(b.textContent || '')); if (btn) { btn.click(); return true; } return false; })()`);
await sleep(2500);
const idStored = await ev(`sessionStorage.getItem('np.ui.speed.testId')`);
check('speed test starts and testId persists', clicked === true && typeof idStored === 'string' && idStored.includes('"'), `id=${idStored}`);

await nav('/');
await sleep(1200);
await nav('/speed-test');
await sleep(2000);
const spin = await ev(`!!document.querySelector('.animate-spin')`);
const idStill = await ev(`sessionStorage.getItem('np.ui.speed.testId')`);
check('running test re-attaches after tab switch', spin === true && idStill === idStored, `spinner=${spin} id=${idStill}`);

let finished = false;
for (let i = 0; i < 20; i++) {
  await sleep(3000);
  const s = await ev(`!!document.querySelector('.animate-spin')`);
  if (!s) { finished = true; break; }
}
const showsResult = await ev(`/Mbps/i.test(document.body.innerText)`);
const idKept = await ev(`sessionStorage.getItem('np.ui.speed.testId') !== null`);
check('test completes, result renders, id kept for redisplay', finished === true && showsResult === true && idKept === true, `finished=${finished} result=${showsResult} idKept=${idKept}`);

/* ---------- summary ---------- */
console.log('---');
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? `ALL PASS (${results.length}/${results.length})` : `${results.length - failed.length}/${results.length} passed`);
ws.close();
process.exit(failed.length === 0 ? 0 : 1);
