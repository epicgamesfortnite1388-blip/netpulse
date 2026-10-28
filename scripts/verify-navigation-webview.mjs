#!/usr/bin/env node
/**
 * One command that builds the desktop app and runs the real-webview navigation
 * backstop test (`src-tauri/tests/navigation_webview.rs`).
 *
 * Run: npm run e2e:navigation      (or: node scripts/verify-navigation-webview.mjs)
 *
 * **Why a script instead of a note in the test header.** Three things make that
 * test annoying to run by hand, and each of them fails in a way that looks like
 * the backstop is broken:
 *
 *   - the native driver must match the installed WebView2 RUNTIME, not the
 *     installed Edge browser — a mismatch fails every session with "only
 *     supports Microsoft Edge version N" (so this resolves the runtime's
 *     version and, on Windows, downloads that exact msedgedriver when one is
 *     not already on PATH);
 *   - a DEBUG binary resolves its window to `build.devUrl`, not to the compiled
 *     `frontendDist`, so something has to serve `http://localhost:5173` or the
 *     window shows the engine's error page;
 *   - vite's default `localhost` can bind the IPv6 loopback only. Measured: the
 *     webview then sat on `chrome-error://chromewebdata/` while WebDriver still
 *     reported the app URL, so the test failed for a reason unrelated to
 *     navigation. This binds IPv4 loopback explicitly and waits for HTTP 200.
 *
 * It starts that server itself — and stops only a server it started (one already
 * answering is reused and left alone) — then runs `cargo build` followed by the
 * `#[ignore]`d test, and exits non-zero on the first failure.
 *
 * Nothing here is needed by CI: `.github/workflows/ci.yml` does the same steps
 * in its `webview-navigation` job, where msedgedriver comes from
 * `msedgedriver-tool` and the log is the Actions log.
 *
 * Flags:
 *   --no-build        skip `cargo build` (reuse the binary already there)
 *   --keep-server     leave the dev server running afterwards
 *   --driver <path>   use this native driver instead of resolving one
 *   --app <path>      drive this binary instead of target/debug/netpulse-desktop
 *   --port <n>        dev origin port (default 5173, matching tauri.conf.json)
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(opt('--port', '5173'));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MANIFEST = path.join('src-tauri', 'Cargo.toml');
const BIN_NAME = process.platform === 'win32' ? 'netpulse-desktop.exe' : 'netpulse-desktop';
const APP = path.resolve(opt('--app', path.join(root, 'src-tauri', 'target', 'debug', BIN_NAME)));

let failures = 0;
const step = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};
const note = (msg) => console.log(`      ${msg}`);

/* ------------------------------- tool lookup ------------------------------ */

