/**
 * Baseline vs adaptive: a counterfactual replay over REAL outcomes.
 *
 * The question this answers is the only one that matters for the feature: does
 * the adaptive order reach a working core at least as reliably, and no slower,
 * than the fixed engine order — measured with the SHIPPED policy
 * (`rankStrategies` / `applyObservation` from `@netpulse/shared`), not a
 * re-implementation of it.
 *
 * Two sources of outcomes:
 *
 *   SOURCE=live (default)  measure a real corpus first: run the app's own proxy
 *                          probe (`proxyProbeWithEngine`) against a sample of
 *                          real nodes from the app database, once per installed
 *                          core, sequentially and bounded. Real cores, real
 *                          credentials from the app vault, a real HTTPS request
 *                          through each node. This is the honest way to get
 *                          per-engine outcomes, because the app's own node tests
 *                          almost never record more than one engine per node.
 *   SOURCE=db              replay what the app already recorded: `node_tests`
 *                          rows that carry an engine (real history, no new
 *                          network traffic). Usually far too few rows — which is
 *                          itself a result and is reported as such.
 *
 * Replay protocol (identical for both sources):
 *
 *  • Attempts are grouped into EPISODES per node: consecutive tests of one node,
 *    a new episode after a gap longer than EPISODE_GAP_MS (5 min). One episode is
 *    one "find a core that works for this node" search, which is what quick
 *    connect does.
 *  • Both policies get the same budget (ATTEMPTS=2, the app's real
 *    MAX_ENGINE_ATTEMPTS_PER_NODE) and the same recorded outcomes.
 *  • Baseline picks engines in the fixed order (PROXY_ENGINE_ORDER).
 *  • Adaptive picks from the real ranked decisions, rebuilt WALK-FORWARD: it only
 *    ever sees outcomes from episodes that came before the one being scored, so
 *    there is no look-ahead. Its own tried outcomes are what update the state.
 *  • An episode is COMPARABLE only when the corpus holds an outcome for the
 *    engine a policy wants to try. A counterfactual cannot invent a measurement:
 *    episodes needing an unrecorded (node, engine) pair are excluded and counted.
 *
 * What this is NOT: a network simulation. Each outcome is a single recorded
 * observation, so run-to-run flakiness, time of day and a changing local network
 * are not reproduced. Small n is reported as small n; no speedup is claimed from
 * a corpus that cannot support it.
 *
 *   npx tsx scripts/bench-adaptive-replay.ts                       # live corpus, 6 nodes
 *   SOURCE=db npx tsx scripts/bench-adaptive-replay.ts             # replay recorded rows
 *   SOURCE=live LIVE_NODES=12 TIMEOUT_MS=8000 npx tsx scripts/bench-adaptive-replay.ts
 *   DATA_DIR=/path/to/app-data npx tsx scripts/bench-adaptive-replay.ts
 *
 * Knobs (env): SOURCE, LIVE_NODES, TIMEOUT_MS, TEST_URL, ATTEMPTS, EPISODE_GAP_MS,
 * DATA_DIR / NETPULSE_DATA_DIR, OUT (report path), ENGINES (comma list to force),
 * CORPUS_JSON (re-derive the report from a written evidence file, no new traffic).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { parseNodeUri } from '../apps/api/src/services/nodeParsers.ts';
import { probeConfigOf } from '../apps/api/src/services/nodeTestProbes.ts';
import { NodeSecretVault } from '../apps/api/src/services/nodeSecretVault.ts';
import { engineSupports, engineSupportsConfig, findEngineBinary, PROXY_ENGINE_ORDER } from '../apps/api/src/services/proxyCores.ts';
import { proxyProbeWithEngine } from '../apps/api/src/services/proxyEngineRunner.ts';
import {
  applyObservation,
  contextBucketOf,
  emptyAdaptiveState,
  rankStrategies,
  strategyIdFor,
  type AdaptiveState,
  type AdaptiveStrategy,
  type ParsedNodeConfig,
  type ProxyEngineId,
  type PublicNode,
} from '@netpulse/shared';

const APP_IDENTIFIER = 'app.netpulse.desktop';

const SOURCE = (process.env['SOURCE'] ?? 'live') as 'live' | 'db';
const LIVE_NODES = Math.max(2, Number(process.env['LIVE_NODES'] ?? 6));
const TIMEOUT_MS = Number(process.env['TIMEOUT_MS'] ?? 8_000);
/** The app's own fallback probe target (`resolveTestEndpoint`'s default). */
const TEST_URL = process.env['TEST_URL'] ?? 'https://httpbin.org/ip';
const ATTEMPTS = Math.max(1, Number(process.env['ATTEMPTS'] ?? 2));
const EPISODE_GAP_MS = Math.max(60_000, Number(process.env['EPISODE_GAP_MS'] ?? 5 * 60_000));
const CORPUS_JSON = process.env['CORPUS_JSON'] ?? null;
const ENGINES = (process.env['ENGINES'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is ProxyEngineId => s.length > 0) as ProxyEngineId[];

function defaultDataDir(): string {
  if (process.platform === 'win32') return path.join(process.env['APPDATA'] ?? os.homedir(), APP_IDENTIFIER);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', APP_IDENTIFIER);
  return path.join(process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'), APP_IDENTIFIER);
}

function fail(message: string): never {
  process.stderr.write(`\nbench-adaptive-replay: ${message}\n`);
  process.exit(2);
}

/* ------------------------------ corpus rows ------------------------------- */

/** One recorded (or just measured) outcome: a node tried with one core. */
type Attempt = {
  nodeId: string;
  label: string;
  protocol: string;
  engine: ProxyEngineId;
  ok: boolean;
  totalMs: number;
  error: string | null;
  at: number;
};

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
};

const NODE_COLUMNS = `id, protocol, host, port, transport, security, sni, alpn, fingerprint, flow,
                      alter_id, path, host_header, service_name, allow_insecure, reality_public_key,
                      reality_short_id, reality_server_name, encryption, ssr_protocol, remark`;

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Raw DB row → the node shape the probe path reads. */
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

/* --------------------------- node sample (shared) ------------------------- */

type SampleEntry = { node: PublicNode; config: ParsedNodeConfig; secret: string | null; label: string; protocol: string };

/**
 * Share links, one per line, parsed by the app's own URI parsers (secrets come
 * from the link itself). This is how a POSITIVE CONTROL corpus is built: your
 * own server, dialled by the real cores, without putting it in the app's
 * database — the sample the DB offers today carries no traffic at all, and an
 * all-failure corpus can never show what adaptation is for.
 */
function loadFromFile(file: string, limit: number): { entries: SampleEntry[]; total: number } {
  if (!fs.existsSync(file)) fail(`NODES_FILE=${file} does not exist`);
  const lines = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  const entries: SampleEntry[] = [];
  let skipped = 0;
  for (const line of lines.slice(0, limit)) {
    const parsed = parseNodeUri(line);
    if (!parsed.result) {
      skipped += 1;
      continue;
    }
    const config = parsed.result.config;
    entries.push({
      node: { id: `file:${entries.length}`, protocol: parsed.protocol, host: config.host, port: config.port } as unknown as PublicNode,
      config,
      secret: (parsed.result as { secret?: string | null }).secret ?? null,
      label: labelOf(config, `line ${entries.length + 1} (${parsed.protocol})`),
      protocol: config.protocol,
    });
  }
  if (skipped > 0) process.stdout.write(`  ${skipped} unparsable line(s) skipped\n`);
  return { entries, total: lines.length };
}

function loadNodes(dataDir: string, limit: number): { entries: SampleEntry[]; total: number } {
  const dbPath = path.join(dataDir, 'netpulse.db');
  if (!fs.existsSync(dbPath)) fail(`no app database at ${dbPath} — pass DATA_DIR=<app data dir>`);
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const total = (sqlite.prepare('SELECT COUNT(*) AS n FROM public_nodes').get() as { n: number }).n;
    const rows = sqlite
      .prepare(`SELECT ${NODE_COLUMNS} FROM public_nodes ORDER BY (last_proxy_ms IS NOT NULL) DESC, score DESC LIMIT ?`)
      .all(Math.max(limit * 6, limit)) as RawRow[];

    const vault = new NodeSecretVault(path.join(dataDir, 'secrets', 'vault'));
    // A probe without a credential can only fail, so credentialed nodes are what
    // the live corpus is built from. One per protocol, so the sample is not all
    // vless by accident.
    const withSecret: SampleEntry[] = [];
    const without: SampleEntry[] = [];
    for (const row of rows) {
      const node = toNode(row);
      const config = probeConfigOf(node);
      const entry: SampleEntry = {
        node,
        config,
        secret: vault.get(node.id),
        label: labelOf(config, `${node.host}:${node.port}`),
        protocol: node.protocol,
      };
      (entry.secret ? withSecret : without).push(entry);
    }

    const byProtocol = new Map<string, SampleEntry[]>();
    for (const entry of withSecret) {
      const list = byProtocol.get(entry.protocol) ?? [];
      list.push(entry);
      byProtocol.set(entry.protocol, list);
    }
    const picked: SampleEntry[] = [];
    while (picked.length < Math.min(limit, withSecret.length)) {
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
    return { entries: picked, total };
  } finally {
    sqlite.close();
  }
}

/* ------------------------------- live corpus ------------------------------ */

/** Cores this machine has, restricted to what the node can actually dial. */
function enginesFor(config: ParsedNodeConfig): ProxyEngineId[] {
  const installed = ENGINES.length > 0 ? ENGINES : PROXY_ENGINE_ORDER.filter((id) => findEngineBinary(id) !== null);
  return installed.filter((id) => engineSupports(id, config.protocol) && engineSupportsConfig(id, config).ok);
}

async function measureLive(dataDir: string): Promise<{ attempts: Attempt[]; installed: ProxyEngineId[]; skipped: number }> {
  const nodesFile = process.env['NODES_FILE'] ?? null;
  const { entries, total } = nodesFile ? loadFromFile(nodesFile, LIVE_NODES) : loadNodes(dataDir, LIVE_NODES);
  if (entries.length === 0) {
    fail(`no node with a vaulted credential in ${dataDir} — a live corpus needs nodes whose secret the core can present`);
  }
  const installed = (ENGINES.length > 0 ? ENGINES : PROXY_ENGINE_ORDER.filter((id) => findEngineBinary(id) !== null)).filter(
    (id) => findEngineBinary(id) !== null,
  );
  if (installed.length === 0) fail('no local core is installed, so no per-engine outcome can be measured');

  process.stdout.write(`\nlive corpus · ${entries.length} of ${total} nodes · cores ${installed.join(', ')}\n`);
  process.stdout.write(`  endpoint ${TEST_URL} · timeout ${TIMEOUT_MS}ms · one attempt per (node, core), sequential\n\n`);

  const attempts: Attempt[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const cores = enginesFor(entry.config);
    if (cores.length === 0) {
      skipped += 1;
      process.stdout.write(`  skip ${entry.label} (${entry.protocol}) — no installed core can dial it\n`);
      continue;
    }
    for (const engine of cores) {
      const started = Date.now();
      const result = await proxyProbeWithEngine(entry.config, {
        secret: entry.secret,
        testUrl: TEST_URL,
        timeoutMs: TIMEOUT_MS,
        preferred: engine,
      });
      attempts.push({
        nodeId: entry.node.id,
        label: entry.label,
        protocol: entry.protocol,
        engine: (result.engine ?? engine) as ProxyEngineId,
        ok: result.status === 'done',
        totalMs: result.totalMs ?? Date.now() - started,
        error: result.error,
        at: started,
      });
      const outcome = result.status === 'done' ? `ok ${Math.round(result.totalMs ?? 0)}ms` : `failed: ${(result.error ?? 'unknown').slice(0, 46)}`;
      process.stdout.write(`  ${engine.padEnd(9)}${entry.label.padEnd(36)}${outcome}\n`);
    }
  }
  return { attempts, installed, skipped };
}

/* --------------------------------- replay --------------------------------- */

type Episode = { nodeId: string; label: string; protocol: string; at: number; outcomes: Map<ProxyEngineId, Attempt> };

function episodesOf(attempts: readonly Attempt[]): Episode[] {
  const byNode = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const list = byNode.get(attempt.nodeId) ?? [];
    list.push(attempt);
    byNode.set(attempt.nodeId, list);
  }

  const episodes: Episode[] = [];
  for (const list of byNode.values()) {
    list.sort((a, b) => a.at - b.at);
    let current: Episode | null = null;
    for (const attempt of list) {
      if (!current || attempt.at - current.at > EPISODE_GAP_MS) {
        current = { nodeId: attempt.nodeId, label: attempt.label, protocol: attempt.protocol, at: attempt.at, outcomes: new Map() };
        episodes.push(current);
      }
      // The first recorded outcome for a (node, core) pair in this episode wins;
      // a repeat would be the same measurement taken twice.
      if (!current.outcomes.has(attempt.engine)) current.outcomes.set(attempt.engine, attempt);
    }
  }
  return episodes.sort((a, b) => a.at - b.at);
}

