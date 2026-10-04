#!/usr/bin/env node
/**
 * IPC gate: the packaged desktop app's Tauri command surface, exercised for
 * real over CDP.
 *
 * Why this exists. Every other gate in this repo tests the Rust core as
 * functions (`cargo test`) or the UI as pixels (contrast, layout). Neither
 * touches the seam between them: the `#[tauri::command]` handlers, invoked
 * through the webview exactly as the shipped UI invokes them. That seam is
 * where the security-relevant behaviour lives — the log redaction that decides
 * what a user can export, the path allow-list behind "Open Logs", the URL
 * allow-list behind every external link — and a refactor can break it while
 * every unit test still passes.
 *
 * It also refuses to grade a stale binary. `audit-layout.mjs` and
 * `audit-contrast.mjs` short-circuit on `existsSync(EXE)`, so a Rust change
 * leaves them measuring yesterday's build until someone deletes it by hand.
 * This gate compares the EXE's mtime against the newest Rust source and
 * rebuilds when they disagree — run it before the others and they inherit a
 * fresh binary for free.
 *
 * It runs against the developer's REAL profile, because that is the only thing
 * worth testing, and then restores what it wrote. `APPDATA` cannot be used to
 * redirect the profile: Tauri's `app_data_dir()` on Windows resolves through
 * `SHGetKnownFolderPath(FOLDERID_RoamingAppData)`, which ignores the
 * environment variable — measured, not assumed. So the redaction checks below
 * append probe lines to the real `netpulse.log`. Every one carries a unique
 * marker and is stripped again in a `finally`, the exported diagnostic report
 * is deleted, and both are asserted afterwards, so even a crashed run cannot
 * quietly leave a fake credential sitting in somebody's log.
 *
 * What it deliberately does NOT do, so the coverage is not overstated:
 *   - It never calls the ALLOWING path of `reveal_path` or `open_external`.
 *     Those spawn Explorer and the default browser. On a developer machine
 *     that is a popup nobody asked for, so only the refusing paths are driven;
 *     the hand-off of an approved target to the OS is not covered here.
 *   - It does not cover the reparse-point case in `reveal_path` (a symlink or
 *     junction inside the data root pointing out of it). Creating one needs
 *     Developer Mode or elevation, so that case is `#[ignore]`d in the Rust
 *     suite and stays uncovered here.
 *   - It does not assert anything about window geometry or theme contrast;
 *     `audit-layout.mjs` and `audit-contrast.mjs` own those.
 *
 * Usage:
 *   node scripts/audit-ipc.mjs                   # rebuild if stale, then launch
 *   PROBE_PORT=9401 node scripts/audit-ipc.mjs   # reuse an app already listening
 *   AUDIT_CONTRAST_NO_BUILD=1 node scripts/audit-ipc.mjs   # fail rather than build
 *
 * Exit 0 = every check passed; 1 = a check failed; 2 = the run was untrustworthy.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appFreshness } from './lib/fresh-app.mjs';
import { attachToApp, freePort, sleep } from './lib/cdp-app.mjs';
import { describeFailure, runCommand } from './lib/run-command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.join(root, 'src-tauri', 'target', 'release', 'netpulse-desktop.exe');
const BACKEND = path.join(root, 'src-tauri', 'backend', 'netpulse-backend.js');
const REDACTED = '[redacted by diagnostics filter]';

/** Unique marker on every line this gate writes to the log, so cleanup is exact. */
const PROBE = 'audit-ipc-probe:';

const results = [];

