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
 *   5. Every port is checked FREE before the spawn. The caller either reserved
 *      them a moment earlier or owns one outright (an engine with a fixed
 *      loopback port), so something already answering means the process would
 *      bind-fail or, worse, the readiness poll would see the squatter's answer
 *      and report a ready core that is not ours. That clash is reported as its
 *      own failure, so the caller can retry on fresh ports (cores) or say
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

/**
 * Readiness probing cadence, and how long one probe waits for a connect.
 *
 * The schedule WIDENS instead of ticking at a fixed rate. A core typically
 * answers within a few tens of milliseconds of being spawned, so the first
 * probes are close together and the intervals then stretch out by 1.5x to a
 * 40ms ceiling. This used to be a flat 300ms `setInterval`, which meant a core
 * that was ready in 20ms was still not reported until the next tick: every
 * probe, tunnel hop and TUN gateway start paid up to 300ms of pure dead wait
 * (measured: 320ms median spawn→ready against a stub that binds in 15ms).
 *
 * The ceiling stays low rather than growing towards the caller's timeout for a
 * reason: detection can never be closer than one interval, and the cost of a
 * probe is one loopback `connect()` — under a millisecond — so a 40ms ceiling
 * buys a bounded, predictable start instead of saving negligible CPU. Probes
 * stop entirely the moment the start settles.
 */
const FIRST_PROBE_DELAY_MS = 0;
const PROBE_START_INTERVAL_MS = 8;
const PROBE_BACKOFF = 1.5;
const PROBE_MAX_INTERVAL_MS = 40;
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
  /**
   * Additional inbounds in the SAME config (batched probing). Readiness means
   * every port accepts, so a core that started with three of twelve listeners
   * bound is not reported as ready while nine probes would fail against a
   * closed port.
   */
  extraReadyPorts?: readonly number[];
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
  // Deduplicated: a caller may reserve the same port twice by accident and the
  // core would then refuse its own config for a reason that is ours, not its.
  const readyPorts = [...new Set([readyPort, ...(spec.extraReadyPorts ?? [])])];

  // Rule 5: a squatter on a reserved port is not this core's fault, and
  // mistaking its answer for our readiness would report a working core that
  // does not exist. Every port in the config matters: one taken inbound means
  // the core will not bind that listener at all.
  const taken = [];
  for (const port of readyPorts) {
    if (!(await portIsFree(port))) taken.push(port);
  }
  if (taken.length > 0) {
    // The temp dir is the owner's from the moment it is handed over, on EVERY
    // outcome — including a refusal that never reached a spawn. It holds the
    // node's credentials.
    removeTempDir(tempDir);
    return {
      ok: false,
      failure: 'port_clash',
      error: `port ${taken[0]} is already in use — the ${label} was not spawned`,
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
    // One probe in flight at a time: a connect that hangs for its 400ms
    // timeout must not let probes stack up behind it.
    let probeTimer: NodeJS.Timeout | null = null;
    let probeInterval = PROBE_START_INTERVAL_MS;
    let probeInFlight = false;

    // Declared before `scheduleProbe` is assigned, so `stopWatching` can clear
    // a pending probe however the start ends (ready, exited, spawn error
    // timeout) without depending on declaration order.
    function probe() {
      if (settled) return;
      if (probeInFlight) {
        scheduleProbe(probeInterval);
        return;
      }
      probeInFlight = true;
      let probeDone = false;

      const settleProbe = (ready: boolean) => {
        if (probeDone) return;
        probeDone = true;
        probeInFlight = false;
        if (settled) return;
        if (ready) {
          finishOk();
          return;
        }
        probeInterval = Math.min(PROBE_MAX_INTERVAL_MS, Math.round(probeInterval * PROBE_BACKOFF));
        scheduleProbe(probeInterval);
      };

      // A batched core opens several inbounds; ALL of them must answer before
      // it is ready, or some probes in the batch would run against a port that
      // nothing listens on. Each check is a loopback connect with its own
      // timeout, so a single hung listener cannot stall the cycle.
      const probes = readyPorts.map((port) => new Promise<boolean>((resolve) => {
        let done = false;
        const settle = (up: boolean) => {
          if (done) return;
          done = true;
          resolve(up);
        };
        const sock = net.createConnection({ host: '127.0.0.1', port, timeout: PROBE_CONNECT_TIMEOUT_MS }, () => {
          sock.destroy();
          settle(true);
        });
        // Before the core binds, the loopback port simply refuses — that is the
        // expected answer for the first probes, not a failure of the start.
        sock.on('error', () => {
          sock.destroy();
          settle(false);
        });
        sock.on('timeout', () => {
          sock.destroy();
          settle(false);
        });
      }));

      void Promise.all(probes).then((up) => settleProbe(up.every(Boolean)));
    }

    function scheduleProbe(delay: number) {
      probeTimer = setTimeout(probe, delay);
    }

    scheduleProbe(FIRST_PROBE_DELAY_MS);

    const onError = (err: Error) => finishFail('spawn_error', `${label} spawn failed: ${err.message}`);
    const onClose = (code: number | null) => {
      exitCode = code;
      if (!settled) {
        finishFail('exited', `${label} exited during startup (code ${code ?? '?'}) — ${startupReason(output, 'no output')}`);
      }
    };
    function stopWatching() {
      if (probeTimer) clearTimeout(probeTimer);
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
    }

    child.once('error', onError);
    child.once('close', onClose);
  });
}
