/**
 * Bulk node-test benchmark: one core per node vs shared cores, on a REAL node
 * list, through a REAL core binary.
 *
 * The two paths timed here are the ones the production routes call:
 *
 *   per node   `proxyProbeWithEngine`  — what `POST /nodes/:id/test` reaches
 *                                        (through `proxyProbe`), and what the
 *                                        pre-batching bulk runner did for every
 *                                        node in a scan: one core spawned,
 *                                        readied, probed and torn down per node.
 *   batched    `proxyProbeManyWithEngine` — what `POST /nodes/test-batch`
 *                                        reaches (through `proxyProbeMany`):
 *                                        several nodes in ONE core (routing
 *                                        pins node i to inbound port i), so a
 *                                        scan pays one spawn per group.
 *
 * Everything it measures with is real: real nodes with their real credentials,
 * a real core binary, and a real HTTPS request tunnelled through each node.
 * Two sources for the node list:
 *
 *   the installed app (default)  the same SQLite database and the same
 *                               encrypted vault the app uses — read-only, and
 *                               the app is NOT booted, so no scheduler, source
 *                               refresh or boot auto-connect runs as a side
 *                               effect of benchmarking.
 *   NODES_FILE=<path>            one share link per line (whatever the app's
 *                               node export writes: vless://, trojan://, …),
 *                               parsed by the app's own URI parsers. Use this
 *                               to benchmark nodes you know carry traffic —
 *                               e.g. your own servers — without touching the
 *                               app's database or vault at all.
 *
 *   npx tsx scripts/bench-bulk-probe.ts                    # 24 real nodes, xray
 *   NODES=8 REPEAT=2 npx tsx scripts/bench-bulk-probe.ts    # quick run
 *   NODES_FILE=nodes.txt npx tsx scripts/bench-bulk-probe.ts
 *   ENGINE=sing-box CONCURRENCY=1 npx tsx scripts/bench-bulk-probe.ts
 *   DATA_DIR=/path/to/app-data npx tsx scripts/bench-bulk-probe.ts
 *
 * Proving the DOWNLOAD leg without touching the installed cores: a core already
 * in <dataDir>/cores is always found, so BOTH the cores dir and the data dir
 * have to move to scratch paths, with the nodes supplied from a file. The run
 * then fetches a real release (checksum-verified by the app's installer) before
 * it can probe anything:
 *
 *   NETPULSE_CORES_DIR=/tmp/bench-cores DATA_DIR=/tmp/bench-data \
 *     NODES_FILE=nodes.txt npx tsx scripts/bench-bulk-probe.ts
 *
 * Knobs (env): NODES, NODES_FILE, REPEAT, CONCURRENCY (per-node in-flight;
 * 1 = strictly sequential), ENGINE ('auto' | xray | sing-box | v2ray |
 * hysteria), INSTALL=0 to forbid a download, TEST_URL, TIMEOUT_MS, DATA_DIR /
 * NETPULSE_DATA_DIR.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { coresDir, installEngine, probeBinaryVersion, type InstallOutcome } from '../apps/api/src/services/engineManager.ts';
import { parseNodeUri } from '../apps/api/src/services/nodeParsers.ts';
import { probeConfigOf } from '../apps/api/src/services/nodeTestProbes.ts';
import { NodeSecretVault } from '../apps/api/src/services/nodeSecretVault.ts';
import { findEngineBinary } from '../apps/api/src/services/proxyCores.ts';
import {
  BULK_CORES_IN_FLIGHT,
  BULK_NODES_PER_CORE,
  proxyProbeManyWithEngine,
  proxyProbeWithEngine,
  type EngineProbeResult,
} from '../apps/api/src/services/proxyEngineRunner.ts';

import type { ParsedNodeConfig, ProxyEngineId, PublicNode } from '@netpulse/shared';

/** Tauri identifier, mirrored from src-tauri/src/paths.rs (the app data dir). */
const APP_IDENTIFIER = 'app.netpulse.desktop';

const SAMPLE_SIZE = Number(process.env['NODES'] ?? 24);
const NODES_FILE = process.env['NODES_FILE'] ?? null;
const ROUNDS = Math.max(1, Number(process.env['REPEAT'] ?? 1));
const CONCURRENCY = Math.max(1, Number(process.env['CONCURRENCY'] ?? 8));
const ENGINE = (process.env['ENGINE'] ?? 'auto') as 'auto' | ProxyEngineId;
const INSTALL = process.env['INSTALL'] !== '0';
/** The app's own fallback probe target (see resolveTestEndpoint). */
const TEST_URL = process.env['TEST_URL'] ?? 'https://httpbin.org/ip';
const TIMEOUT_MS = Number(process.env['TIMEOUT_MS'] ?? 0) || undefined;

