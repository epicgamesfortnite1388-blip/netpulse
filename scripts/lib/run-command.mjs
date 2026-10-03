/**
 * One implementation of "run a build command", shared by every audit gate.
 *
 * Why this exists rather than a bare `spawnSync` at each call site. On Windows
 * `npm` and `npx` are `.cmd` shims, which Node refuses to execute directly:
 * `spawnSync('npx', …)` fails with ENOENT and `spawnSync('npx.cmd', …)` fails
 * with EINVAL, since the CVE-2024-27980 hardening. A gate whose rebuild path
 * does that never rebuilds.
 *
 * That is not hypothetical. All three app gates shipped with exactly this bug
 * and it went unnoticed for a long time, because the rebuild branch is only
 * reached when the binary is missing or stale, and in a working checkout the
 * binary is always there. Worse, the failure printed only `exit null` — the
 * spawn error was dropped, so even the one person who hit it saw no cause. The
 * first developer to edit Rust on a clean checkout would have hit it.
 *
 * How it is fixed follows `scripts/prepare-desktop.mjs`, which already solved
 * the same problem: run npm/npx's own CLI JavaScript with the current Node
 * executable. No shell is involved, so there is no quoting hazard and no
 * DEP0190 exposure — deliberately better than the `shell: true` workaround
 * that would otherwise be the one-character fix.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Rewrite an npm-managed command to `[node, <its cli js>, ...args]`.
 *
 * On POSIX `npm`/`npx` are ordinary executables and are returned untouched.
 * A toolchain installed outside the Node directory (nvm, Volta, a vendored
 * node) has no such sibling path, so it is left alone rather than rewritten to
 * something that does not exist.
 */
function resolveCli(cmd) {
  if (process.platform !== 'win32') return { cmd, prefixArgs: [] };
  if (cmd !== 'npm' && cmd !== 'npx') return { cmd, prefixArgs: [] };
  const cli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    cmd === 'npm' ? 'npm-cli.js' : 'npx-cli.js',
  );
  if (!fs.existsSync(cli)) return { cmd, prefixArgs: [] };
  return { cmd: process.execPath, prefixArgs: [cli] };
}

/**
 * Run `cmd` with `args` in `cwd`, streaming its output.
 *
 * @returns {{status: number|null, error: string|null}} `status` is null when the
 *   process could not be started or was killed; `error` then names the cause, so
 *   a failed spawn can never be reported as a bare "exit null" again.
 */
export function runCommand(cwd, cmd, args, opts = {}) {
  const resolved = resolveCli(cmd);
  const res = spawnSync(resolved.cmd, [...resolved.prefixArgs, ...args], {
    cwd,
    stdio: 'inherit',
    ...opts,
  });
  return {
    status: res.status,
    error: res.error ? res.error.code ?? res.error.message : null,
  };
}

/**
 * Describe a failed command for an error line: the spawn cause if there was
 * one, otherwise the exit status. A signal is reported as such, never as the
 * number `null` would stringify to.
 */
export function describeFailure({ status, error }) {
  if (error) return error;
  return status === null ? 'killed by a signal' : `exit ${status}`;
}
