/**
 * The spawn → readiness → cleanup lifecycle of a local proxy core — ONE owner.
 *
 * Three call sites used to carry their own copy of this (startCore for node
 * tests and tunnel hops, startTunGateway for system-wide mode, and the legacy
 * single-engine probe), and the copies disagreed. The rules they must all obey:
 *
 *   1. Readiness means the inbound ACCEPTS TCP. That proves the PROCESS is up,
 *      never that traffic traverses the proxy — callers verify the path with a
 *      real request through the port and must not report a started core as a
 *      working one.
 *   2. Cleanup is idempotent and unconditional: the child is killed and the
 *      temp config dir deleted however the start ended — success, refusal,
 *      timeout, spawn error — and safe to call twice or after a failed start.
 *      Core configs embed node credentials, so a leaked dir is a secrets
 *      problem, not just litter. The dir is the owner's from the moment it is
 *      handed over: it is removed even when no process was ever spawned.
 *   3. Output is BOUNDED. `output` keeps only the tail; a core that logs in a
 *      loop cannot grow a status payload through it.
 *   4. A failed start carries the cause, the exit code and the output, so the
 *      caller classifies (missing binary vs refused config vs a taken port)
 *      without re-parsing anything.
 *   5. The port is checked FREE before the spawn. The caller either reserved
 *      it a moment earlier or owns it outright (an engine with a fixed
 *      loopback port), so something already answering means the process would
 *      bind-fail or, worse, the readiness poll would see the squatter's answer
 *      and report a ready core that is not ours. That clash is reported as its
 *      own failure, so the caller can retry on a fresh port (cores) or say
 *      plainly that the port is taken (fixed-port engines) instead of blaming
 *      the node.
 *
 * What the owner deliberately does NOT own: config generation (each core's shape
 * differs), port reservation and the timeout policy (callers pass them in), and
 * the post-start crash watcher (a death means different things to a probe, a
 * tunnel hop and a TUN gateway).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

import { redactSecrets } from '../util/redact';

import type { ChildProcess } from 'node:child_process';

/** How much of a core's output we keep for status and failure reasons. */
const OUTPUT_LIMIT = 2_000;

/** Readiness polling cadence, and how long one probe waits for a connect. */
const POLL_INTERVAL_MS = 300;
const PROBE_CONNECT_TIMEOUT_MS = 400;

/**
 * Why a start failed:
 *   - `port_clash`   — something else took the port between reserve and spawn
 *   - `spawn_error`  — the binary could not be executed at all (ENOENT, EACCES)
 *   - `exited`       — the process died during startup, carrying its own output
 *   - `timeout`      — it stayed alive but never answered on its inbound
 */
export type CoreProcessFailure = 'port_clash' | 'spawn_error' | 'exited' | 'timeout';

export interface CoreProcessSpec {
  bin: string;
  args: string[];
  /** The port the config file was generated for; readiness polls it. */
  readyPort: number;
  readyTimeoutMs: number;
  /**
   * Temp dir the caller wrote the generated config into. Deleted by
   * `cleanup()` — the owner does not create it, because each caller decides
   * where its config lives (and one keeps it outside temp on purpose).
   */
  tempDir?: string;
  /**
   * How the failure text names this process ("core", "TUN gateway", …). Kept as
   * the caller's word so an operator reading a log still sees which process it
   * was.
   */
  label: string;
  /**
   * Override the timeout sentence when the caller can say what to check. Gets
   * the output so a core that explained itself before hanging still wins.
   */
  timeoutMessage?: (ms: number, output: string) => string;
  /** Test seam; defaults to `child_process.spawn`. */
  spawnFn?: typeof spawn;
}

export interface CoreProcess {
  child: ChildProcess;
  readyPort: number;
  /**
   * The core's own words so far, BOUNDED to the tail (secrets are redacted
   * wherever this text is turned into a user-facing reason, not here).
   */
  readonly output: string;
  /** Kill the child and delete the temp dir. Idempotent. */
  cleanup(): void;
}

export type CoreProcessResult =
  | { ok: true; process: CoreProcess }
  | {
      ok: false;
      failure: CoreProcessFailure;
      error: string;
      output: string;
      /** The real exit code when the process died; null otherwise. */
      exitCode: number | null;
    };