/** Cores we are willing to locate or fetch, best first (xray has the best
 * Reality/XTLS fidelity, and its releases publish verifiable digests). */
const CORE_CANDIDATES: readonly ProxyEngineId[] =
  ENGINE === 'auto' ? ['xray', 'sing-box', 'v2ray'] : [ENGINE];

function defaultDataDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env['APPDATA'] ?? os.homedir(), APP_IDENTIFIER);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_IDENTIFIER);
  }
  return path.join(process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'), APP_IDENTIFIER);
}

function fail(message: string): never {
  process.stderr.write(`\nbench-bulk-probe: ${message}\n`);
  process.exit(2);
}

/* ------------------------------- node list ------------------------------- */

/** One node to probe, whichever source it came from. */
type ProbeEntry = {
  id: string;
  label: string;
  protocol: string;
  config: ParsedNodeConfig;
  secret: string | null;
};

type Sample = { entries: ProbeEntry[]; source: string; total: number | null; provenBefore: number; skipped: number };

type RawRow = {
  id: string;
  protocol: string;
  host: string;
  port: number;
  transport: string;
  security: string;
  sni: string | null;
  alpn: string | null;
  fingerprint: string | null;
  flow: string | null;
  alter_id: number | null;
  path: string | null;
  host_header: string | null;
  service_name: string | null;
  allow_insecure: number;
  reality_public_key: string | null;
  reality_short_id: string | null;
  reality_server_name: string | null;
  encryption: string | null;
  ssr_protocol: string | null;
  remark: string | null;
  last_proxy_ms: number | null;
};

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Only the fields the probe path reads (`probeConfigOf` plus the node's own id
 * and host): the sample comes from raw rows, not the DTO mapper, so the DTO's
 * display metadata is absent and deliberately unused.
 */
function toNode(row: RawRow): PublicNode {
  return {
    id: row.id,
    protocol: row.protocol,
    host: row.host,
    ipv4: [],
    ipv6: [],
    port: row.port,
    transport: row.transport,
    security: row.security,
    sni: row.sni,
    alpn: parseJsonArray(row.alpn),
    fingerprint: row.fingerprint,
    flow: row.flow,
    alterId: row.alter_id,
    path: row.path,
    hostHeader: row.host_header,
    serviceName: row.service_name,
    allowInsecure: row.allow_insecure === 1,
    realityPublicKey: row.reality_public_key,
    realityShortId: row.reality_short_id,
    realityServerName: row.reality_server_name,
    encryption: row.encryption,
    ssrProtocol: row.ssr_protocol,
    remark: row.remark,
  } as unknown as PublicNode;
}

const labelOf = (config: ParsedNodeConfig, fallback: string): string => {
  const remark = typeof config.remark === 'string' ? config.remark.trim() : '';
  return remark.length > 0 ? remark.slice(0, 34) : fallback;
};

/**
 * Pick `limit` real nodes from the app database, spread across protocols.
 *
 * Ordering puts nodes with a recorded successful proxy test first, then the
 * higher-scored ones, but the round-robin over protocols is what keeps the
 * sample representative — the batched runner groups by the core that can dial
 * a protocol, so a single-protocol sample would not exercise it. Both modes
 * probe this same list, so the comparison stays apples-to-apples even where a
 * node fails.
 */
function loadFromApp(dataDir: string, limit: number): Sample {
  const dbPath = path.join(dataDir, 'netpulse.db');
  if (!fs.existsSync(dbPath)) {
    fail(`no node database at ${dbPath} — pass NODES_FILE=<share links>, or DATA_DIR=<app data dir>`);
  }
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const total = (sqlite.prepare('SELECT COUNT(*) AS n FROM public_nodes').get() as { n: number }).n;
    const rows = sqlite
      .prepare(
        `SELECT id, protocol, host, port, transport, security, sni, alpn, fingerprint, flow,
                alter_id, path, host_header, service_name, allow_insecure, reality_public_key,
                reality_short_id, reality_server_name, encryption, ssr_protocol, remark, last_proxy_ms
         FROM public_nodes
         ORDER BY (last_proxy_ms IS NOT NULL) DESC, score DESC
         LIMIT ?`,
      )
      .all(Math.max(limit * 8, limit)) as RawRow[];

    const byProtocol = new Map<string, RawRow[]>();
    for (const row of rows) {
      const list = byProtocol.get(row.protocol) ?? [];
      list.push(row);
      byProtocol.set(row.protocol, list);
    }
    const picked: RawRow[] = [];
    while (picked.length < Math.min(limit, rows.length)) {
      let progressed = false;
      for (const list of byProtocol.values()) {
        const next = list.shift();
        if (!next) continue;
        picked.push(next);
        progressed = true;
        if (picked.length >= limit) break;
      }
      if (!progressed) break;
    }

    const vault = new NodeSecretVault(path.join(dataDir, 'secrets', 'vault'));
    const entries = picked.map((row): ProbeEntry => {
      const node = toNode(row);
      return {
        id: node.id,
        label: labelOf(probeConfigOf(node), `${node.host}:${node.port}`),
        protocol: node.protocol,
        config: probeConfigOf(node),
        secret: vault.get(node.id),
      };
    });
    return {
      entries,
      source: `app database ${dbPath} (node credentials from ${path.join(dataDir, 'secrets', 'vault')})`,
      total,
      provenBefore: picked.filter((r) => r.last_proxy_ms != null).length,
      skipped: 0,
    };
  } finally {
    sqlite.close();
  }
}

