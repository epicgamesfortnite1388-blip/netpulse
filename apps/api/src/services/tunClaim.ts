/**
 * TUN gateway route-claim persistence + the force-kill sweep.
 *
 * The TUN gateway (sing-box with a wintun inbound) is spawned PLAIN — no Job
 * Object — so a force-killed sidecar (taskkill, crash, power loss) orphans it:
 * an ELEVATED process that keeps holding the wintun device and its default
 * route while nothing manages it. The routes are kernel-tied to the gateway
 * process, so restoring the machine IS stopping that orphan; there is nothing
 * else to undo.
 *
 * The claim is the crash record: `startTunGateway` writes it into the
 * gateway's config dir BEFORE the spawn (the device, and with it the default
 * route, exists as soon as the process starts) and the dir is the record's
 * home — deleted by the managed cleanup path on any normal exit, leaked by a
 * force-kill.
 *
 * An orphan is identified by the CONFIG PATH in its command line, never by a
 * recorded pid alone: a leaked dir always names exactly one gateway, while pids
 * recycle and a kill during the readiness wait happens before the pid is even
 * known. When the command line cannot be read (an elevated gateway, from a
 * non-elevated relaunch) nothing is killed — the sweep reports that honestly
 * and the elevated relaunch finishes the job.
 *
 * Windows-optional: every probe degrades to "nothing to do" off-Windows, where
 * TUN mode is refused before any gateway exists.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The file `startTunGateway` writes into its config dir. */
export const TUN_CLAIM_FILE = 'gateway-claim.json';
/** Temp-dir prefix of every TUN gateway's config dir. */
export const TUN_GW_DIR_PREFIX = 'netpulse-tun-gw-';

export interface TunClaim {
  /**
   * pid of the TUN gateway process, or 0 while the claim written before the
   * spawn has not been updated yet. Never the sole basis for a kill.
   */
  gatewayPid: number;
  /** pid of the sidecar that owns the capture. */
  ownerPid: number;
  /** the gateway's verification inbound, for the status trail. */
  gatewayPort: number;
  writtenAt: number;
}

export function writeTunClaim(configDir: string, claim: Omit<TunClaim, 'writtenAt'>): void {
  try {
    fs.writeFileSync(path.join(configDir, TUN_CLAIM_FILE), JSON.stringify({ ...claim, writtenAt: Date.now() }), 'utf8');
  } catch {
    // Best effort: a missing claim only costs the sweep its owner hint — the
    // config path in the command line still identifies the gateway.
  }
}

export function readTunClaim(configDir: string): TunClaim | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, TUN_CLAIM_FILE), 'utf8')) as Partial<TunClaim>;
    if (typeof raw.gatewayPid !== 'number' || typeof raw.ownerPid !== 'number') return null;
    return {
      gatewayPid: raw.gatewayPid,
      ownerPid: raw.ownerPid,
      gatewayPort: typeof raw.gatewayPort === 'number' ? raw.gatewayPort : 0,
      writtenAt: typeof raw.writtenAt === 'number' ? raw.writtenAt : 0,
    };
  } catch {
    return null;
  }
}

/** A running sing-box process and the command line that identifies it. */
export interface GatewayProcess {
  pid: number;
  parentPid: number;
  commandLine: string;
}

export interface TunSweepDeps {
  /** This sidecar's pid — the one owner a sweep must never reap. */
  liveOwnerPid: () => number | null;
  /**
   * All running sing-box processes (batched: one lookup per sweep). `null`
   * means the lookup itself failed — a state that must never be read as
   * "no gateway exists".
   */
  listGateways?: () => Promise<GatewayProcess[] | null>;
  /** Stop a gateway process. Injectable so tests never kill a real process. */
  killGateway?: (pid: number) => void;
  /** Liveness probe. Injectable so the rules are provable on every platform. */
  isAlive?: (pid: number) => boolean;
}

export type TunSweepOutcome =
  | { kind: 'reaped'; gatewayPid: number; dir: string }
  | { kind: 'litter'; dir: string }
  | { kind: 'alive'; dir: string; reason: string }
  | { kind: 'refused'; dir: string; reason: string };