/**
 * The line from a core's output that explains a startup failure, in the core's
 * own words where it offers any. Cores are inconsistent about it, so look for
 * the known phrasings before falling back to the caller's message.
 */
export function startupReason(output: string, fallback: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const matched = lines.find((l) => /FATAL|failed to start|unknown cipher|ERROR/i.test(l));
  return redactSecrets(matched ?? fallback);
}

/** Reserve an ephemeral loopback port. */
export function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

/**
 * Delete a generated config dir. Best effort: a locked dir must not break a
 * caller's teardown, and the boot sweep collects what it cannot remove.
 */
function removeTempDir(tempDir: string | undefined): void {
  if (!tempDir) return;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** True when nothing is listening on the loopback port right now. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/**
 * Spawn a core and resolve when its inbound answers, or with a classified
 * failure. `process.cleanup()` is always safe to call.
 */
export async function spawnCoreProcess(spec: CoreProcessSpec): Promise<CoreProcessResult> {
  const { bin, args, readyPort, readyTimeoutMs, tempDir, label } = spec;

  // Rule 5: a squatter on the reserved port is not this core's fault, and
  // mistaking its answer for our readiness would report a working core that
  // does not exist.
  if (!(await portIsFree(readyPort))) {
    // The temp dir is the owner's from the moment it is handed over, on EVERY
    // outcome — including a refusal that never reached a spawn. It holds the
    // node's credentials.
    removeTempDir(tempDir);
    return {
      ok: false,
      failure: 'port_clash',
      error: `port ${readyPort} is already in use — the ${label} was not spawned`,
      output: '',
      exitCode: null,
    };
  }

  const spawnFn = spec.spawnFn ?? spawn;
  const child = spawnFn(bin, args, {
    windowsHide: true,
    shell: false,
    // Both streams: xray logs config failures to stdout, so piping only stderr
    // reduced "unknown cipher method: aes-256-cfb" to a bare exit code.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  // The tail is kept RAW, exactly as the core emitted it (bounded), so a caller
  // that inspects `output` sees what the process actually said. Redaction
  // happens where text leaves as an explanation — `startupReason` below, and a
  // caller's own error path — never on the shared buffer: redactSecrets also
  // caps its result at 512 chars, which would silently shrink what every caller
  // believes it is holding.
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-OUTPUT_LIMIT);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      child.kill();
    } catch {
      // already dead
    }
    removeTempDir(tempDir);
  };

  return await new Promise<CoreProcessResult>((resolve) => {
    let settled = false;
    let exitCode: number | null = null;

    const finishOk = () => {
      if (settled) return;
      settled = true;
      stopWatching();
      resolve({
        ok: true,
        process: {
          child,
          readyPort,
          get output() {
            return output;
          },
          cleanup,
        },
      });
    };
    const finishFail = (failure: CoreProcessFailure, error: string) => {
      if (settled) return;
      settled = true;
      stopWatching();
      // A failed start never leaves a process or a credential-bearing config
      // behind (rule 2).
      cleanup();
      resolve({ ok: false, failure, error, output, exitCode });
    };

    const timer = setTimeout(() => {
      const fallback = `${label} did not become ready in ${readyTimeoutMs}ms`;
      finishFail('timeout', spec.timeoutMessage?.(readyTimeoutMs, output) ?? startupReason(output, fallback));
    }, readyTimeoutMs);

    // Both watchers are declared before anything can fire them, so
    // `stopWatching` never touches an uninitialised handle (a 'close' that
    // arrives on the next tick cannot outrun this synchronous block).
    const poll = setInterval(() => {
      const sock = net.createConnection({ host: '127.0.0.1', port: readyPort, timeout: PROBE_CONNECT_TIMEOUT_MS }, () => {
        sock.destroy();
        finishOk();
      });
      sock.on('error', () => sock.destroy());
      sock.on('timeout', () => sock.destroy());
    }, POLL_INTERVAL_MS);

    const onError = (err: Error) => finishFail('spawn_error', `${label} spawn failed: ${err.message}`);
    const onClose = (code: number | null) => {
      exitCode = code;
      if (!settled) {
        finishFail('exited', `${label} exited during startup (code ${code ?? '?'}) — ${startupReason(output, 'no output')}`);
      }
    };
    function stopWatching() {
      clearInterval(poll);
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
    }

    child.once('error', onError);
    child.once('close', onClose);
  });
}