/** One share link per line, parsed by the app's own URI parsers. */
function loadFromFile(file: string, limit: number): Sample {
  if (!fs.existsSync(file)) fail(`NODES_FILE=${file} does not exist`);
  const lines = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  const entries: ProbeEntry[] = [];
  let skipped = 0;
  for (const line of lines.slice(0, limit)) {
    const parsed = parseNodeUri(line);
    if (!parsed.result || !parsed.result.config) {
      skipped += 1;
      continue;
    }
    const config = parsed.result.config;
    const secret = (parsed.result as { secret?: string }).secret ?? null;
    entries.push({
      id: `file:${entries.length}`,
      label: labelOf(config, `line ${entries.length + 1} (${parsed.protocol})`),
      protocol: parsed.protocol,
      config,
      secret,
    });
  }
  return { entries, source: `share-link file ${file}`, total: lines.length, provenBefore: 0, skipped };
}

/* -------------------------------- core ----------------------------------- */

type Core = { id: ProxyEngineId; bin: string; version: string | null; install: InstallOutcome | null };

/**
 * Locate a core the way the app does (`findEngineBinary`: NETPULSE_CORES_DIR,
 * then <dataDir>/cores, then PATH), and only when nothing is installed, fetch
 * one with the app's own verified installer.
 */
async function ensureCore(): Promise<Core> {
  for (const id of CORE_CANDIDATES) {
    const bin = findEngineBinary(id);
    if (bin) return { id, bin, version: await probeBinaryVersion(bin, 4_000), install: null };
  }
  if (!INSTALL) {
    fail(
      `no proxy core installed (looked for ${CORE_CANDIDATES.join(', ')} in ${coresDir()} and PATH) and INSTALL=0`,
    );
  }

  const failures: string[] = [];
  for (const id of CORE_CANDIDATES) {
    process.stdout.write(`no core installed — downloading ${id} from its official release…\n`);
    const outcome = await installEngine(id);
    if (outcome.status === 'failed') {
      failures.push(`${id}: ${outcome.error ?? 'unknown error'}`);
      continue;
    }
    const bin = findEngineBinary(id);
    if (!bin) {
      failures.push(`${id}: installer reported ${outcome.status} but no binary was found in ${coresDir()}`);
      continue;
    }
    return { id, bin, version: outcome.versionOutput ?? (await probeBinaryVersion(bin, 4_000)), install: outcome };
  }
  fail(`could not obtain a proxy core:\n  ${failures.join('\n  ')}`);
}

/* ------------------------------- probing --------------------------------- */

type NodeOutcome = {
  id: string;
  ok: boolean;
  latencyMs: number | null;
  engine: ProxyEngineId | null;
  error: string | null;
};

type ModeRun = { label: string; wallMs: number; spawns: number; outcomes: NodeOutcome[] };

const outcomeOf = (entry: ProbeEntry, result: EngineProbeResult): NodeOutcome => ({
  id: entry.id,
  ok: result.status === 'done',
  latencyMs: result.latencyMs,
  engine: result.engine,
  error: result.error,
});

/**
 * One core per node, `concurrency` of them in flight: what the pre-batching
 * bulk runner did for every node in a scan. `concurrency: 1` is the strictly
 * sequential reading.
 */