type EpisodeResult = {
  tried: ProxyEngineId[];
  ok: boolean;
  attemptsUsed: number;
  msToWorking: number | null;
  firstChoiceOk: boolean;
  wasted: number;
};

/**
 * Run one policy over one episode.
 *
 * `order` is the engine preference (baseline: fixed; adaptive: the ranked
 * decisions). `wastedFor(nodeId, engine)` reports whether this core NEVER worked
 * for this node anywhere in the corpus — the definition of a wasted attempt. It
 * is a post-hoc measure of effort spent on a core that cannot work here, so it is
 * deliberately not something a policy could have known in advance.
 *
 * Comparability rule: the episode is scored only when the policy's FIRST choice
 * has a recorded outcome, because that is the decision being evaluated. A later
 * choice the corpus never measured is skipped (the app would have tried it; we
 * simply have no measurement), and the skip is counted — a counterfactual replay
 * must never invent an outcome, and must not silently pretend a policy chose a
 * core it did not.
 */
function runPolicy(
  order: readonly ProxyEngineId[],
  episode: Episode,
  wastedFor: (nodeId: string, engine: ProxyEngineId) => boolean,
): EpisodeResult | null {
  const first = order[0];
  if (!first || !episode.outcomes.has(first)) return null;

  const tried: ProxyEngineId[] = [];
  let ms = 0;
  let wasted = 0;
  for (const engine of order) {
    const outcome = episode.outcomes.get(engine);
    if (!outcome) continue;
    tried.push(engine);
    ms += outcome.totalMs;
    if (wastedFor(episode.nodeId, engine)) wasted += 1;
    if (outcome.ok) {
      return { tried, ok: true, attemptsUsed: tried.length, msToWorking: ms, firstChoiceOk: tried.length === 1, wasted };
    }
    if (tried.length >= ATTEMPTS) break;
  }
  return { tried, ok: false, attemptsUsed: tried.length, msToWorking: null, firstChoiceOk: false, wasted };
}