export interface TunSweepSummary {
  reaped: number;
  litter: number;
  alive: number;
  refused: number;
  /**
   * Why each refusal happened, per dir — the specific cause the user must see
   * (a command line that cannot be verified is a different situation from a
   * kill the OS refused). Counts alone cannot say which, and a refusal the user
   * cannot act on is the dead end this field exists to remove.
   */
  refusals: Array<{ dir: string; reason: string }>;
}

/**
 * The honest sentence for a sweep result, or null when there is nothing to say.
 *
 * ONE owner for this wording: the boot recovery records it as an event, the TUN
 * pre-flight refuses a start with it. `remedy` is passed in by whoever owns it
 * (`util/privileges` owns what a missing privilege costs and how to fix it) so
 * this module never invents an action of its own.
 */
export function tunSweepReport(
  summary: TunSweepSummary,
  remedy: string | null,
): { level: 'info' | 'warn'; message: string } | null {
  if (summary.refused > 0) {
    // The prefix states only what the sweep actually established — a gateway
    // record it could not release — because the two refusal causes differ in
    // how much is known about the route (one holds it, the other's identity is
    // unreadable). The per-dir reasons carry that difference; the remedy is
    // owned by whoever knows what the missing privilege costs and how to get it
    // back, so this module never invents an action.
    const reasons = [...new Set(summary.refusals.map((r) => r.reason))].join('; ');
    const facts = `${summary.refused} TUN gateway record(s) from a force-killed session could not be released — ${reasons}`;
    return { level: 'warn', message: [facts, remedy].filter(Boolean).join(' ') };
  }
  if (summary.reaped > 0) {
    return {
      level: 'info',
      message: `Recovered from an unclean shutdown — ${summary.reaped} orphaned TUN gateway(s) stopped and their default route released.`,
    };
  }
  return null;
}