// Per-check lines are prefixed and lower-cased so they cannot be mistaken for
// the `PASS  <step>` lines audit-ci.sh prints for each step — the same reason
// audit-layout.mjs prints `ok` rather than `PASS`.
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`[ipc] ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}
function die(msg) {
  console.error(`\n[ipc] ${msg}`);
  process.exit(2);
}
function run(label, args) {
  process.stdout.write(`[ipc] ${label}…\n`);
  const res = runCommand(root, args[0], args.slice(1));
  if (res.status !== 0) {
    process.stderr.write(`[ipc] ${label} failed (${describeFailure(res)})\n`);
    process.exit(res.status ?? 2);
  }
}

/* --------------------------------------------------- build inputs / freshness */

/**
 * The binary must postdate every Rust source. Shared with the other two app
 * gates so the rule cannot drift between them — see scripts/lib/fresh-app.mjs.
 */
function ensureFreshApp() {
  const verdict = appFreshness({ root, exe: EXE, noBuild: Boolean(process.env.AUDIT_CONTRAST_NO_BUILD) });
  if (verdict.fresh) {
    process.stdout.write(`[ipc] binary is fresh (newer than ${path.relative(root, verdict.newest.file)})\n`);
    return;
  }
  if (verdict.noBuild) {
    die(`binary is ${verdict.reason} and AUDIT_CONTRAST_NO_BUILD=1 — refusing to grade a stale build`);
  }
  run(`binary is ${verdict.reason}, rebuilding the packaged app`, ['npx', 'tauri', 'build', '--no-bundle']);
  const after = appFreshness({ root, exe: EXE, noBuild: true });
  if (!after.fresh) die(`the rebuild did not produce a binary newer than its sources (${after.reason})`);
}

function ensureBackend() {
  if (fs.existsSync(BACKEND)) return;
  if (process.env.AUDIT_CONTRAST_NO_BUILD) die(`${BACKEND} missing and AUDIT_CONTRAST_NO_BUILD=1`);
  run('staging the desktop backend', ['npm', 'run', 'build:desktop-backend']);
}

/* --------------------------------------------------------------- cdp plumbing */

/** Is something still listening on this loopback port? */
function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1000);
  });
}

/* ---------------------------------------------------------------------- main */

async function main() {
  ensureBackend();
  ensureFreshApp();

  const reuse = Boolean(process.env.PROBE_PORT);
  const port = Number(process.env.PROBE_PORT) || (await freePort(9401));

  // Note: the app cannot be redirected to a scratch profile — see the header.
  // Everything this gate writes to the real log is removed in `finally`.
  process.stdout.write(`[ipc] launching the app with CDP on 127.0.0.1:${port}\n`);

  // Launch and attach live in scripts/lib/cdp-app.mjs, shared with the other
  // two app gates. This gate needs the bridge: it invokes Tauri commands, so a
  // missing `window.__TAURI__` is fatal rather than merely premature.
  const session = await attachToApp({
    exe: EXE,
    cwd: root,
    port,
    reuse,
    tries: 60,
    onNoTarget: (child) => {
      child.kill();
      die('the app never exposed a CDP page (another instance holding the single-instance lock?)');
    },
  });
  const { ws, send, evaluate, pageErrors, consoleErrors } = session;
  if (!session.bridgeReady) {
    session.child?.kill();
    die('the Tauri IPC bridge never appeared in the webview (window.__TAURI__.core.invoke)');
  }
  const child = session.child;

  const invoke = (cmd, args) =>
    evaluate(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})
      .then(v => ({ ok: true, value: v }), e => ({ ok: false, err: String(e) }))`);

  let sidecarPort = null;
  let reportPath = null;
  let logFile = null;

  try {
    /* ------------------------------------------------- startup / bootstrap */
    const boot = await invoke('bootstrap', {});
    check('bootstrap hands the webview a /api/v1 base, a 64-hex token and desktop=true',
      boot.ok && boot.value.api_base.endsWith('/api/v1')
        && /^[0-9a-f]{64}$/.test(boot.value.token) && boot.value.desktop === true,
      `api_base=${boot.value?.api_base} token=${boot.value?.token?.length} hex chars`);

    /* --------------------------------------------------------- path resolver */
    const dp = await invoke('data_paths', {});
    check('data_paths resolves both directories to real, existing paths',
      dp.ok && fs.existsSync(dp.value.data_dir) && fs.existsSync(dp.value.log_dir),
      `data_dir=${dp.value?.data_dir}\n        log_dir=${dp.value?.log_dir}`);
    check('the rotating log lives INSIDE the data dir, not app_log_dir',
      dp.ok && path.resolve(dp.value.log_dir) === path.resolve(dp.value.data_dir, 'logs'));

    logFile = path.join(dp.value.log_dir, 'netpulse.log');
    check('the log file the resolver names is the one actually on disk', fs.existsSync(logFile), logFile);

    const rs = await invoke('runtime_status', {});
    sidecarPort = rs.value?.sidecar_port ?? null;
    check('runtime_status.log_dir matches data_paths.log_dir',
      rs.ok && rs.value.log_dir === dp.value.log_dir);
    // The log file was written to by this very run, so here it MUST be
    // readable: the honest answer is a number, and anything else means the
    // field stopped reporting or became `null`. In particular 0 must fail --
    // that is what an unreadable log used to report, and on the System Health
    // page it is the most reassuring thing the row can say. The `undefined`
    // case is named explicitly so "the field vanished" cannot pass silently.
    {
      const lfb = rs.value?.log_file_bytes;
      const realSize = fs.statSync(logFile).size;
      const why = lfb === undefined ? 'field missing from the snapshot entirely'
        : lfb === null ? `reported null (unavailable) although the file on disk is ${realSize} bytes`
        : lfb === 0 ? 'reported 0 bytes although the file on disk is not empty'
        : `reported ${lfb}; the file on disk is ${realSize} bytes`;
      check('runtime_status.log_file_bytes was measured from a file that exists',
        rs.ok && typeof lfb === 'number' && lfb > 0 && lfb <= realSize, why);
    }
    check('runtime_status reports the sidecar running and the window visible',
      rs.ok && rs.value.sidecar_running === true && rs.value.window_visible === true,
      `sidecar port=${sidecarPort} safe_mode=${rs.value?.safe_mode}`);

    /* ------------------------------- redaction, end to end through the file */
    const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const ORDINARY = `9999999999 9999 [info] ${PROBE} an ordinary line that must survive`;
    const SECRET = `9999999999 9999 [info] ${PROBE} authorization=Bearer ${JWT}`;
    const BARE_JWT = `9999999999 9999 [info] ${PROBE} upstream replied ${JWT}`;
    fs.appendFileSync(logFile, [ORDINARY, SECRET, BARE_JWT].join('\n') + '\n');

    const tail = await invoke('read_log_tail', { lines: 200 });
    const tailText = tail.value.join('\n');
    check('read_log_tail redacts a real secret-bearing line from the real log',
      tailText.includes(REDACTED), 'a header line carrying authorization=Bearer <jwt>');
    check('read_log_tail redacts a bare JWT with no keyword near it',
      tail.value.filter((l) => l === REDACTED).length >= 2,
      'the header line and the bare token must both be scrubbed');
    check('read_log_tail keeps the ordinary line byte-for-byte', tail.value.includes(ORDINARY));
    check('read_log_tail never emits the JWT', !tailText.includes(JWT));
    check('read_log_tail never emits the authorization fragment',
      !tail.value.some((l) => l.includes('authorization=')));

    /* ------------------------------- full lifecycle: the exported report file */
    const report = await invoke('save_diagnostic_report', {});
    reportPath = report.value ?? null;
    check('save_diagnostic_report returns a path to a file it actually wrote',
      report.ok && fs.existsSync(reportPath), reportPath);
    const reportText = fs.readFileSync(reportPath, 'utf8');
    const parsed = JSON.parse(reportText);
    check('the exported report contains no secret material anywhere',
      !reportText.includes(JWT) && !reportText.includes('authorization=Bearer') && !reportText.includes('Bearer eyJ'));
    check('the report embeds a redacted tail', JSON.stringify(parsed.bootLogTail).includes(REDACTED));
    check('the report keeps the ordinary line',
      JSON.stringify(parsed.bootLogTail).includes('ordinary line that must survive'));
    check('the report paths match the resolver',
      parsed.paths.dataDir === dp.value.data_dir && parsed.paths.logDir === dp.value.log_dir);
    check('the report never embeds the in-memory sidecar token', !reportText.includes(boot.value.token));

    /* ------------- reveal_path: REFUSING paths only (the allow path spawns) -- */
    const d = dp.value.data_dir;
    const revealRefusals = [
      ['traversal out of the root', path.join(d, '..', '..', 'Windows')],
      ['the trailing-space parent escape (Win32 strips it, so it reads as `..`)', `${d}\\.. `],
      ['a sibling sharing only a name prefix', `${d}-evil`],
      ['a directory outside the root', path.join(d, '..', '..')],
      ['a UNC path', '\\\\localhost\\c$\\Windows'],
      ['a relative path', 'logs'],
      ['a Windows system directory', 'C:\\Windows\\System32'],
    ];
    for (const [label, p] of revealRefusals) {
      const res = await invoke('reveal_path', { path: p });
      check(`reveal_path refuses ${label}`, res.ok === false, `-> ${res.err}`);
    }

    /* ------------- open_external: REFUSING paths only (the allow path launches) */
    const urlRefusals = [
      ['plaintext http', 'http://www.cloudflare.com'],
      ['file://', 'file:///C:/Windows/System32/calc.exe'],
      ['javascript:', 'javascript:alert(1)'],
      ['data:', 'data:text/html,<script>alert(1)</script>'],
      ['smb://', 'smb://server/share'],
      ['a URL carrying credentials', 'https://user:pass@www.cloudflare.com'],
      ['a bare executable that would resolve via PATH', 'calc.exe'],
      ['a Windows path', 'C:\\Windows\\System32\\cmd.exe'],
    ];
    for (const [label, u] of urlRefusals) {
      const res = await invoke('open_external', { url: u });
      check(`open_external refuses ${label}`, res.ok === false, `-> ${res.err}`);
    }

    /* ------------------------------------------------------ the UI still runs */
    const health = await evaluate(`(async () => {
      const m = await window.__TAURI__.core.invoke('bootstrap');
      const r = await fetch(m.api_base + '/meta/health', { headers: { authorization: 'Bearer ' + m.token } });
      return { ok: r.ok, status: r.status };
    })()`);
    check('the webview can still reach the sidecar over the loopback API',
      health.ok === true, `GET /meta/health -> ${health.status}`);

    for (const route of ['/', '/health', '/nodes', '/servers', '/vpn', '/settings', '/events']) {
      await evaluate(`history.pushState({}, '', ${JSON.stringify(route)}); window.dispatchEvent(new PopStateEvent('popstate')); true`);
      await sleep(400);
      const len = await evaluate(`(document.body.innerText || '').length`);
      check(`route ${route} renders content`, len > 80, `${len} chars`);
    }
    check('no uncaught exception was thrown in the webview across the route walk',
      pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'none');
    check('no console error was logged in the webview across the route walk',
      consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || 'none');
  } finally {
    /* ------------------------------------------------------------- cleanup */
    // Strip this gate's probe lines out of the real log, keeping every line the
    // app itself wrote in the meantime (it is still running and still logging).
    if (logFile) {
      try {
        const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
        const kept = lines.filter((l) => !l.includes(PROBE));
        fs.writeFileSync(logFile, kept.join('\n'));
        const left = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter((l) => l.includes(PROBE));
        check('every probe line this gate wrote was removed from the real log',
          left.length === 0, left.length ? `${left.length} left behind` : `${lines.length - kept.length} lines removed`);
      } catch (e) {
        check('every probe line this gate wrote was removed from the real log', false, String(e));
      }
    }
    if (reportPath) {
      try {
        fs.unlinkSync(reportPath);
      } catch { /* best effort */ }
      check('the exported diagnostic report was deleted', !fs.existsSync(reportPath), reportPath);
    }
    if (child) child.kill();
    if (sidecarPort) {
      // The gate may have spawned the app, or borrowed one that was already
      // listening on PROBE_PORT. Only the first gives it the right to expect
      // the sidecar to go away: a borrowed instance belongs to whoever started
      // it, and its sidecar staying bound is the correct outcome, not a leak.
      // Asserting release in reuse mode reported every correct run as a leak.
      //
      // Keyed on `borrowed` rather than on PROBE_PORT, because PROBE_PORT set
      // with nothing listening makes this gate spawn after all — and then it
      // genuinely owns the process and must still assert it was cleaned up.
      const borrowed = reuse && child === null;
      if (borrowed) {
        const alive = await portBusy(sidecarPort);
        check('the borrowed instance was left running rather than killed',
          alive, `port ${sidecarPort} ${alive ? 'still bound' : 'unexpectedly released'}`);
      } else {
        // The sidecar holds a loopback port. If it is still bound after the app
        // is gone, this gate left a process behind and must say so.
        let busy = true;
        for (let i = 0; i < 20 && busy; i++) {
          await sleep(500);
          busy = await portBusy(sidecarPort);
        }
        check('no sidecar process was left behind after the app exited', !busy,
          busy ? `port ${sidecarPort} is still bound` : `port ${sidecarPort} released`);
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[ipc] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('[ipc] FAILED:');
    for (const f of failed) console.log(`  - ${f.name}`);
  }
  console.log('[ipc] not covered here: the ALLOWING path of reveal_path / open_external (they spawn\n'
    + '       Explorer and the browser), the reparse-point case in reveal_path, and UI geometry\n'
    + '       or contrast — audit-layout.mjs and audit-contrast.mjs own those.');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
