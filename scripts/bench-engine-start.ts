/**
 * Engine start-to-ready benchmark.
 *
 * Measures the exact production gate a probe, a tunnel hop and a TUN gateway
 * all wait on: `spawnCoreProcess` resolving when the core's inbound accepts
 * TCP. A real core binary is not required — the child is a stub that binds the
 * reserved port after a fixed delay, so the numbers separate OUR startup
 * latency (readiness cadence) from the child process's own boot time.
 *
 *   npx tsx scripts/bench-engine-start.ts            # default run
 *   RUNS=25 STUB_DELAY_MS=40 npx tsx scripts/bench-engine-start.ts
 *   CORE_MODULE=./baseline-core-process.ts npx tsx scripts/bench-engine-start.ts
 *
 * `CORE_MODULE` points the run at another copy of `coreProcess.ts`, which is
 * how a before/after is produced from one harness: write the previous version
 * anywhere importable, point CORE_MODULE at it, and compare the two tables.
 *
 * Reported per run, in ms, plus the summary table:
 *   ready     spawn → inbound accepts (the gate every caller blocks on)
 *   start     reserve port + write config + spawn → inbound accepts
 *   boot      spawn → the child actually started listening (NOT ours)
 *   overhead  listening → we noticed (this is the part the poll cadence owns)
 *
 * `overhead` is the number that matters for a before/after: it isolates the
 * readiness probe from process startup, which no change in this repo controls.
 * A fixed 300ms tick scored ~230-300ms here; the widening schedule scores one
 * interval at most.
 *
 * The final section answers the bulk-testing question directly: what do N
 * nodes cost when each pays its own start (the old path) versus one batched
 * core serving all of them (startMultiCore)? The stub binds every inbound in
 * the config it is given, so the same child boot is charged to both sides and
 * only the spawn/readiness/teardown count differs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findEngineBinary, startMultiCore } from '../apps/api/src/services/proxyCores.ts';

import type { CoreProcessResult, CoreProcessSpec } from '../apps/api/src/services/coreProcess.ts';

/** The seam this bench loads, so `CORE_MODULE` can swap in another copy. */
type CoreModule = {
  reservePort: () => Promise<number>;
  spawnCoreProcess: (spec: CoreProcessSpec) => Promise<CoreProcessResult>;
};

const RUNS = Number(process.env['RUNS'] ?? 15);
/** How long the stub takes to bind, i.e. a fast core. */
const STUB_DELAY_MS = Number(process.env['STUB_DELAY_MS'] ?? 15);

const STUB = `
import fs from 'node:fs';
import net from 'node:net';
const port = Number(process.argv[2]);
const delay = Number(process.argv[3] ?? 0);
const marker = process.argv[4];
const server = net.createServer((socket) => socket.destroy());
setTimeout(() => server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(marker, String(Date.now()));
}), delay);
`;

/**
 * Config-driven stub: binds EVERY inbound in the `-c <path>` config, which is
 * exactly what a real core does — one listener per node in a batched config.
 */
const BATCH_STUB = `
import fs from 'node:fs';
import net from 'node:net';
const i = process.argv.indexOf('-c');
const cfg = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
const ports = (cfg.inbounds ?? []).map((inbound) => Number(inbound.port));
const servers = ports.map((port) => {
  const server = net.createServer((socket) => socket.destroy());
  return { port, server };
});
setTimeout(() => {
  for (const { port, server } of servers) server.listen(port, '127.0.0.1');
}, Number(process.env.STUB_DELAY_MS ?? 0));
process.on('SIGTERM', () => process.exit(0));
`;

const BULK_NODES = Number(process.env.BULK_NODES ?? 8);

