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
 * How it is fixed follows `scripts/prepare-desktop.mjs`: run npm/npx's own CLI
 * JavaScript with the current Node executable. No shell is involved, so there
 * is no quoting hazard and no DEP0190 exposure — deliberately better than the
 * `shell: true` workaround that would otherwise be the one-character fix.
 *
 * Finding that JavaScript is the hard part, because "next to node" is only true
 * of a stock install. On nvm, Volta or nvm-windows, `node` may be reached
 * through a symlink or a wrapper, and `process.execPath` is then not the real
 * installation — so the sibling lookup finds nothing and a helper that gives up
 * here reintroduces the exact ENOENT it exists to remove. The strategies below
 * are tried in order of how much they can be trusted, and each reports itself
 * via `how` so a failure says which layout it lost to.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** npm ships one CLI script per tool, all in the same bin directory. */
const CLI_FILES = { npm: 'npm-cli.js', npx: 'npx-cli.js' };

/**
 * Batch's "directory of this script" token. Two spellings exist in the wild:
 * `%~dp0` (current npm, inside `SET "VAR=%~dp0\…"`) and `%dp0%` (older shims).
 */
const DP0_TOKEN_RE = /%~?dp0%?/gi;

/**
 * A CLI path in a batch file, anchored at the dp0 token so the variable name
 * that precedes it is never captured.
 */
const DP0_CLI_RE = /(%~?dp0%?\\[^\r\n"']*npm-cli\.js)/gi;

/** First path that exists as a regular file, or null. */
function firstExistingFile(candidates) {
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* a candidate that is not there is simply not the answer */
    }
  }
  return null;
}

/** npm's CLI directory below an install root, in both common layouts. */
function cliCandidatesUnder(root, tool) {
  return [
    path.join(root, 'node_modules', 'npm', 'bin', CLI_FILES[tool]),
    // nix/posix installs keep the library one level up from bin/.
    path.join(root, 'lib', 'node_modules', 'npm', 'bin', CLI_FILES[tool]),
  ];
}

/**
 * Strategy 1 — beside the running node, following it through symlinks.
 *
 * Windows-only (resolveCli returns early elsewhere), and that matters: on
 * Windows `process.execPath` is the path the process was launched with, so on
 * nvm-windows — where `node.exe` is a symlink into the active version
 * directory — it names the shim, not the installation. `realpathSync` is what
 * turns it back into the directory that actually contains `node_modules/npm`.
 * Both are searched, because a toolchain may legitimately have the library
 * beside the shim and not beside the target.
 */
function fromNodeSibling(tool) {
  const dirs = [];
  for (const nodePath of [process.execPath, safeRealpath(process.execPath)]) {
    if (!nodePath) continue;
    const dir = path.dirname(nodePath);
    if (!dirs.includes(dir)) dirs.push(dir);
    const up = path.dirname(dir);
    if (!dirs.includes(up)) dirs.push(up);
  }
  const hit = firstExistingFile(dirs.flatMap((d) => cliCandidatesUnder(d, tool)));
  return hit && { cmd: process.execPath, prefixArgs: [hit], how: 'node-sibling' };
}

/** realpathSync, or null — an unreadable or missing path is not a hard error. */
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Strategy 2 — npm's own environment variable.
 *
 * When the gates are reached through `npm run …`, npm exports `npm_execpath` as
 * the absolute path of npm-cli.js. That is authoritative and needs no guessing,
 * and because npx-cli.js is a sibling it serves both tools.
 */
function fromNpmExecPath(tool) {
  const execPath = process.env.npm_execpath;
  if (!execPath) return null;
  const binDir = path.dirname(execPath);
  const hit = firstExistingFile([path.join(binDir, CLI_FILES[tool])]);
  return hit && { cmd: process.execPath, prefixArgs: [hit], how: 'npm_execpath' };
}

/**
 * Strategy 3 — NODE_PATH, Node's documented extra module search path.
 * Only populated when a developer or CI has set it, so it is a bonus source.
 */
function fromNodePath(tool) {
  const raw = process.env.NODE_PATH;
  if (!raw) return null;
  const entries = raw.split(path.delimiter).filter(Boolean);
  const hit = firstExistingFile(entries.flatMap((e) => cliCandidatesUnder(e, tool)));
  return hit && { cmd: process.execPath, prefixArgs: [hit], how: 'NODE_PATH' };
}

/**
 * Strategy 4 — read the PATH shim.
 *
 * `npm.cmd` cannot be executed by Node, but it is a batch file that names the
 * JavaScript it wraps relative to batch's `%~dp0` — "the directory of this
 * script". Replacing that token with the directory the shim was found in yields
 * a concrete path, which is then verified to exist before use. This covers a
 * toolchain whose node is a shim and whose npm lives somewhere neither
 * `process.execPath` nor the environment names.
 *
 * Honest limits: a shim that does not name a literal path — Volta's executables
 * are wrappers rather than batch files — yields nothing here and resolution
 * falls through. Only a match beginning at the dp0 token is accepted, so a
 * line that merely mentions the file contributes nothing.
 */
function fromPathShim(tool) {
  if (process.platform !== 'win32') return null;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const binDirs = [];
  for (const dir of dirs) {
    for (const ext of [...exts, '']) {
      for (const shimTool of ['npm', 'npx']) {
        let text;
        try {
          text = fs.readFileSync(path.join(dir, `${shimTool}${ext}`), 'utf8');
        } catch {
          continue;
        }
        // Anchor the match ON the dp0 token, not merely up to the file name.
        // Current npm writes:  SET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js"
        // older npm writes:  "%dp0%\node_modules\npm\bin\npm-cli.js"
        // Matching only `…npm-cli.js` captured the `NPM_CLI_JS=` variable name
        // too, so the substitution yielded `NPM_CLI_JS=C:\…` — not a path —
        // and the stock shim was the one format this could NOT parse. Requiring
        // the match to begin at the token also drops the lines that merely
        // mention the file (`%%F\…`, `$NPM_PREFIX\…`), which were the source
        // of the garbage candidates.
        for (const m of text.matchAll(DP0_CLI_RE)) {
          const resolved = path.resolve(dir, m[1].replace(DP0_TOKEN_RE, dir));
          if (firstExistingFile([resolved])) binDirs.push(path.dirname(resolved));
        }
      }
    }
  }
  const hit = firstExistingFile(binDirs.map((d) => path.join(d, CLI_FILES[tool])));
  return hit && { cmd: process.execPath, prefixArgs: [hit], how: 'PATH-shim' };
}

/**
 * How `cmd` should be executed. Returns the bare command unchanged unless we
 * positively identified the CLI JavaScript, in which case it is run with the
 * current node — never through a shell.
 *
 * `how` names the strategy that answered, and is `undefined` when none did.
 */
export function resolveCli(cmd) {
  if (process.platform !== 'win32') return { cmd, prefixArgs: [], how: 'posix' };
  if (cmd !== 'npm' && cmd !== 'npx') return { cmd, prefixArgs: [], how: 'not-npm' };
  for (const strategy of [fromNpmExecPath, fromNodeSibling, fromNodePath, fromPathShim]) {
    const found = strategy(cmd);
    if (found) return found;
  }
  // Last resort: hand the bare name to the OS. This is the ENOENT case, but it
  // is now reached only after four real attempts, and a spawn failure will be
  // reported by name instead of vanishing into `exit null`.
  return { cmd, prefixArgs: [], how: undefined };
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
