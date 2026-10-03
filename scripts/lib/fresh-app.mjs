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