async function perNodeRun(
  label: string,
  entries: readonly ProbeEntry[],
  concurrency: number,
): Promise<ModeRun> {
  const outcomes: NodeOutcome[] = new Array(entries.length);
  let cursor = 0;
  const started = Date.now();
  const worker = async (): Promise<void> => {
    while (cursor < entries.length) {
      const index = cursor++;
      const entry = entries[index]!;
      const result = await proxyProbeWithEngine(entry.config, {
        secret: entry.secret,
        testUrl: TEST_URL,
        timeoutMs: TIMEOUT_MS,
        preferred: ENGINE,
      });
      outcomes[index] = outcomeOf(entry, result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return { label, wallMs: Date.now() - started, spawns: entries.length, outcomes };
}

/** Several nodes per core: the production bulk path. */
async function batchedRun(label: string, entries: readonly ProbeEntry[]): Promise<ModeRun> {
  const started = Date.now();
  const results = await proxyProbeManyWithEngine(
    entries.map((entry) => ({ config: entry.config, secret: entry.secret })),
    { testUrl: TEST_URL, timeoutMs: TIMEOUT_MS, preferred: ENGINE },
  );
  const wallMs = Date.now() - started;
  const outcomes = entries.map((entry, i) => {
    const result = results[i];
    // A null here would mean the run stopped before that node's group started
    // (cancellation); this benchmark never cancels, so it is reported as such
    // rather than silently counted as a failure.
    if (!result) {
      return { id: entry.id, ok: false, latencyMs: null, engine: null, error: 'not probed (batch stopped)' };
    }
    return outcomeOf(entry, result);
  });
  // The runner's own packing rule, so the spawn count in the report is the
  // real one: one shared core per BULK_NODES_PER_CORE shareable node, plus one
  // core for each node it must probe alone (a node whose credential is missing
  // cannot share a core — see the grouping rule in proxyEngineRunner.ts).
  const shareable = entries.filter((entry) => entry.secret).length;
  const spawns = Math.ceil(shareable / BULK_NODES_PER_CORE) + (entries.length - shareable);
  return { label, wallMs, spawns, outcomes };
}

/* -------------------------------- report --------------------------------- */

const pad = (value: string, width: number): string => (value.length >= width ? value : value + ' '.repeat(width - value.length));

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

function counts(run: ModeRun): { ok: number; failed: number } {
  const ok = run.outcomes.filter((o) => o.ok).length;
  return { ok, failed: run.outcomes.length - ok };
}

function describe(run: ModeRun): string {
  const { ok, failed } = counts(run);
  return `${pad(`${run.wallMs}ms`, 10)} ${pad(`${run.spawns} spawn${run.spawns === 1 ? '' : 's'}`, 12)} ${ok} ok / ${failed} failed`;
}

/* --------------------------------- main ---------------------------------- */

async function main(): Promise<void> {
  const dataDir = path.resolve(
    process.env['DATA_DIR'] ?? process.env['NETPULSE_DATA_DIR'] ?? defaultDataDir(),
  );
  // The locator and the installer must agree with the node source: with
  // NETPULSE_DATA_DIR set, findEngineBinary searches <dataDir>/cores and
  // installEngine writes there, exactly as the app resolves them.
  if (!process.env['NETPULSE_DATA_DIR']) process.env['NETPULSE_DATA_DIR'] = dataDir;

  const sample = NODES_FILE ? loadFromFile(NODES_FILE, SAMPLE_SIZE) : loadFromApp(dataDir, SAMPLE_SIZE);
  if (sample.entries.length < 2) {
    fail(`need at least 2 real nodes to compare a batch against, found ${sample.entries.length}`);
  }
  const withSecret = sample.entries.filter((entry) => entry.secret).length;
  if (withSecret === 0) {
    fail(
      `none of the ${sample.entries.length} sampled nodes has a credential (${sample.source}); proxy probes cannot carry traffic and the numbers would only measure failures`,
    );
  }

  const core = await ensureCore();

  const protocols = new Map<string, number>();
  for (const entry of sample.entries) protocols.set(entry.protocol, (protocols.get(entry.protocol) ?? 0) + 1);
  const protocolMix = [...protocols.entries()].map(([p, n]) => `${p}×${n}`).join(' ');

  process.stdout.write(`\nbulk probe benchmark · ${process.platform} · ${ROUNDS} round${ROUNDS === 1 ? '' : 's'}\n`);
  process.stdout.write(`  nodes         ${sample.entries.length}${sample.total != null ? ` of ${sample.total}` : ''} (${protocolMix}) · ${withSecret} with a credential${sample.provenBefore > 0 ? ` · ${sample.provenBefore} previously carried a proxy test` : ''}${sample.skipped > 0 ? ` · ${sample.skipped} unparsable line(s) skipped` : ''}\n`);
  process.stdout.write(`  source        ${sample.source}\n`);
  process.stdout.write(`  core          ${core.id} ${core.version ?? '(version unknown)'} — ${core.bin}\n`);
  if (core.install) {
    process.stdout.write(`                installed from the official release (${core.install.status}, checksum verified: ${core.install.checksumVerified}, ${core.install.tookMs}ms)\n`);
  }
  process.stdout.write(`  endpoint      ${TEST_URL}\n`);
  process.stdout.write(
    `  modes         per-node ${CONCURRENCY === 1 ? 'sequential' : `×${CONCURRENCY} concurrent`}, batched (${BULK_NODES_PER_CORE} nodes/core, ≤${BULK_CORES_IN_FLIGHT} cores in flight)\n`,
  );

  const perNodeLabel = CONCURRENCY === 1 ? 'per-node, sequential' : `per-node, ×${CONCURRENCY} concurrent`;
  const concurrent: number[] = [];
  const batched: number[] = [];
  let lastBatched: ModeRun | null = null;
  let lastConcurrent: ModeRun | null = null;

  for (let round = 1; round <= ROUNDS; round += 1) {
    process.stdout.write(`\n── round ${round} ─────────────────────────────────────────────────────────────\n`);
    const oneAtATime = await perNodeRun(perNodeLabel, sample.entries, CONCURRENCY);
    process.stdout.write(`  ${pad(oneAtATime.label, 26)}${describe(oneAtATime)}\n`);
    concurrent.push(oneAtATime.wallMs);
    lastConcurrent = oneAtATime;

    const shared = await batchedRun('batched, shared cores', sample.entries);
    process.stdout.write(`  ${pad(shared.label, 26)}${describe(shared)}\n`);
    batched.push(shared.wallMs);
    lastBatched = shared;
  }

  const p50Concurrent = median(concurrent);
  const p50Batched = median(batched);

  process.stdout.write(`\n── summary (${ROUNDS} round${ROUNDS === 1 ? '' : 's'}, median wall time) ───────────────────────────────\n`);
  process.stdout.write(`  ${pad(perNodeLabel, 26)}${pad(`${p50Concurrent}ms`, 10)} ${sample.entries.length} core spawns + teardowns, ≤${CONCURRENCY} in flight\n`);
  process.stdout.write(`  ${pad('batched, shared cores', 26)}${pad(`${p50Batched}ms`, 10)} ~${lastBatched?.spawns ?? 0} core spawns, ≤${BULK_CORES_IN_FLIGHT} in flight\n`);
  process.stdout.write(`\n  speedup: ${(p50Concurrent / p50Batched).toFixed(2)}× (this compares wall time only — the two modes carry the same nodes)\n`);

  if (lastBatched) {
    process.stdout.write(`\n── per-node result (batched round) ──────────────────────────────────────────\n`);
    sample.entries.forEach((entry, i) => {
      const outcome = lastBatched!.outcomes[i]!;
      const detail = outcome.ok
        ? `${outcome.latencyMs ?? '?'}ms via ${outcome.engine ?? '?'}`
        : `failed: ${outcome.error ?? 'unknown'}`;
      process.stdout.write(`  ${pad(entry.protocol, 12)}${pad(entry.label, 36)}${detail.slice(0, 70)}\n`);
    });
  }

  if (lastBatched && lastConcurrent) {
    const perNode = new Map(lastConcurrent.outcomes.map((o) => [o.id, o]));
    const onlyBatched = lastBatched.outcomes.filter((o) => o.ok && !perNode.get(o.id)?.ok).length;
    const onlyPerNode = lastBatched.outcomes.filter((o) => !o.ok && perNode.get(o.id)?.ok).length;
    const neither = lastBatched.outcomes.filter((o) => !o.ok && !perNode.get(o.id)?.ok).length;
    const okBatched = counts(lastBatched).ok;
    process.stdout.write(`\n── the two modes agree? ─────────────────────────────────────────────────────\n`);
    process.stdout.write(`  carried traffic in both:      ${okBatched - onlyBatched} of ${lastBatched.outcomes.length}\n`);
    process.stdout.write(`  only batched succeeded:       ${onlyBatched}   (identical nodes + credentials, so a non-zero count is run-to-run flakiness)\n`);
    process.stdout.write(`  only per-node succeeded:      ${onlyPerNode}\n`);
    process.stdout.write(`  failed in both:               ${neither}   (unusable node, or no credential the core can present)\n`);
    if (okBatched === 0) {
      process.stdout.write(
        `\n  CAVEAT: not one sampled node carried traffic, so these timings measure spawn + timeout cost, not probe latency.\n`,
      );
    }
  }
  process.stdout.write('\n');
}

void main().catch((err: unknown) => {
  process.stderr.write(`\nbench-bulk-probe failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
