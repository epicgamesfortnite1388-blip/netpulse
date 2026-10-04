/**
 * Launch (or reuse) the packaged desktop app and attach to its webview over
 * the Chrome DevTools Protocol. Shared by every gate that drives the real UI:
 * `audit-layout.mjs`, `audit-contrast.mjs` and `audit-ipc.mjs`.
 *
 * Why this module exists rather than a copy per gate. Each of the three grew
 * the same sequence — pick a free port, spawn the EXE with a remote-debugging
 * port, poll `/json` for the page, open a WebSocket, route CDP replies by id,
 * enable the Runtime domain, evaluate expressions, then close the socket and
 * kill the child. The cost was not the duplication itself but that a fix only
 * landed in one copy: `window.__TAURI__` is injected into the page AFTER the
 * CDP page target exists, so calling it the moment we attach is a race. That
 * wait was added to `audit-ipc.mjs` alone, because that was the gate which
 * happened to fail first — it was never a property of that gate, it was a
 * property of the attach sequence, and the other two were silently carrying the
 * same latent race. Sharing the code makes that class of fix apply everywhere.
 *
 * What is deliberately NOT shared, because each gate owns it:
 *   - its message prefix and the format of its own result lines
 *   - its exit codes and its own wording when the app never exposes a page
 *   - its build/freshness checks, which run before attaching and differ per gate
 * Gates pass `beforeSpawn` and `onNoTarget` hooks for those, so the control
 * flow here stays free of gate-specific policy.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

/** Wait `ms` milliseconds. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * First free loopback port at or after `start`, walking forward on collision.
 * The port is only a hint — it is re-probed by the caller — but starting the
 * scan where the OS is least busy avoids the usual collisions with a leftover
 * instance.
 */
export function freePort(start) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(freePort(start + 1)));
    s.listen(start, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * The webview's page target, or null. `tries` bounds the wait: the app is
 * launched asynchronously, so the endpoint answers before the page exists.
 */
export async function findCdpTarget(port, tries = 40) {
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

/**
 * Wait until Tauri has injected its IPC bridge into the page.
 *
 * The CDP page target appears BEFORE the bridge exists, so a caller that
 * evaluates `window.__TAURI__` the moment it attaches is racing the webview.
 * The failure is a `TypeError: ... reading 'core'` from the page, which
 * `evaluate` then rethrows and the gate reports as its own crash — an
 * intermittent failure that looks like the gate is broken rather than early.
 *
 * Bounded: returns false rather than hanging when the bridge never appears.
 * The caller decides whether that is fatal, because only the gates that
 * actually invoke a command need it.
 */
export async function waitForTauriBridge(evaluate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const kind = await evaluate('typeof window.__TAURI__?.core?.invoke');
    if (kind === 'function') return true;
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

/**
 * Launch or reuse the app, attach, and enable the Runtime domain.
 *
 * @param {object} opts
 * @param {string} opts.exe      packaged binary
 * @param {string} opts.cwd      working directory for the child
 * @param {number} opts.port     loopback port the child should expose
 * @param {boolean} [opts.reuse] attach to an already-running instance instead
 *   of spawning one
 * @param {number} [opts.tries]  how long to wait for the page after spawning
 * @param {Function} [opts.beforeSpawn] gate hook, run only when a spawn is
 *   actually needed — its build and freshness checks and its own message
 * @param {Function} [opts.onNoTarget] gate hook called with the child when the
 *   app never exposes a page; it is expected to report and exit
 * @param {boolean} [opts.logDomain] also enable the Log domain
 * @returns {Promise<object>} session handle
 */
export async function attachToApp({ exe, cwd, port, reuse = false, tries = 40, beforeSpawn, onNoTarget, logDomain = false }) {
  let child = null;
  let target = reuse ? await findCdpTarget(port, 2) : null;

  if (!target) {
    if (beforeSpawn) await beforeSpawn();
    child = spawn(exe, [], {
      cwd,
      detached: false,
      stdio: 'ignore',
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    });
    target = await findCdpTarget(port, tries);
    if (!target) {
      // Every gate's `onNoTarget` reports in its own words and exits. If a
      // future caller passes none, fail loudly rather than dereferencing null.
      if (!onNoTarget) throw new Error('the app never exposed a CDP page');
      onNoTarget(child);
      throw new Error('onNoTarget did not terminate the gate');
    }
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  let mid = 0;
  const pending = new Map();
  /** Uncaught exceptions seen in the page, first line of each. */
  const pageErrors = [];
  /** Console errors and warnings seen in the page. */
  const consoleErrors = [];

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params?.exceptionDetails?.exception?.description?.split('\n')[0] ?? 'exception');
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params?.type === 'error' || m.params?.type === 'warning')) {
      const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200);
      consoleErrors.push(`${m.params.type}: ${text}`);
    }
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
  if (logDomain) await send('Log.enable');

  // Applies to every gate: measuring a page whose bundle has not run risks
  // recording a loading state as the real layout.
  const bridgeReady = await waitForTauriBridge(evaluate);

  return {
    ws,
    send,
    evaluate,
    child,
    pageErrors,
    consoleErrors,
    bridgeReady,
    /** Detach and stop the app. Safe when reusing someone else's instance. */
    close() {
      ws.close();
      if (child) child.kill();
    },
  };
}
