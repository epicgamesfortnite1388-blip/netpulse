import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readTunClaim,
  sweepOrphanedTunGateways,
  sweepTunClaimDir,
  TUN_CLAIM_FILE,
  tunSweepReport,
  writeTunClaim,
} from '../src/services/tunClaim';

import type { GatewayProcess, TunSweepSummary } from '../src/services/tunClaim';

/**
 * The TUN route-claim crash record — the force-kill story for the default
 * route, mirroring the kill-switch proxy guard:
 *
 *   1. the claim is written into the gateway's config dir BEFORE the spawn, so
 *      a kill during the readiness wait (before the pid is known) still leaves
 *      a record; the dir itself is the record's home — deleted by the managed
 *      cleanup path, leaked by a force-kill;
 *   2. an orphan is identified by the CONFIG PATH in its command line, so a
 *      leaked dir from any era is matched to exactly one gateway and pids can
 *      never be recycled into a victim;
 *   3. nothing is ever killed without proof: a live owner (this or another
 *      session) means untouched, an unreadable command line (an elevated
 *      gateway seen from a non-elevated relaunch) and a refused kill are
 *      reported as `refused` with the reason, never guessed through.
 *
 * Every dependency (process listing, liveness, kill) is injected, so these
 * tests kill nothing and behave identically on every platform.
 */

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-tunclaim-test-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function gwDir(name: string): string {
  const dir = path.join(tmp, `netpulse-tun-gw-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A gateway process whose command line names this dir's config file. */
function gatewayFor(dir: string, pid: number, parentPid: number): GatewayProcess {
  return { pid, parentPid, commandLine: `C:\\cores\\sing-box.exe run -c ${path.join(dir, 'gateway.json')}` };
}

interface Harness {
  deps: Parameters<typeof sweepTunClaimDir>[1];
  killed: number[];
  alive: Set<number>;
}

function harness(opts: { processes: GatewayProcess[]; alive?: number[]; liveOwnerPid?: number }): Harness {
  const alive = new Set(opts.alive ?? []);
  const killed: number[] = [];
  return {
    killed,
    alive,
    deps: {
      liveOwnerPid: () => opts.liveOwnerPid ?? 4242,
      listGateways: async () => opts.processes,
      isAlive: (pid: number) => alive.has(pid),
      killGateway: (pid: number) => {
        killed.push(pid);
        alive.delete(pid);
      },
    },
  };
}

describe('tunClaim', () => {
  it('writes and reads back a claim; a corrupt file reads as null', () => {
    const dir = gwDir('a');
    writeTunClaim(dir, { gatewayPid: 4242, ownerPid: 777, gatewayPort: 45699 });

    const claim = readTunClaim(dir);
    expect(claim).not.toBeNull();
    expect(claim!.gatewayPid).toBe(4242);
    expect(claim!.ownerPid).toBe(777);
    expect(claim!.gatewayPort).toBe(45699);
    expect(claim!.writtenAt).toBeGreaterThan(0);

    fs.writeFileSync(path.join(dir, TUN_CLAIM_FILE), '{not json', 'utf8');
    expect(readTunClaim(dir)).toBeNull();
  });

  it('reaps an orphan identified by config path when the pre-spawn claim has no pid yet', async () => {
    const dir = gwDir('b');
    // The claim as written BEFORE the spawn: no pid, owner dead (force-killed).
    writeTunClaim(dir, { gatewayPid: 0, ownerPid: 777, gatewayPort: 45699 });
    const h = harness({ processes: [gatewayFor(dir, 5555, 777)] });

    const outcome = await sweepTunClaimDir(dir, h.deps);

    expect(outcome).toMatchObject({ kind: 'reaped', gatewayPid: 5555 });
    expect(h.killed).toEqual([5555]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('reaps a legacy dir with no claim at all when its gateway outlived its parent', async () => {
    const dir = gwDir('c'); // leaked before claims existed — the process is the only clue
    const h = harness({ processes: [gatewayFor(dir, 6666, 777)], alive: [] });

    const outcome = await sweepTunClaimDir(dir, h.deps);

    expect(outcome).toMatchObject({ kind: 'reaped', gatewayPid: 6666 });
    expect(h.killed).toEqual([6666]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('removes a dir nothing references as litter — no kill, no guess', async () => {
    const dir = gwDir('d');
    const h = harness({ processes: [] });

    const outcome = await sweepTunClaimDir(dir, h.deps);

    expect(outcome.kind).toBe('litter');
    expect(h.killed).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('never touches a gateway whose owner still runs — this session or another', async () => {
    const dir = gwDir('e');
    writeTunClaim(dir, { gatewayPid: 5555, ownerPid: 777, gatewayPort: 1 });
    const mine = harness({ processes: [gatewayFor(dir, 5555, 777)], alive: [777], liveOwnerPid: 777 });
    const other = harness({ processes: [gatewayFor(dir, 5555, 777)], alive: [777], liveOwnerPid: 4242 });

    expect(await sweepTunClaimDir(dir, mine.deps)).toMatchObject({ kind: 'alive', reason: 'owned by this session' });
    expect(await sweepTunClaimDir(dir, other.deps)).toMatchObject({ kind: 'alive', reason: 'owner process still runs' });
    expect(mine.killed).toEqual([]);
    expect(other.killed).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('resolves a RECYCLED pid as stale instead of blocking on a phantom gateway', async () => {
    const dir = gwDir('f2');
    // The recorded pid now belongs to a different sing-box (a plain node test,
    // say): the gateway is spawned as `run -c <dir>/gateway.json`, so a readable
    // command line that is not that cannot be our gateway. Treating it as the
    // elevated shape would strand TUN behind an action (elevate) that can never
    // clear it — the elevated sweep would read the same command line.
    writeTunClaim(dir, { gatewayPid: 4242, ownerPid: 777, gatewayPort: 1 });
    const h = harness({
      processes: [{ pid: 4242, parentPid: 777, commandLine: 'C:\\cores\\sing-box.exe run -c C:\\tmp\\np-test-xyz\\core.json' }],
      alive: [4242],
    });

    const outcome = await sweepTunClaimDir(dir, h.deps);

    expect(outcome.kind).toBe('litter');
    expect(h.killed).toEqual([]); // an unrelated process is never killed
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses — never kills — when the claimed gateway runs but its command line is unreadable', async () => {
    const dir = gwDir('f');
    writeTunClaim(dir, { gatewayPid: 5555, ownerPid: 777, gatewayPort: 1 });
    // Elevated gateway: the pid is visible, the command line is not (ACL).
    const h = harness({ processes: [{ pid: 5555, parentPid: 777, commandLine: '' }], alive: [5555] });

    const outcome = await sweepTunClaimDir(dir, h.deps);

    expect(outcome).toMatchObject({ kind: 'refused' });
    const reason = (outcome as { reason: string }).reason;
    // The certainty is stated, not overstated: an unreadable command line means
    // whether a route is held is UNKNOWN — this layer must not claim one is.
    expect(reason).toMatch(/command line could not be read/);
    expect(reason).toMatch(/could not be confirmed/);
    expect(reason).not.toMatch(/still holds/);
    // ...and it invents no action: the remedy belongs to the privilege owner
    // (util/privileges), which the report layer appends.
    expect(reason).not.toMatch(/administrator/);
    expect(h.killed).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('reports a refused kill (non-elevated cannot stop an elevated orphan) with the reason', async () => {
    const dir = gwDir('g');
    writeTunClaim(dir, { gatewayPid: 5555, ownerPid: 777, gatewayPort: 1 });
    const h = harness({ processes: [gatewayFor(dir, 5555, 777)], alive: [5555] });
    const failing = {
      ...h.deps,
      killGateway: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
    };

    const outcome = await sweepTunClaimDir(dir, failing);

    expect(outcome).toMatchObject({ kind: 'refused' });
    const reason = (outcome as { reason: string }).reason;
    // Here the command line DID prove it is our gateway, so the route claim is
    // justified — the opposite of the unverifiable case above.
    expect(reason).toMatch(/EPERM/);
    expect(reason).toMatch(/still holds the default route/);
    expect(fs.existsSync(dir)).toBe(true); // kept for the elevated relaunch
  });

  it('changes nothing when the process listing itself fails', async () => {
    const dir = gwDir('h');
    writeTunClaim(dir, { gatewayPid: 0, ownerPid: 999999, gatewayPort: 1 });
    const h = harness({ processes: [] });

    const outcome = await sweepTunClaimDir(dir, { ...h.deps, listGateways: async () => null });

    expect(outcome).toMatchObject({ kind: 'refused' });
    expect((outcome as { reason: string }).reason).toMatch(/could not be listed/);
    expect(h.killed).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('the summary carries the CONCRETE reason for every refusal, not just a count', async () => {
    const dir = path.join(os.tmpdir(), `netpulse-tun-gw-test-refused-${process.pid}`);
    fs.mkdirSync(dir, { recursive: true });
    writeTunClaim(dir, { gatewayPid: 9090, ownerPid: 111, gatewayPort: 3 });
    try {
      const summary = await sweepOrphanedTunGateways({
        liveOwnerPid: () => process.pid,
        // The elevated-orphan shape: the pid is in the process table, its
        // command line is not readable from here.
        listGateways: async () => [{ pid: 9090, parentPid: 111, commandLine: '' }],
        isAlive: () => false,
        killGateway: () => undefined,
      });
      expect(summary.refused).toBeGreaterThanOrEqual(1);
      const mine = summary.refusals.find((r) => r.dir === dir);
      expect(mine?.reason).toMatch(/command line could not be read/);
      expect(mine?.reason).toMatch(/pid 9090/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the summary buckets every outcome kind (real temp layout)', async () => {
    // The sweep reads DIRECT children of the OS temp, so place the marks there
    // (as the real gateway does) and clean them up whatever happens.
    const mine = path.join(os.tmpdir(), `netpulse-tun-gw-test-alive-${process.pid}`);
    const orphan = path.join(os.tmpdir(), `netpulse-tun-gw-test-orphan-${process.pid}`);
    const litter = path.join(os.tmpdir(), `netpulse-tun-gw-test-litter-${process.pid}`);
    for (const d of [mine, orphan, litter]) fs.mkdirSync(d, { recursive: true });
    writeTunClaim(mine, { gatewayPid: 5555, ownerPid: process.pid, gatewayPort: 1 });
    writeTunClaim(orphan, { gatewayPid: 6666, ownerPid: 111, gatewayPort: 2 });
    try {
      const summary = await sweepOrphanedTunGateways({
        liveOwnerPid: () => process.pid,
        listGateways: async () => [gatewayFor(mine, 5555, process.pid), gatewayFor(orphan, 6666, 111)],
        isAlive: (pid) => pid === process.pid || pid === 5555,
        killGateway: () => undefined,
      });
      expect(summary.alive).toBeGreaterThanOrEqual(1);
      expect(summary.reaped).toBeGreaterThanOrEqual(1);
      expect(summary.litter).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(mine)).toBe(true); // owner alive: untouched
      expect(fs.existsSync(orphan)).toBe(false);
      expect(fs.existsSync(litter)).toBe(false);
      // A reap is good news, not a refusal: nothing to refuse about.
      expect(summary.refusals).toEqual([]);
    } finally {
      for (const d of [mine, orphan, litter]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

/**
 * The one place the user-facing wording for a sweep is written: the boot event
 * and the TUN pre-flight both read it, so a refusal cannot be reported as a
 * vague "something went wrong" in one surface and precisely in the other.
 */
describe('tunSweepReport', () => {
  const clean: TunSweepSummary = { reaped: 0, litter: 0, alive: 0, refused: 0, refusals: [] };

  it('says nothing when nothing happened (litter alone is housekeeping)', () => {
    expect(tunSweepReport(clean, null)).toBeNull();
    expect(tunSweepReport({ ...clean, litter: 3, alive: 2 }, 'ignored')).toBeNull();
  });

  it('reports a recovery with the real count', () => {
    const report = tunSweepReport({ ...clean, reaped: 2 }, null);
    expect(report?.level).toBe('info');
    expect(report?.message).toMatch(/2 orphaned TUN gateway\(s\) stopped and their default route released/);
  });

  it('carries every distinct refusal reason and the action, never a bare count', () => {
    const report = tunSweepReport(
      {
        ...clean,
        refused: 2,
        refusals: [
          { dir: 'C:/tmp/a', reason: 'command line cannot be verified from here' },
          { dir: 'C:/tmp/b', reason: 'kill refused (EPERM)' },
          { dir: 'C:/tmp/c', reason: 'command line cannot be verified from here' },
        ],
      },
      'Restart the app with administrator rights.',
    );
    expect(report?.level).toBe('warn');
    expect(report?.message).toContain('2 TUN gateway record(s) from a force-killed session could not be released');
    expect(report?.message).toContain('command line cannot be verified from here');
    expect(report?.message).toContain('kill refused (EPERM)');
    expect(report?.message).toContain('Restart the app with administrator rights.');
    // A repeated cause is stated once — three dirs with two causes, not three
    // copies of the same sentence.
    expect(report?.message.match(/command line cannot be verified/g)).toHaveLength(1);
  });

  it('states the refusal without inventing an action when there is none', () => {
    const report = tunSweepReport(
      { ...clean, refused: 1, refusals: [{ dir: 'C:/tmp/a', reason: 'kill refused (EPERM)' }] },
      null,
    );
    expect(report?.message).toContain('kill refused (EPERM)');
    expect(report?.message).not.toMatch(/administrator/);
  });
});
