/**
 * One implementation of "may this gate grade the packaged binary?", shared by
 * every audit gate that launches the app.
 *
 * Why this is a shared module rather than a copy per script. `audit-layout.mjs`
 * and `audit-contrast.mjs` used to short-circuit on `existsSync(EXE)`: present
 * meant "good enough". Neither asked WHEN the binary was built, so any Rust
 * change left both measuring the previous build — and a green gate that graded
 * the wrong binary is worse than no gate, because it is believed. That is not
 * hypothetical: this repo shipped a layout pass of 132/132 measured against an
 * EXE 23 hours older than the source it claimed to test, twice.
 *
 * `audit-ipc.mjs` had the fix privately. This puts it somewhere all three reach,
 * so the rule cannot drift apart between gates. Nothing here builds anything or
 * prints anything: each gate keeps its own messaging, exit code and build
 * command, so the only change in their output is the staleness report itself.
 *
 * The build command is the packaged one on purpose. `cargo build` alone yields a
 * dev-URL binary with no bundled assets, which is not what the gates need.
 *
 * The inputs include the WEB and API sources, not just the Rust ones.
 * `tauri.conf.json` sets `beforeBuildCommand: npm run build -w @netpulse/web`
 * and `frontendDist: ../apps/web/dist`, so the packaged binary embeds the built
 * React app; `prepare-desktop.mjs` bundles `apps/api/src` into
 * `src-tauri/backend/netpulse-backend.js`, which the Tauri bundle ships
 * verbatim. Walking only `src-tauri/` meant neither half of that could make the
 * binary stale, so a frontend or backend change left every app gate grading a
 * build made before it — the same "green gate that graded the wrong binary"
 * this module exists to prevent, on the parts of the app the Rust walk could
 * not see. That is not hypothetical: an API fix was committed, gated by a test
 * that passed, and the shipped app still ran the old code.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Build inputs whose mtime decides whether the packaged binary is current. */
function buildInputs(root) {
  return [
    path.join(root, 'src-tauri', 'Cargo.toml'),
    path.join(root, 'src-tauri', 'tauri.conf.json'),
    path.join(root, 'src-tauri', 'build.rs'),
  ];
}

/** The most recently touched build input, or `{ mtimeMs: 0 }` if there are none. */
export function newestBuildInput(root) {
  let newest = { mtimeMs: 0, file: null };
  const consider = (p) => {
    try {
      const { mtimeMs } = fs.statSync(p);
      if (mtimeMs > newest.mtimeMs) newest = { mtimeMs, file: p };
    } catch {
      /* a build input that does not exist yet cannot make anything stale */
    }
  };
  for (const p of buildInputs(root)) consider(p);
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else consider(full);
    }
  };
  walk(path.join(root, 'src-tauri', 'src'));
  // The two bundled halves of the app. Same rule, other side of the build:
  // `beforeBuildCommand` runs the web build, and `prepare-desktop.mjs` runs the
  // sidecar bundle, so a change in either marks the packaged app stale.
  walk(path.join(root, 'apps', 'web', 'src'));
  walk(path.join(root, 'apps', 'api', 'src'));
  return newest;
}

/**
 * Decide whether `exe` may be graded. Builds nothing and prints nothing.
 *
 * `fresh: false` comes with a `reason` naming what is wrong — `missing` or
 * `stale`, with the specific source file the binary predates — so a caller can
 * report it rather than silently rebuilding.
 *
 * @param {object} opts
 * @param {string} opts.root   repo root
 * @param {string} opts.exe    path to the packaged binary
 * @param {boolean} [opts.noBuild] true when building is suppressed; callers
 *   should refuse rather than build, so a suppressed machine cannot end up
 *   grading a stale binary by accident.
 */
export function appFreshness({ root, exe, noBuild = false }) {
  const newest = newestBuildInput(root);
  const exeMtime = fs.existsSync(exe) ? fs.statSync(exe).mtimeMs : 0;
  if (exeMtime && exeMtime >= newest.mtimeMs) {
    return { fresh: true, newest };
  }
  return {
    fresh: false,
    newest,
    noBuild,
    reason: exeMtime
      ? `stale: ${path.basename(exe)} predates ${path.relative(root, newest.file)}`
      : `missing: ${exe} does not exist`,
  };
}

/**
 * Rebuild the packaged app so a gate grades what would actually be installed.
 *
 * Both halves, in order, because `npx tauri build` only runs the web
 * `beforeBuildCommand`: `prepare-desktop.mjs` stages `src-tauri/backend/`
 * (the sidecar bundle + its runtime), and the Tauri build then copies that
 * directory next to the exe as a resource. Rebuilding only the Tauri side is
 * what let a committed API fix sit in the source tree while the shipped
 * `netpulse-backend.js` kept running the old code — the exe looked fresh,
 * because nothing had touched a Rust file.
 *
 * One implementation, so the three app gates cannot drift on which halves a
 * rebuild covers. `run(label, cmd, args)` is the caller's existing runner, so
 * each gate keeps its own output prefix and failure wording.
 */
export function rebuildPackagedApp({ run }) {
  run('staging the sidecar bundle (apps/api/src -> src-tauri/backend)', ['node', 'scripts/prepare-desktop.mjs']);
  run('building the packaged app (web bundle + exe)', ['npx', 'tauri', 'build', '--no-bundle']);
}