/** When the stub reports it is listening (its clock == ours). */
async function readBindTime(markerPath: string): Promise<number | null> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const value = Number(fs.readFileSync(markerPath, 'utf8'));
      if (Number.isFinite(value) && value > 0) return value;
    } catch {
      /* not written yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return null;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

function summary(values: number[]): string {
  const min = Math.min(...values);
  const p50 = percentile(values, 50);
  const p90 = percentile(values, 90);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return `min ${min.toFixed(0)}  p50 ${p50.toFixed(0)}  mean ${mean.toFixed(0)}  p90 ${p90.toFixed(0)}  max ${max.toFixed(0)}`;
}

async function main(): Promise<void> {
  // Loaded inside main, not at module scope: the root package is CommonJS, and
  // a top-level await here fails to transform.
  const core: CoreModule = await import(
    process.env['CORE_MODULE'] ?? '../apps/api/src/services/coreProcess.ts'
  );
  const { reservePort, spawnCoreProcess } = core;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-bench-'));
  const stubPath = path.join(workDir, 'stub-core.mjs');
  fs.writeFileSync(stubPath, STUB);
  const batchStubPath = path.join(workDir, 'stub-batch-core.mjs');
  fs.writeFileSync(batchStubPath, BATCH_STUB);
  process.env.STUB_DELAY_MS = String(STUB_DELAY_MS);

  const ready: number[] = [];
  const start: number[] = [];
  const boot: number[] = [];
  const overhead: number[] = [];

  try {
    for (let i = 0; i < RUNS; i += 1) {
      // ---- the gate on its own: spawn → ready ----
      const portA = await reservePort();
      const configDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-bench-cfg-'));
      fs.writeFileSync(path.join(configDirA, 'core.json'), '{"inbounds":[]}');
      const markerA = path.join(workDir, `bind-a-${i}.txt`);

      const t0 = Date.now();
      const runA = await spawnCoreProcess({
        bin: process.execPath,
        args: [stubPath, String(portA), String(STUB_DELAY_MS), markerA],
        readyPort: portA,
        readyTimeoutMs: 5_000,
        tempDir: configDirA,
        label: 'core',
      });
      const detectedA = Date.now();
      if (!runA.ok) throw new Error(`ready run failed: ${runA.failure} ${runA.error}`);
      runA.process.cleanup();
      ready.push(detectedA - t0);

      const bindA = await readBindTime(markerA);
      if (bindA != null) {
        boot.push(bindA - t0);
        // Negative only when the child's marker write landed after our connect
        // succeeded — that is a detection at zero overhead, not a clock skew.
        overhead.push(Math.max(0, detectedA - bindA));
      }

      // ---- the whole startCore-shaped cost: reserve + write + spawn → ready ----
      const startAt = Date.now();
      const portB = await reservePort();
      const configDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-bench-cfg-'));
      fs.writeFileSync(
        path.join(configDirB, 'core.json'),
        JSON.stringify({ inbounds: [{ port: portB }], outbounds: [] }),
      );
      const markerB = path.join(workDir, `bind-b-${i}.txt`);
      const runB = await spawnCoreProcess({
        bin: process.execPath,
        args: [stubPath, String(portB), String(STUB_DELAY_MS), markerB],
        readyPort: portB,
        readyTimeoutMs: 5_000,
        tempDir: configDirB,
        label: 'core',
      });
      const startMs = Date.now() - startAt;
      if (!runB.ok) throw new Error(`start run failed: ${runB.failure} ${runB.error}`);
      runB.process.cleanup();
      start.push(startMs);
    }

    // Binary discovery runs on every engine status / probe call; time it so a
    // cache is only added if it is actually worth anything.
    const lookups: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const t = performance.now();
      findEngineBinary('xray');
      lookups.push(performance.now() - t);
    }

    console.log(`\nengine start benchmark · runs ${RUNS} · stub binds after ${STUB_DELAY_MS}ms · ${process.platform}\n`);
    console.log(`ready     (spawn → inbound answers)        ${summary(ready)}`);
    console.log(`start     (port+config+spawn → answers)    ${summary(start)}`);
    if (boot.length > 0) {
      console.log(`boot      (child process boots)            ${summary(boot)}`);
      console.log(`overhead  (listening → we notice it)       ${summary(overhead)}`);
    }
    console.log(`findEngineBinary('xray')                   ${summary(lookups)}`);

    // ---- per-node start vs one batched core, for the same node count ----
    const singleStart = async (): Promise<void> => {
      const port = await reservePort();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-bench-cfg-'));
      const cfg = path.join(dir, 'core.json');
      fs.writeFileSync(cfg, JSON.stringify({ inbounds: [{ port }], outbounds: [] }));
      const run = await spawnCoreProcess({
        bin: process.execPath,
        args: [batchStubPath, '-c', cfg],
        readyPort: port,
        readyTimeoutMs: 5_000,
        tempDir: dir,
        label: `core-${port}`,
      });
      if (!run.ok) throw new Error(`single start failed: ${run.error}`);
      run.process.cleanup();
    };

    const batchStart = async (): Promise<void> => {
      const nodes = Array.from({ length: BULK_NODES }, () => ({
        config: {
          protocol: 'vless' as const,
          host: 'node.example',
          port: 443,
          transport: 'tcp' as const,
          security: 'tls' as const,
          sni: 'node.example',
          alpn: [],
        },
        secret: 'bench-secret',
      }));
      const run = await startMultiCore(
        { id: 'xray', bin: process.execPath, args: [batchStubPath] },
        nodes as never,
      );
      if (!run.ok) throw new Error(`batch start failed: ${run.error}`);
      run.run.cleanup();
    };

    const timeIt = async (fn: () => Promise<void>): Promise<number> => {
      const t = Date.now();
      await fn();
      return Date.now() - t;
    };

    const bulkRuns = Math.max(1, Math.round(RUNS / 2));
    const perNodeSequential: number[] = [];
    const perNodeConcurrent: number[] = [];
    const batched: number[] = [];
    for (let i = 0; i < bulkRuns; i += 1) {
      perNodeSequential.push(await timeIt(async () => {
        for (let n = 0; n < BULK_NODES; n += 1) await singleStart();
      }));
      // The old runner probed ~8 nodes concurrently: same node count, N spawns.
      perNodeConcurrent.push(await timeIt(() => Promise.all(Array.from({ length: BULK_NODES }, singleStart)).then(() => undefined)));
      batched.push(await timeIt(batchStart));
    }

    console.log(`\nbulk ${BULK_NODES} nodes · ${bulkRuns} runs · processes per run: per-node ${BULK_NODES} · batched 1\n`);
    console.log(`per-node, sequential starts  ${summary(perNodeSequential)}   (${BULK_NODES} spawns)`);
    console.log(`per-node, ${BULK_NODES} concurrent     ${summary(perNodeConcurrent)}   (${BULK_NODES} spawns)`);
    console.log(`one batched core             ${summary(batched)}   (1 spawn)`);
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

void main();
