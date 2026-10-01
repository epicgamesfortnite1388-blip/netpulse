#!/usr/bin/env node
/** THROWAWAY (deleted after use): drive the installed exe's real webview via
 *  CDP. Modes:
 *    nav <url>       navigate the page
 *    eval <exprfile> evaluate JS from a file, print JSON result
 */
import fs from 'node:fs';
import WebSocket from 'ws';

const CDP = 'http://127.0.0.1:9370';
const mode = process.argv[2];

const targets = await fetch(`${CDP}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'));
if (!page) { console.log('NO_PAGE_TARGET', targets.map((t) => t.url)); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
await new Promise((r) => ws.on('open', r));

if (mode === 'nav') {
  await send('Page.navigate', { url: process.argv[3] });
  await new Promise((r) => setTimeout(r, 1500));
  const info = await send('Runtime.evaluate', { expression: 'location.href + " :: " + document.title', returnByValue: true });
  console.log(info.result?.value);
} else if (mode === 'eval') {
  const expr = fs.readFileSync(process.argv[3], 'utf8');
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    console.log('EVAL_ERROR:', r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  } else {
    console.log(JSON.stringify(r.result?.value, null, 1));
  }
}
process.exit(0);