/** Is `pid` a live process? (best effort; off-Windows always false) */
function pidAlive(pid: number): boolean {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Does this command line belong to the gateway described by `dir`? */
function referencesDir(commandLine: string, dir: string): boolean {
  if (!commandLine || !dir) return false;
  return commandLine.toLowerCase().includes(dir.toLowerCase());
}

/**
 * Every running sing-box process (gateways and plain cores alike). ONE
 * PowerShell call for a whole sweep: the concrete dir path is matched in JS,
 * so the enumerating shell — whose own command line holds no dir path — and any
 * other process can never be mistaken for a gateway.
 */
async function listSingboxProcesses(): Promise<GatewayProcess[] | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    const child = spawn(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "Name='sing-box.exe'" | Select-Object ProcessId,ParentProcessId,CommandLine)`,
      ],
      { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } resolve(null); }, 15_000);
    child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const text = out.trim();
      // No output at all is a failed query, not an empty process table: the
      // sweep reports it instead of treating unreadable as "nothing running".
      if (!text) return resolve(null);
      try {
        const parsed = JSON.parse(text) as unknown;
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolve(
          rows
            .map((row) => row as Record<string, unknown>)
            .filter((row) => typeof row.ProcessId === 'number')
            .map((row) => ({
              pid: row.ProcessId as number,
              parentPid: typeof row.ParentProcessId === 'number' ? row.ParentProcessId : 0,
              commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : '',
            })),
        );
      } catch {
        resolve(null);
      }
    });
  });
}

function removeDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * The gateway process behind ONE surviving temp dir, or null when nothing
 * proves one exists. `unverifiable` is the elevated case ONLY: a process runs on
 * the recorded pid and its command line cannot be read from here — the sweep
 * must not guess it is ours, must not kill it, and must not claim to know
 * whether a route is held. A pid that now belongs to some other process is
 * neither (see the body): it is proof of nothing.
 */
function gatewayForDir(
  dir: string,
  claim: TunClaim | null,
  processes: GatewayProcess[],
): { process: GatewayProcess } | { unverifiable: GatewayProcess } | null {
  const byPath = processes.find((p) => referencesDir(p.commandLine, dir));
  if (byPath) return { process: byPath };
  const byPid = claim && claim.gatewayPid ? processes.find((p) => p.pid === claim.gatewayPid) : undefined;
  if (!byPid) return null;
  // Two situations look similar and mean opposite things:
  //   - the command line is UNREADABLE (empty): the pid runs with higher rights
  //     than this process, so it may well be our gateway — never killed, never
  //     dismissed, and the reason says so.
  //   - the command line is READABLE but does not name this dir: the gateway is
  //     always spawned as `run -c <dir>/gateway.json`, so this is a RECYCLED pid
  //     — our gateway is gone and nothing of ours holds a route. Returning
  //     "unverifiable" here would strand a phantom that no amount of elevating
  //     could clear (the elevated sweep would read the same command line), so
  //     this is no proof of a gateway at all.
  return byPid.commandLine.trim() === '' ? { unverifiable: byPid } : null;
}

/**
 * Sweep ONE surviving gateway temp dir. Returns what it was and what happened:
 *   reaped  — an orphaned gateway of ours: stopped, its default route released,
 *             dir removed
 *   litter  — nothing references this dir and no claimed gateway is running, so
 *             no route is held: the dir is removed on its own
 *   alive   — the gateway's owner still runs (this or another live session):
 *             untouched
 *   refused — the gateway could not be proven stopped from here (a non-elevated
 *             relaunch can neither read an elevated process's command line nor
 *             kill it): reported honestly with the specific cause, dir kept for
 *             the elevated relaunch that finishes the job
 */
export async function sweepTunClaimDir(dir: string, deps: TunSweepDeps): Promise<TunSweepOutcome> {
  const processes = deps.listGateways ? await deps.listGateways() : await listSingboxProcesses();
  const killGateway = deps.killGateway ?? ((pid: number) => { process.kill(pid); });
  const alive = deps.isAlive ?? pidAlive;

  if (processes === null) {
    // The sweep could not look, so it must not conclude anything: nothing is
    // removed and nothing is killed while a gateway may still be running.
    return { kind: 'refused', dir, reason: 'the running processes could not be listed, so the gateway could not be identified and nothing was changed' };
  }

  const claim = readTunClaim(dir);
  const found = gatewayForDir(dir, claim, processes);
  if (!found) {
    removeDir(dir);
    return { kind: 'litter', dir };
  }
  if ('unverifiable' in found) {
    return {
      kind: 'refused',
      dir,
      reason: `a process is running on the recorded gateway pid ${found.unverifiable.pid} but its command line could not be read from here (it runs with higher rights than this app), so whether it holds a default route could not be confirmed and nothing was changed`,
    };
  }

  const gateway = found.process;
  // Owner: the claim names it exactly; without one, the gateway's own parent is
  // the best available truth (a managed gateway is spawned by its sidecar).
  const ownerPid = claim ? claim.ownerPid : gateway.parentPid;
  if (alive(ownerPid)) {
    return {
      kind: 'alive',
      dir,
      reason: ownerPid === deps.liveOwnerPid() ? 'owned by this session' : 'owner process still runs',
    };
  }

  try {
    killGateway(gateway.pid);
  } catch (err) {
    if (alive(gateway.pid)) {
      // A non-elevated relaunch cannot kill an elevated orphan (EPERM). The
      // elevated path reaps it — say so instead of pretending it is handled.
      return {
        kind: 'refused',
        dir,
        reason: `the gateway process (pid ${gateway.pid}) could not be stopped (${err instanceof Error ? err.message : String(err)}) and it still holds the default route it claimed`,
      };
    }
  }
  removeDir(dir);
  return { kind: 'reaped', gatewayPid: gateway.pid, dir };
}

/**
 * Boot-time sweep: every surviving `netpulse-tun-gw-*` dir in the OS temp marks
 * a gateway whose sidecar is gone (or a dir left by an unclean exit). Stops the
 * orphans — releasing the default route — removes the litter, and leaves
 * anything a live session still owns. Returns the summary the boot log reports.
 */
export async function sweepOrphanedTunGateways(deps: TunSweepDeps): Promise<TunSweepSummary> {
  const summary: TunSweepSummary = { reaped: 0, litter: 0, alive: 0, refused: 0, refusals: [] };
  const tmp = os.tmpdir();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(tmp)
      .filter((d) => d.startsWith(TUN_GW_DIR_PREFIX))
      .map((d) => path.join(tmp, d));
  } catch {
    return summary;
  }
  if (dirs.length === 0) return summary;

  for (const dir of dirs) {
    const outcome = await sweepTunClaimDir(dir, deps);
    summary[outcome.kind] += 1;
    if (outcome.kind === 'refused') summary.refusals.push({ dir: outcome.dir, reason: outcome.reason });
  }
  return summary;
}
