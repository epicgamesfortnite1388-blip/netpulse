#!/usr/bin/env node
/** Late-render crash probe: for every page with an async "run test" button,
 * click Run, WAIT for the test to finish (progress banner disappears), then
 * check for error boundary / exceptions. Catches crashes that happen when the
 * completed payload renders — the class the fast crawl missed. */
import WebSocket from 'ws';

const PAGES = [
  { route: '/optimizer', label: 'Run optimization', max: 90_000 },
  { route: '/speed-test', label: 'Start', max: 90_000 },
  { route: '/diagnostics', label: 'Run', max: 120_000 },
  { route: '/routes', label: 'Trace', max: 90_000 },
];

const targets = await fetch('http://127.0.0.1:9333/json').then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.url.includes('tauri'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

let mid = 0;
const pending = new Map();
const consoleErrors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const a = (m.params.args ?? []).map((x) => x.value ?? x.description ?? '').join(' ');
    consoleErrors.push(a.slice(0, 300));
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => { const id = ++mid; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __exc: (r.result.exceptionDetails.exception?.description ?? '').slice(0, 200) };
  return r.result?.result?.value;
};
await send('Runtime.enable');
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const findings = [];
for (const p of PAGES) {
  await ev(`(async()=>{history.pushState({},'','${p.route}');window.dispatchEvent(new PopStateEvent('popstate'));})()`);
  await settle(1500);
  consoleErrors.length = 0;

  // find a button whose label contains the target text (skip sidebar "Commands")
  const btn = await ev(`(function(){
    var els=document.querySelectorAll('button');
    for(var i=0;i<els.length;i++){
      var e=els[i]; if(e.disabled) continue; if(!e.offsetParent) continue;
      var t=(e.innerText||'').trim();
      if(t.indexOf(${JSON.stringify(p.label)})>=0 && i>0) return i;
    }
    return -1;
  })()`);
  if (btn === -1 || btn.__exc) { console.log(`?? ${p.route}: run button not found (${JSON.stringify(btn)})`); continue; }

  await ev(`(function(){window.confirm=function(){return false;};var els=document.querySelectorAll('button');els[${btn}].click();})()`);
  console.log(`.. ${p.route}: clicked "${p.label}", waiting up to ${p.max / 1000}s for completion`);
  const deadline = Date.now() + p.max;
  let sawProgress = false;
  let boundary = false;
  while (Date.now() < deadline) {
    await settle(2000);
    const st = await ev(`(function(){
      var t=document.body.innerText;
      return {
        progress: /%|Measuring|Testing|Running|Tracing/i.test(t),
        boundary: /Unexpected Application Error/i.test(t),
        empty: /No optimization run yet|No test yet|not been run/i.test(t)
      };
    })()`);
    if (st.boundary) { boundary = true; break; }
    if (st.progress) sawProgress = true;
    else if (sawProgress) break; // progress ended = test finished
  }
  await settle(1200); // let the final payload render
  const finalBoundary = await ev('/Unexpected Application Error/i.test(document.body.innerText)');
  const bad = boundary || finalBoundary === true || consoleErrors.some((c) => /ErrorBoundary|TypeError|Cannot read|Cannot convert/.test(c));
  console.log(`${bad ? 'XX' : 'ok'} ${p.route}: boundary=${finalBoundary}${consoleErrors.length ? ' cerr=' + consoleErrors[0].slice(0, 120) : ''}`);
  if (bad) findings.push({ route: p.route, boundary: finalBoundary, errors: consoleErrors.slice(0, 3) });
}

console.log('\n=== LATE-RENDER CRASH FINDINGS ===');
console.log(findings.length ? JSON.stringify(findings, null, 1) : 'none — all run-to-render cycles clean');
ws.close();
process.exit(findings.length ? 1 : 0);