const engineOfStrategy = (strategyId: string): ProxyEngineId => strategyId.split('+')[0] as ProxyEngineId;

function replay(attempts: readonly Attempt[]) {
  const episodes = episodesOf(attempts);
  const successes = new Set<string>(); // `${nodeId}|${engine}` seen working BEFORE this point


  // A (node, core) pair with no success anywhere in the corpus: an attempt on it
  // is effort the corpus proves cannot pay off.
  const everWorked = new Set<string>();
  for (const attempt of attempts) if (attempt.ok) everWorked.add(`${attempt.nodeId}|${attempt.engine}`);
  const wastedFor = (nodeId: string, engine: ProxyEngineId): boolean => !everWorked.has(`${nodeId}|${engine}`);

  let state: AdaptiveState = emptyAdaptiveState(Date.now());
  const baseline: EpisodeResult[] = [];
  const adaptive: EpisodeResult[] = [];
  const comparableEpisodes: Episode[] = [];
  let excluded = 0;

  for (const episode of episodes) {
    const rel = Math.max(0, episode.at - episodes[0]!.at);
    const now = episodes[0]!.at + rel;
    // The two policies must choose from the SAME set of cores, or the comparison
    // measures compatibility rather than order. That set is what the app itself
    // can dial for this node — the corpus's engines, which `enginesFor` already
    // filtered with the app's own `engineSupports` / `engineSupportsConfig`
    // predicates (installed ∧ protocol ∧ cipher). The baseline is the app's fixed
    // preference order over that set; the adaptive policy is the same set ranked by
    // evidence. What differs between them is ONLY the order.
    const dialable = new Set(episode.outcomes.keys());
    const baselineOrder = PROXY_ENGINE_ORDER.filter((engine) => dialable.has(engine));
    const base = runPolicy(baselineOrder, episode, wastedFor);
    // Adaptive: the real ranked decisions for this context, from prior evidence
    // only. The strategy list is the installed set restricted to what really has
    // an outcome in this corpus (a replay has no other candidates).
    const strategies: AdaptiveStrategy[] = [...episode.outcomes.keys()].map((engine) => ({
      id: strategyIdFor(engine, true),
      engine,
      dnsThroughTunnel: true,
      label: engine,
    }));
    const context = contextBucketOf({
      dnsFailing: false,
      tlsFailing: false,
      relayWorked: [...successes].some((k) => k.startsWith(`${episode.nodeId}|`)),
      ipv6: false,
      profile: 'balanced',
    });
    const decisions = rankStrategies({
      state,
      context,
      strategies,
      baselineOrder: strategies.map((s) => s.id),
      now,
      options: { explorationShare: 0 },
      attemptBudget: ATTEMPTS,
    });
    const adaptiveOrder = decisions.map((d) => engineOfStrategy(d.strategyId));
    const adapted = runPolicy(adaptiveOrder, episode, wastedFor);

    if (!base || !adapted) {
      excluded += 1;
    } else {
      baseline.push(base);
      adaptive.push(adapted);
      comparableEpisodes.push(episode);
    }

    // Both policies' tried outcomes update the shared walk-forward history (what
    // "really happened" in this corpus), and the ADAPTIVE policy's own tried
    // outcomes update the learned state — the baseline does not learn.
    for (const outcome of episode.outcomes.values()) {
      if (outcome.ok) successes.add(`${outcome.nodeId}|${outcome.engine}`);
    }
    for (const engine of adapted?.tried ?? []) {
      const outcome = episode.outcomes.get(engine)!;
      state = applyObservation(
        state,
        {
          at: now,
          context,
          strategyId: strategyIdFor(engine, true),
          ok: outcome.ok,
          timeToWorkingMs: outcome.ok ? outcome.totalMs : null,
          failureKind: outcome.ok ? null : 'not-verified',
          reasonCode: outcome.ok ? null : 'traffic-not-verified',
        },
        { explorationShare: 0 },
      );
    }
  }

  return { baseline, adaptive, comparable: comparableEpisodes.length, excluded, episodes: episodes.length };
}