function onPath(candidates) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of candidates) {
    for (const dir of dirs) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function resolveTool({ envVar, candidates }) {
  const pointed = envVar ? process.env[envVar] : undefined;
  if (pointed && fs.existsSync(pointed)) return pointed;
  return onPath(candidates);
}

/** The installed WebView2 runtime's version, which is what the driver must match. */
function webview2Version() {
  const base = 'C:/Program Files (x86)/Microsoft/EdgeWebView/Application';
  try {
    const versions = fs
      .readdirSync(base)
      .filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => {
        const left = a.split('.').map(Number);
        const right = b.split('.').map(Number);
        for (let i = 0; i < 4; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
        return 0;
      });
    return versions.at(-1) ?? null;
  } catch {
    return null;
  }
}

/** Where a downloaded driver is kept: inside node_modules (already ignored), else temp. */
function driverCacheDir(version) {
  const base = fs.existsSync(path.join(root, 'node_modules'))
    ? path.join(root, 'node_modules', '.cache', 'netpulse')
    : path.join(os.tmpdir(), 'netpulse-cache');
  return path.join(base, 'msedgedriver', version);
}

async function downloadMsedgedriver(version) {
  const dir = driverCacheDir(version);
  const exe = path.join(dir, 'msedgedriver.exe');
  if (fs.existsSync(exe)) return exe;

  const url = `https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`;
  note(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`driver download failed: HTTP ${res.status} from ${url}`);
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, 'edgedriver.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

  // bsdtar (Windows 10+, macOS, Linux) reads zip; PowerShell is the fallback.
  let unpacked =
    spawnSync('tar', ['-xf', zip, '-C', dir], { stdio: 'ignore' }).status === 0;
  if (!unpacked) {
    unpacked =
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`],
        { stdio: 'ignore' },
      ).status === 0;
  }
  if (!unpacked || !fs.existsSync(exe)) throw new Error(`could not unpack ${zip}`);
  fs.rmSync(zip, { force: true });
  return exe;
}

async function resolveNativeDriver() {
  const given = opt('--driver', null);
  if (given) return path.resolve(given);

  if (process.platform === 'darwin') {
    throw new Error(
      'tauri-driver cannot drive a macOS webview: this test runs on Windows (WebView2) or Linux (WebKitGTK)',
    );
  }
  if (process.platform !== 'win32') {
    const webkit = resolveTool({ envVar: 'WEBKIT_WEBDRIVER', candidates: ['WebKitWebDriver'] });
    if (!webkit) throw new Error('install WebKitWebDriver (`apt install webkit2gtk-driver`) or set WEBKIT_WEBDRIVER');
    return webkit;
  }

  const installed = resolveTool({ envVar: 'MSEDGEDRIVER', candidates: ['msedgedriver.exe', 'msedgedriver'] });
  if (installed) return installed;

  const version = webview2Version();
  if (!version) {
    throw new Error(
      'no msedgedriver on PATH and no WebView2 runtime version to match; install the WebView2 runtime or set MSEDGEDRIVER',
    );
  }
  return downloadMsedgedriver(version);
}

/* ------------------------------- dev server ------------------------------- */

/** The dev origin's HTTP status, or null when nothing answers there. */
async function originStatus() {
  try {
    const res = await fetch(`${ORIGIN}/`, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
    return res.status;
  } catch {
    return null;
  }
}

function startDevServer() {
  // Run vite's entry directly: one child, no npm wrapper, and therefore a PID
  // that actually owns the listener when it comes time to stop it.
  const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteArgs = ['--host', '127.0.0.1', '--port', String(PORT), '--strictPort'];
  const useViteDirectly = fs.existsSync(viteBin);

  const child = useViteDirectly
    ? spawn(process.execPath, [viteBin, ...viteArgs], {
        cwd: path.join(root, 'apps', 'web'),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    : spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev', '-w', '@netpulse/web', '--', ...viteArgs], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32',
      });

  let log = '';
  const collect = (buf) => {
    log += buf.toString();
    if (log.length > 20_000) log = log.slice(-20_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return { child, output: () => log };
}

function stopDevServer(server) {
  const child = server?.child;
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

/* --------------------------------- runner -------------------------------- */

function cargo(args, env) {
  return spawnSync('cargo', args, { cwd: root, stdio: 'inherit', env: env ?? process.env });
}

/// The dev server this run started, so a Ctrl-C cannot leave a listener behind.
let activeServer = null;

async function main() {
  console.log('Navigation backstop (real webview) — build, serve, drive\n');

  // 1. Toolchain.
  step(cargo(['--version']).status === 0, 'cargo on PATH');
  const tauriDriver = resolveTool({ envVar: 'TAURI_DRIVER', candidates: ['tauri-driver.exe', 'tauri-driver'] });
  step(
    Boolean(tauriDriver),
    'tauri-driver on PATH',
    tauriDriver ? tauriDriver : 'install it with `cargo install tauri-driver --locked`',
  );

  let nativeDriver = null;
  try {
    nativeDriver = await resolveNativeDriver();
    step(true, 'native webdriver resolved', nativeDriver);
  } catch (err) {
    step(false, 'native webdriver resolved', err.message);
  }
  if (failures) return 1;

  if (!has('--no-build')) {
    const built = cargo(['build', '--manifest-path', MANIFEST]);
    if (!step(built.status === 0, 'cargo build', built.status === 0 ? '' : `exit ${built.status}`)) return 1;
  }
  if (!step(fs.existsSync(APP), 'app binary', APP)) {
    note('build it first, or pass --no-build only when it really is already built');
    return 1;
  }

  // 2. The document the window will load.
  let server = null;
  let startedHere = false;
  const existing = await originStatus();
  if (existing === 200) {
    // Someone else's dev server: reuse it and leave it up. Only a server this
    // script started is ever stopped.
    step(true, 'dev origin already served', `${ORIGIN} (left running)`);
  } else {
    if (existing !== null) {
      note(`something already answers ${ORIGIN} with HTTP ${existing}; trying our own server anyway`);
    }
    server = startDevServer();
    activeServer = server;
    startedHere = true;
    let ready = false;
    for (let i = 0; i < 45; i += 1) {
      if ((await originStatus()) === 200) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!step(ready, `dev origin served at ${ORIGIN}`, ready ? '' : 'it never answered HTTP 200')) {
      note(server.output().trim() || '(the dev server wrote nothing)');
      note(`a server that is already on port ${PORT} but does not serve the app (HTTP ${existing ?? 'no answer'}) will do this; stop it and retry`);
      return 1;
    }
  }

  try {
    // 3. The test itself. `--ignored` is the only place it runs locally; it
    //    fails rather than skips when a driver or the binary is missing.
    // Set on `process.env` rather than passed as a copied env object: measured
    // on this machine, handing `spawnSync` a spread copy made rustup's `cargo`
    // shim fail with "could not choose a version of cargo to run ... no default
    // is configured" even though the copy carried RUSTUP_HOME and CARGO_HOME,
    // while the same command with the inherited env runs. The child sees these
    // two either way; the difference is whose environment block is used.
    process.env.MSEDGEDRIVER = nativeDriver;
    process.env.NAV_WEBVIEW_APP = APP;
    const tested = cargo(['test', '--manifest-path', MANIFEST, '--test', 'navigation_webview', '--', '--ignored', '--nocapture']);
    step(tested.status === 0, 'navigation backstop (real webview)', tested.status === 0 ? '' : `exit ${tested.status}`);
  } finally {
    if (startedHere && !has('--keep-server')) {
      stopDevServer(server);
      activeServer = null;
      console.log('      dev server stopped (it was started by this script)');
    } else if (startedHere) {
      console.log(`      dev server left running at ${ORIGIN} (--keep-server)`);
    }
  }

  console.log(
    `\n${failures === 0 ? 'PASS' : 'FAIL'}  ${failures === 0 ? 'the backstop held in a real webview' : `${failures} step(s) failed`}`,
  );
  return failures === 0 ? 0 : 1;
}

process.on('SIGINT', () => {
  stopDevServer(activeServer);
  process.exit(130);
});

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`FAIL  ${err.message}`);
    process.exit(1);
  });