/* -------------------------------- statistics ------------------------------ */

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)]!);
}

function summarize(rows: readonly EpisodeResult[]) {
  const n = rows.length;
  const ok = rows.filter((r) => r.ok).length;
  const firstChoice = rows.filter((r) => r.firstChoiceOk).length;
  const attempts = rows.reduce((sum, r) => sum + r.attemptsUsed, 0);
  const wasted = rows.reduce((sum, r) => sum + r.wasted, 0);
  const ms = rows.filter((r) => r.msToWorking != null).map((r) => r.msToWorking!);
  return {
    episodes: n,
    succeeded: ok,
    successRate: pct(ok, n),
    firstChoiceOk: firstChoice,
    firstChoiceRate: pct(firstChoice, n),
    meanAttempts: n === 0 ? null : Math.round((attempts / n) * 100) / 100,
    p50MsToWorking: percentile(ms, 50),
    p95MsToWorking: percentile(ms, 95),
    wastedAttempts: wasted,
  };
}

/* --------------------------------- main ---------------------------------- */

async function main(): Promise<void> {
  const dataDir = path.resolve(process.env['DATA_DIR'] ?? process.env['NETPULSE_DATA_DIR'] ?? defaultDataDir());
  if (!process.env['NETPULSE_DATA_DIR']) process.env['NETPULSE_DATA_DIR'] = dataDir;

  let attempts: Attempt[] = [];
  let corpus: string;
  let live: { installed: ProxyEngineId[]; skipped: number } | null = null;

  if (SOURCE === 'live' && CORPUS_JSON) {
    // Re-derive the report from an evidence file a live run already wrote — the
    // same recorded outcomes, no new traffic. This exists because the metrics and
    // the verdict are code, and a reporting change should not require re-probing
    // the network (or restating numbers by hand).
    const saved = JSON.parse(fs.readFileSync(CORPUS_JSON, 'utf8')) as { rows?: Array<Record<string, unknown>> };
    const rows = saved.rows ?? [];
    if (rows.length === 0) fail(`${CORPUS_JSON} holds no rows to replay`);
    attempts = rows.map((row, index) => {
      const nodeId = typeof row['nodeId'] === 'string' ? row['nodeId'] : null;
      const at = typeof row['at'] === 'number' ? row['at'] : null;
      const label = typeof row['node'] === 'string' ? row['node'] : nodeId;
      if (nodeId == null || at == null || label == null) {
        fail(`${CORPUS_JSON} row ${index} has no nodeId/at — it predates those fields; re-run with SOURCE=live against the corpus`);
      }
      return {
        nodeId,
        label,
        protocol: typeof row['protocol'] === 'string' ? row['protocol'] : '',
        engine: row['engine'] as ProxyEngineId,
        ok: row['ok'] === true,
        totalMs: typeof row['totalMs'] === 'number' ? row['totalMs'] : 0,
        error: typeof row['error'] === 'string' ? row['error'] : null,
        at,
      };
    });
    corpus = `recorded outcomes replayed from ${CORPUS_JSON} (no new traffic)`;
  } else if (SOURCE === 'live') {
    const measured = await measureLive(dataDir);
    attempts = measured.attempts;
    live = { installed: measured.installed, skipped: measured.skipped };
    corpus = process.env['NODES_FILE']
      ? `live measurement through the app's own proxy probe over ${process.env['NODES_FILE']} (${measured.installed.join(', ')})`
      : `live measurement through the app's own proxy probe (${measured.installed.join(', ')})`;
  } else {
    const dbPath = path.join(dataDir, 'netpulse.db');
    const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = sqlite
        .prepare(
          `SELECT t.node_id AS nodeId, t.engine AS engine, t.status AS status, t.total_ms AS totalMs, t.error AS error,
                  t.started_at AS at, n.protocol AS protocol, n.remark AS remark
           FROM node_tests t JOIN public_nodes n ON n.id = t.node_id
           WHERE t.engine IS NOT NULL AND t.type = 'proxy' AND t.started_at IS NOT NULL
           ORDER BY t.started_at ASC`,
        )
        .all() as Array<{ nodeId: string; engine: string; status: string; totalMs: number | null; error: string | null; at: number; protocol: string; remark: string | null }>;
      attempts = rows.map((row) => ({
        nodeId: row.nodeId,
        label: (row.remark ?? row.nodeId).slice(0, 34),
        protocol: row.protocol,
        engine: row.engine as ProxyEngineId,
        ok: row.status === 'done',
        totalMs: row.totalMs ?? 0,
        error: row.error,
        at: row.at,
      }));
    } finally {
      sqlite.close();
    }
    corpus = `recorded node tests in ${dbPath}`;
  }

  process.stdout.write(`\nbaseline vs adaptive · replay of REAL outcomes\n`);
  process.stdout.write(`  corpus        ${corpus}\n`);
  process.stdout.write(`  attempts      ${attempts.length} recorded\n`);
  process.stdout.write(`  policies      fixed order (${PROXY_ENGINE_ORDER.join(' → ')}) vs ranked decisions, budget ${ATTEMPTS} attempt(s)\n\n`);

  if (attempts.length === 0) {
    process.stdout.write(`  ${SOURCE === 'db' ? 'BLOCKED' : 'NOT TESTED'}: no per-engine outcome is available, so nothing can be compared.\n`);
    process.stdout.write(`  Recorded node tests only carry an engine when the app's own probe picked one;\n`);
    process.stdout.write(`  run with SOURCE=live to measure a corpus through the real cores.\n\n`);
    process.exit(0);
  }

  const result = replay(attempts);
  const baseline = summarize(result.baseline);
  const adaptive = summarize(result.adaptive);

  const rows: Array<[string, string, string]> = [
    ['episodes compared', String(baseline.episodes), String(adaptive.episodes)],
    ['episodes excluded (no recorded outcome)', String(result.excluded), String(result.excluded)],
    ['reached a working core', baseline.successRate, adaptive.successRate],
    ['worked on the FIRST core tried', baseline.firstChoiceRate, adaptive.firstChoiceRate],
    ['mean attempts per episode', String(baseline.meanAttempts ?? 'n/a'), String(adaptive.meanAttempts ?? 'n/a')],
    ['p50 ms to a working core', String(baseline.p50MsToWorking ?? 'n/a'), String(adaptive.p50MsToWorking ?? 'n/a')],
    ['p95 ms to a working core', String(baseline.p95MsToWorking ?? 'n/a'), String(adaptive.p95MsToWorking ?? 'n/a')],
    ['attempts spent on a core that never worked', String(baseline.wastedAttempts), String(adaptive.wastedAttempts)],
  ];

  const width = Math.max(...rows.map(([label]) => label.length));
  process.stdout.write(`  ${'metric'.padEnd(width)}  ${'baseline'.padStart(10)}  ${'adaptive'.padStart(10)}\n`);
  process.stdout.write(`  ${'─'.repeat(width + 26)}\n`);
  for (const [label, base, ad] of rows) {
    process.stdout.write(`  ${label.padEnd(width)}  ${base.padStart(10)}  ${ad.padStart(10)}\n`);
  }

  const wins = result.adaptive.filter((a, i) => a.firstChoiceOk && !result.baseline[i]!.firstChoiceOk).length;
  const losses = result.adaptive.filter((a, i) => !a.firstChoiceOk && result.baseline[i]!.firstChoiceOk).length;
  const changed = result.adaptive.filter((a, i) => a.tried[0] !== result.baseline[i]!.tried[0]).length;
  const baselineFirstCounts = new Map<string, number>();
  for (const row of result.baseline) {
    const first = row.tried[0] ?? 'none';
    baselineFirstCounts.set(first, (baselineFirstCounts.get(first) ?? 0) + 1);
  }
  const baselineFirstSummary = [...baselineFirstCounts.entries()].map(([engine, count]) => engine + ' x' + count).join(' ');
  process.stdout.write('  baseline first core by episode: ' + baselineFirstSummary + '\n');
  process.stdout.write(`  first-core choice differed from baseline: ${changed} of ${result.baseline.length} episodes\n`);
  process.stdout.write(`  adaptive won the first attempt where baseline did not: ${wins}\n`);
  process.stdout.write(`  adaptive lost the first attempt where baseline won:  ${losses}\n`);

  // The verdict must describe the comparison, never one arm alone: an earlier
  // version keyed only on `baseline.succeeded === 0` and printed "no core reached
  // a working tunnel" while the adaptive arm had reached one on six episodes.
  const verdict =
    baseline.episodes < 10
      ? `NOT TESTED — ${baseline.episodes} comparable episode(s) is too small a sample to conclude anything about reliability or speed`
      : baseline.succeeded === 0 && adaptive.succeeded === 0
        ? 'MEASURED, NO SIGNAL — no core reached a working tunnel on any sampled episode under either policy; this corpus cannot show an advantage'
        : baseline.succeeded === 0 && adaptive.succeeded > 0
          ? `MEASURED, IMPROVEMENT on this corpus — the fixed order reached a working core on 0 of ${baseline.episodes} episodes; the adaptive order reached one on ${adaptive.succeeded} (${adaptive.successRate}), reached it on the first core tried in ${adaptive.firstChoiceOk} of ${adaptive.episodes} episodes, and lost ${losses} episode(s) the baseline won`
          : adaptive.succeeded >= baseline.succeeded && losses === 0 && (adaptive.p95MsToWorking ?? 0) <= (baseline.p95MsToWorking ?? 0)
            ? 'PASS on this corpus — adaptive reaches a working core at least as often, no slower at p95, and loses nothing the baseline won'
            : 'FAIL on this corpus — see the metrics above';
  process.stdout.write(`\n  verdict: ${verdict}\n`);
  process.stdout.write(`  caveat: a counterfactual replay scores recorded outcomes; it cannot reproduce the network,\n`);
  process.stdout.write(`          run-to-run flakiness, or what else was happening on this machine at the time.\n\n`);

  const out = process.env['OUT'] ?? path.join('reports', 'adaptive', `REPLAY_${SOURCE.toUpperCase()}.json`);
  const report = {
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    corpus,
    host: { platform: process.platform, node: process.version },
    live: live ? { installedCores: live.installed, skippedNodes: live.skipped, timeoutMs: TIMEOUT_MS, endpoint: TEST_URL } : null,
    attemptBudget: ATTEMPTS,
    attemptsRecorded: attempts.length,
    /**
     * Every recorded outcome, so the report can be audited without a rerun: the
     * node id and timestamp keep the episode structure (which node, in which
     * order, at what time) reproducible from the file alone.
     */
    rows: attempts.map((a) => ({
      node: a.label,
      nodeId: a.nodeId,
      protocol: a.protocol,
      engine: a.engine,
      ok: a.ok,
      totalMs: Math.round(a.totalMs),
      at: a.at,
      error: a.error,
    })),
    episodes: result.episodes,
    comparableEpisodes: result.comparable,
    excludedEpisodes: result.excluded,
    baseline,
    adaptive,
    firstChoiceDiffered: changed,
    adaptiveWins: wins,
    adaptiveLosses: losses,
    verdict,
    limitations: [
      'counterfactual replay over recorded outcomes; the network at the time is not reproduced',
      'an episode is excluded when a policy wants an (node, core) outcome the corpus does not hold',
      'accuracy of a probability from fewer than MIN_SAMPLES observations is not claimed by the engine itself',
      baseline.episodes < 10 ? `sample of ${baseline.episodes} comparable episodes is too small for a reliability claim` : null,
    ].filter(Boolean),
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`  evidence written to ${out}\n\n`);
}

void main().catch((err: unknown) => {
  process.stderr.write(`\nbench-adaptive-replay failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
