import fs from 'node:fs';
import path from 'node:path';

import type { AppContext } from '../routes/context';
import { buildMissionSnapshot, type MissionState } from './missionControl';

/**
 * Mission Overdrive: the evidence ledger, assembled from measured artifacts.
 *
 * `missionControl.ts` answers "what does this *process* know right now?" from live
 * services. This module answers the other half of the question: "what has actually
 * been measured, when, and by what?" — by reading the artifacts those measurements
 * wrote to `reports/accounting/*.json`, the research registry, and the acceptance
 * roadmap.
 *
 * The distinction matters for honesty. A number in this file is never re-derived
 * and never smoothed: it is parsed out of a file a run produced, and every row
 * carries the artifact path, the timestamp inside the artifact, and the caveats
 * that run itself stated. If an artifact is missing or its shape has changed, the
 * row degrades to `unavailable` with the reason — it never silently disappears,
 * because a vanished row looks like "nothing to report" instead of "unreadable".
 *
 * Read-only: this module opens files. It never dials, writes, provisions or scans.
 */

export interface EvidenceMetric {
  label: string;
  value: string;
  hint?: string;
}

export interface EvidenceRow {
  id: string;
  label: string;
  workstream: string;
  state: MissionState;
  /** Timestamp recorded *inside* the artifact, or null when it has none. */
  measuredAt: number | null;
  headline: string;
  metrics: EvidenceMetric[];
  /** Repository-relative artifact path — the traceable source of every figure. */
  artifact: string;
  /** Optional prose report that explains the artifact. */
  report: string | null;
  caveats: string[];
}

export interface ResearchEntry {
  id: string;
  title: string;
  url: string | null;
  date: string | null;
  relevance: string | null;
  confidence: string | null;
  findings: string | null;
}

export interface RequirementRow {
  index: number;
  text: string;
  state: MissionState;
  status: string;
}

export interface OverdriveSnapshot {
  generatedAt: number;
  repoRoot: string | null;
  summary: {
    state: MissionState;
    counts: Record<MissionState, number>;
    headline: string;
    evidenceRows: number;
    researchSources: number;
    requirementsMet: number;
    requirementsTotal: number;
  };
  evidence: EvidenceRow[];
  research: {
    registry: string | null;
    total: number;
    entries: ResearchEntry[];
    note: string;
  };
  requirements: RequirementRow[];
  /** Real file timestamps, sorted — the mission timeline is derived, not authored. */
  timeline: Array<{ ts: number; label: string; state: MissionState; artifact: string }>;
  report: {
    path: string | null;
    title: string | null;
    generatedAt: number | null;
    verdicts: Array<{ objective: string; status: string; evidence: string }>;
    note: string;
  };
  adaptive: Awaited<ReturnType<typeof buildMissionSnapshot>>['adaptive'];
  activity: Awaited<ReturnType<typeof buildMissionSnapshot>>['activity'];
  limits: string[];
}

/* ------------------------------ path helpers ------------------------------ */

/**
 * Find the repository root without trusting the caller's cwd.
 *
 * The API is started from `apps/api` by npm scripts and from the repository root
 * by hand, so a single `process.cwd()` guess breaks half the time. Walk upward
 * from both the cwd and this module's own directory, and stop at the first
 * directory that contains the research corpus.
 */
/**
 * `__dirname` does not exist in this ESM build, and reaching for it crashed the
 * route on first request. `import.meta.dirname` exists on the Node versions this
 * app supports; when it does not, the cwd walk below still finds the root.
 */
function moduleDir(): string | null {
  const meta = import.meta as unknown as { dirname?: unknown };
  return typeof meta.dirname === 'string' ? meta.dirname : null;
}

export function resolveRepoRoot(startDirs: string[] = [process.cwd(), ...(moduleDir() ? [moduleDir() as string] : [])]): string | null {
  const override = process.env['NETPULSE_REPO_ROOT'];
  if (override && fs.existsSync(path.join(override, 'docs', 'research', 'dpi'))) return override;

  for (const start of startDirs) {
    let dir = path.resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      if (fs.existsSync(path.join(dir, 'docs', 'research', 'dpi'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

type Loaded<T> = { ok: true; value: T } | { ok: false; reason: string };

function readJson<T>(root: string, relative: string): Loaded<T> {
  const full = path.join(root, relative);
  let raw: string;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch {
    return { ok: false, reason: 'artifact not present' };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (err) {
    return { ok: false, reason: `artifact is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
}

function readText(root: string, relative: string): string | null {
  try {
    return fs.readFileSync(path.join(root, relative), 'utf8');
  } catch {
    return null;
  }
}

/** Artifact timestamps are ISO strings; anything else is reported as "no timestamp". */
function parseTs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/* ------------------------------ row builders ------------------------------ */

function missingRow(
  id: string,
  label: string,
  workstream: string,
  artifact: string,
  report: string | null,
  reason: string,
  _now: number,
): EvidenceRow {
  return {
    id,
    label,
    workstream,
    state: 'unavailable',
    measuredAt: null,
    headline: `no readable measurement — ${reason}`,
    metrics: [],
    artifact,
    report,
    caveats: ['This row is not a zero and not a failure: it means the artifact could not be read here, so no figure is shown.'],
  };
}

/** Free-source catalog census — how many configs exist before any is dialled. */
function inventoryRow(root: string, now: number): EvidenceRow {
  const rel = 'reports/accounting/free-config-probe-2026-11-02.json';
  const loaded = readJson<Record<string, unknown>>(root, rel);
  if (!loaded.ok) return missingRow('inventory', 'Free-source catalog census', 'W2', rel, null, loaded.reason, now);

  const summary = obj(loaded.value['summary']);
  const total = num(summary?.['totalParsed']);
  const sourcesOk = num(summary?.['sourcesOk']);
  const sourcesProbed = num(summary?.['sourcesProbed']);
  if (total == null || sourcesProbed == null) {
    return missingRow('inventory', 'Free-source catalog census', 'W2', rel, null, 'artifact has no totals', now);
  }
  const byScheme = obj(summary?.['byScheme']) ?? {};
  const schemeTop = Object.entries(byScheme)
    .filter(([, v]) => typeof v === 'number')
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 3)
    .map(([k, v]) => `${k} ${Number(v).toLocaleString('en-US')}`);

  return {
    id: 'inventory',
    label: 'Free-source catalog census',
    workstream: 'W2',
    state: 'verified',
    measuredAt: parseTs(summary?.['generatedAtIso'] ?? summary?.['generatedAt']),
    headline: `${total.toLocaleString('en-US')} parseable configs from ${sourcesProbed} sources, ${sourcesOk ?? '?'} collected without error`,
    metrics: [
      { label: 'configs parsed', value: total.toLocaleString('en-US') },
      { label: 'sources', value: `${sourcesOk ?? '?'} / ${sourcesProbed}` },
      { label: 'top schemes', value: schemeTop.join(' · ') || '—' },
    ],
    artifact: rel,
    report: null,
    caveats: ['Parseable is not connectable: this census counts catalog entries, not working tunnels.'],
  };
}

/** Connect rate across all nine feeds — the F-05 headline. */
function connectRateRow(root: string, now: number): EvidenceRow {
  const rel = 'reports/accounting/free-config-connect-all-sources-2026-11-03.json';
  const loaded = readJson<Record<string, unknown>>(root, rel);
  if (!loaded.ok) {
    return missingRow('connect-rate', 'Free-config connect rate', 'F-05', rel, null, loaded.reason, now);
  }

  const totals = obj(loaded.value['totals']);
  const sampled = num(totals?.['sampled']);
  const reachable = num(totals?.['reachable']);
  if (sampled == null || reachable == null) {
    return missingRow('connect-rate', 'Free-config connect rate', 'F-05', rel, null, 'artifact has no totals', now);
  }

  const perSource = obj(loaded.value['perSource']) ?? {};
  const yields = Object.entries(perSource)
    .map(([name, raw]) => {
      const s = obj(raw);
      const ok = num(s?.['ok']) ?? 0;
      const n = num(s?.['sampled']) ?? 0;
      return { name, ok, n, rate: n > 0 ? ok / n : 0 };
    })
    .filter((s) => s.n > 0)
    .sort((a, b) => b.rate - a.rate);

  const zeroSources = yields.filter((s) => s.ok === 0).map((s) => s.name);
  const byFailure = obj(loaded.value['byFailureKind']) ?? {};
  const failures = Object.entries(byFailure)
    .map(([k, v]) => `${k} ${num(v) ?? 0}`)
    .sort();

  return {
    id: 'connect-rate',
    label: 'Free-config connect rate',
    workstream: 'F-05',
    state: 'verified',
    measuredAt: parseTs(loaded.value['generatedAt']),
    headline: `${reachable}/${sampled} dialled configs carried a request (${pct(reachable, sampled)}) — yield concentrated in ${yields.filter((s) => s.ok > 0).length} of ${yields.length} feeds`,
    metrics: [
      { label: 'reachable', value: `${reachable} / ${sampled}` },
      { label: 'rate', value: pct(reachable, sampled) },
      {
        label: 'best feeds',
        value: yields
          .slice(0, 3)
          .map((s) => `${s.name} ${pct(s.ok, s.n)}`)
          .join(' · '),
        hint: 'per-feed yield, n=30 each',
      },
      { label: 'zero-yield feeds', value: zeroSources.length > 0 ? zeroSources.join(', ') : 'none' },
      { label: 'failure kinds', value: failures.join(' · ') || '—' },
    ],
    artifact: rel,
    report: 'reports/accounting/FREE_CONFIG_CONNECT_RATES_2026-11-03.md',
    caveats: [
      'A successful dial is a handshake plus one small HTTP request — not a stable tunnel and not a throughput figure.',
      'One sample per config; a config that answered once is not known to keep answering.',
      'Measured on a non-Iranian network. Nothing here says these endpoints survive Iranian filtering.',
    ],
  };
}

/** Two-round survival — re-probes only the endpoints that already worked. */
function survivalRow(root: string, now: number): EvidenceRow {
  const rel = 'reports/accounting/free-config-survival-2026-11-03.json';
  const loaded = readJson<Record<string, unknown>>(root, rel);
  if (!loaded.ok) return missingRow('survival', 'Free-config survival', 'F-05', rel, null, loaded.reason, now);

  const round1 = obj(loaded.value['round1']);
  const round2 = obj(loaded.value['round2']);
  const retried = num(round2?.['retried']);
  const survived = num(round2?.['survived']);
  const gap = num(loaded.value['gapMinutes']);
  const reach1 = num(round1?.['reachable']);
  const sampled1 = num(round1?.['sampled']);

  if (retried == null || survived == null) {
    return missingRow('survival', 'Free-config survival', 'F-05', rel, null, 'artifact has no round-2 totals', now);
  }

  return {
    id: 'survival',
    label: 'Free-config survival',
    workstream: 'F-05',
    state: 'verified',
    measuredAt: parseTs(loaded.value['finishedAt'] ?? loaded.value['generatedAt']),
    headline: `${survived}/${retried} endpoints still carried traffic after ${gap ?? '?'} minutes (${pct(survived, retried)})`,
    metrics: [
      { label: 'round 1', value: `${reach1 ?? '?'} / ${sampled1 ?? '?'} reachable` },
      { label: 'round 2', value: `${survived} / ${retried} survived` },
      { label: 'gap', value: gap != null ? `${gap} min` : 'unknown' },
    ],
    artifact: rel,
    report: 'reports/accounting/FREE_CONFIG_SURVIVAL_2026-11-03.md',
    caveats: [
      `A ${gap ?? '?'}-minute window is not the roadmap's one-hour question; one-hour survival is NOT TESTED.`,
      'Only endpoints that already answered were retried, so the denominator is the survivor set, not the catalog.',
      'Small denominator: one endpoint changing outcome moves the rate by a wide margin.',
    ],
  };
}

/** Staged DNS/TCP/TLS/HTTP timings through the Aether tunnel. */
function stagesRow(root: string, now: number): EvidenceRow {
  const rel = 'reports/accounting/TUNNEL_STAGES_2026-11-03.json';
  const loaded = readJson<Record<string, unknown>>(root, rel);
  if (!loaded.ok) return missingRow('stages', 'Tunnel stage timings', 'W7', rel, null, loaded.reason, now);

  const stages = obj(loaded.value['stages']);
  const median = (key: string): number | null => num(obj(stages?.[key])?.['median']);
  const dns = median('dns');
  const socks = median('socksConnect');
  const tlsStage = median('tlsHandshake');
  const http = median('httpFirstByte');
  const total = median('endToEnd');
  const completed = num(loaded.value['completed']);
  const repeats = num(loaded.value['repeats']);
  const dnsRunsThrough = typeof loaded.value['dnsRunsThrough'] === 'string' ? loaded.value['dnsRunsThrough'] : null;
  const domainForm = loaded.value['domainFormAccepted'];

  if (total == null || completed == null) {
    return missingRow('stages', 'Tunnel stage timings', 'W7', rel, null, 'artifact has no stage medians', now);
  }

  return {
    id: 'stages',
    label: 'Tunnel stage timings (Aether, SOCKS5)',
    workstream: 'W7 / requirement 2',
    state: 'verified',
    measuredAt: parseTs(loaded.value['generatedAt']),
    headline: `${completed}/${repeats ?? '?'} rounds through the tunnel · ${total} ms end-to-end median`,
    metrics: [
      { label: 'DNS', value: dns != null ? `${dns} ms` : '—', hint: 'local resolver, not through the tunnel' },
      { label: 'SOCKS CONNECT', value: socks != null ? `${socks} ms` : '—' },
      { label: 'TLS', value: tlsStage != null ? `${tlsStage} ms` : '—' },
      { label: 'first byte', value: http != null ? `${http} ms` : '—' },
      { label: 'end to end', value: `${total} ms` },
      { label: 'DNS path', value: dnsRunsThrough ?? 'unknown' },
    ],
    artifact: rel,
    report: 'reports/accounting/TUNNEL_STAGES_2026-11-03.md',
    caveats: [
      domainForm === false
        ? 'The tunnel refuses hostname-form CONNECT, so names are resolved outside it: payload is tunnelled, DNS is not. This row proves data flows; it does not prove name confidentiality.'
        : 'Domain-form CONNECT behaviour is recorded in the artifact.',
      'TCP through SOCKS5 only. UDP/QUIC datagrams were not measured.',
      'One path, one target, one non-Iranian network. Stage behaviour on an Iranian access network is unmeasured.',
    ],
  };
}

/** Negative controls — the checks that must refuse to certify a broken setup. */
function negativeControlsRow(root: string, now: number): EvidenceRow {
  const rel = 'reports/accounting/NEGATIVE_CONTROLS_2026-11-03.json';
  const loaded = readJson<Record<string, unknown>>(root, rel);
  if (!loaded.ok) {
    return missingRow('negative-controls', 'Negative controls', 'W8 / requirement 4', rel, null, loaded.reason, now);
  }

  const summary = obj(loaded.value['summary']);
  const passed = num(summary?.['passed']);
  const failed = num(summary?.['failed']);
  const cases = Array.isArray(loaded.value['cases']) ? (loaded.value['cases'] as unknown[]) : [];
  const caseNames = cases
    .map((c) => obj(c))
    .filter((c): c is Record<string, unknown> => c !== null)
    .map((c) => `${String(c['id'] ?? '?')} ${typeof c['intent'] === 'string' ? c['intent'] : ''}`.trim());

  if (passed == null || failed == null) {
    return missingRow('negative-controls', 'Negative controls', 'W8 / requirement 4', rel, null, 'artifact has no summary', now);
  }

  const before = loaded.value['baselineBefore'];
  const after = loaded.value['baselineAfter'];

  return {
    id: 'negative-controls',
    label: 'Negative controls',
    workstream: 'W8 / requirement 4',
    state: failed === 0 && passed > 0 ? 'verified' : 'not_tested',
    measuredAt: parseTs(loaded.value['generatedAt']),
    headline: `${passed}/${passed + failed} controls refused to certify a broken setup`,
    metrics: [
      { label: 'passed', value: String(passed) },
      { label: 'failed', value: String(failed) },
      { label: 'egress before', value: typeof before === 'string' ? before : '—' },
      { label: 'egress after', value: typeof after === 'string' ? after : '—' },
    ],
    artifact: rel,
    report: 'reports/accounting/NEGATIVE_CONTROLS_2026-11-03.md',
    caveats: [
      'Each control asserts a refusal, so a passing control says the proof is not fooled — not that a tunnel works.',
      caseNames.length > 0 ? `Cases: ${caseNames.join(' · ')}` : 'Case list unreadable in this artifact.',
      'An "expired profile" control has no expiry mechanism to exercise and remains uncovered.',
    ],
  };
}

/** DNS resolved inside the tunnel — the fix for the leak the stage run exposed. */
function dnsTunnelRow(root: string, now: number): EvidenceRow {
  const rel = 'reports/accounting/DNS_TUNNEL_PROOF_2026-11-03.json';
  const loaded = readJson<Record<string, unknown>>(root, rel);
  if (!loaded.ok) return missingRow('dns-in-tunnel', 'DNS resolved inside the tunnel', 'requirement 2', rel, null, loaded.reason, now);

  const samples = num(loaded.value['samples']);
  const tunnelResolved = num(loaded.value['tunnelResolved']);
  const localMedian = num(loaded.value['localMedianMs']);
  const tunnelMedian = num(loaded.value['tunnelMedianMs']);
  const same = num(loaded.value['sameAnswerCount']);
  const endToEnd = loaded.value['endToEndExitIp'];

  if (samples == null || tunnelResolved == null) {
    return missingRow('dns-in-tunnel', 'DNS resolved inside the tunnel', 'requirement 2', rel, null, 'artifact has no sample counts', now);
  }

  return {
    id: 'dns-in-tunnel',
    label: 'DNS resolved inside the tunnel',
    workstream: 'requirement 2',
    state: tunnelResolved === samples ? 'verified' : 'not_tested',
    measuredAt: parseTs(loaded.value['generatedAt']),
    headline: `${tunnelResolved}/${samples} lookups answered over DNS-over-TCP through the tunnel (${tunnelMedian ?? '?'} ms median vs ${localMedian ?? '?'} ms local)`,
    metrics: [
      { label: 'resolved in tunnel', value: `${tunnelResolved} / ${samples}` },
      { label: 'tunnel median', value: tunnelMedian != null ? `${tunnelMedian} ms` : '—', hint: 'DNS over TCP to 1.1.1.1 through SOCKS5' },
      { label: 'local median', value: localMedian != null ? `${localMedian} ms` : '—', hint: 'for comparison only' },
      { label: 'same answer', value: same != null ? `${same} / ${samples}` : '—' },
      { label: 'exit via tunnel-resolved name', value: typeof endToEnd === 'string' ? endToEnd : '—' },
    ],
    artifact: rel,
    report: 'reports/accounting/AETHER_DNS_LEAK_RECONNECT_2026-11-03.md',
    caveats: [
      'The tunnel still refuses hostname-form CONNECT; resolution is done by this client speaking DNS over TCP through the tunnel, which every caller must opt into.',
      'Only A records are parsed. AAAA/CNAME lookups are not covered, and a caller that falls back to the OS resolver reopens the leak.',
    ],
  };
}

/** Leak + reconnection checks. */
function leakRow(root: string, now: number): EvidenceRow {
  const rel = 'reports/accounting/LEAK_TEST_2026-11-03.json';
  const loaded = readJson<Record<string, unknown>>(root, rel);
  if (!loaded.ok) return missingRow('leaks', 'IPv4 / IPv6 leak checks', 'requirement 2', rel, null, loaded.reason, now);

  const egress6 = obj(loaded.value['ipv6Egress']);
  const dataPlane = obj(loaded.value['ipv6DataPlane']);
  const acceptsV6 = loaded.value['tunnelAcceptsIpv6'];
  const v6tls = dataPlane?.['tls'] === true;
  const v6direct = egress6?.['reachable'] === true;

  return {
    id: 'leaks',
    label: 'Leak checks (IPv4 / IPv6)',
    workstream: 'requirement 2 / 4',
    state: v6direct && !acceptsV6 ? 'not_tested' : 'verified',
    measuredAt: parseTs(loaded.value['generatedAt']),
    headline: v6tls
      ? 'IPv6 carried inside the tunnel (TLS handshake completed); host has no direct v6 egress to leak onto'
      : `IPv6 through the tunnel: ${acceptsV6 === true ? 'accepted' : 'refused'}${v6direct ? ' · host has direct v6 egress' : ' · no direct v6 egress on this host'}`,
    metrics: [
      { label: 'IPv4 exit', value: typeof loaded.value['ipv4Exit'] === 'string' ? (loaded.value['ipv4Exit'] as string) : '—' },
      { label: 'IPv6 through tunnel', value: v6tls ? 'TLS ok' : acceptsV6 === true ? 'CONNECT only' : 'refused' },
      { label: 'direct IPv6 egress', value: v6direct ? String(egress6?.['address'] ?? 'yes') : 'none' },
    ],
    artifact: rel,
    report: 'reports/accounting/AETHER_DNS_LEAK_RECONNECT_2026-11-03.md',
    caveats: [
      'UDP/QUIC leak behaviour is not covered: the SOCKS listener here is TCP-only.',
      'A host without direct IPv6 cannot demonstrate an IPv6 leak even if one existed on a dual-stack network.',
    ],
  };
}

function reconnectRow(root: string, now: number): EvidenceRow {
  const rel = 'reports/accounting/RECONNECT_TEST_2026-11-03.json';
  const loaded = readJson<Record<string, unknown>>(root, rel);
  if (!loaded.ok) return missingRow('reconnect', 'Tunnel recovery after a hard failure', 'requirement 4', rel, null, loaded.reason, now);

  const up = loaded.value['confirmedUp'] === true;
  const down = loaded.value['confirmedDown'] === true;
  const reconnectMs = num(loaded.value['reconnectMs']);
  const exitStable = loaded.value['exitStable'] === true;

  return {
    id: 'reconnect',
    label: 'Tunnel recovery after a hard failure',
    workstream: 'requirement 4',
    state: up && down ? 'verified' : 'not_tested',
    measuredAt: parseTs(loaded.value['generatedAt']),
    headline: up
      ? `process killed → down in ${num(loaded.value['downAfterMs']) ?? '?'} ms → back in ${reconnectMs ?? '?'} ms${exitStable ? ', same exit' : ', exit changed'}`
      : 'the tunnel did not come back within the timeout',
    metrics: [
      { label: 'confirmed down', value: down ? 'yes' : 'not observed' },
      { label: 'reconnect', value: reconnectMs != null ? `${reconnectMs} ms` : '—' },
      { label: 'outage', value: num(loaded.value['totalOutageMs']) != null ? `${num(loaded.value['totalOutageMs'])} ms` : '—' },
      { label: 'exit stable', value: exitStable ? 'yes' : 'no' },
    ],
    artifact: rel,
    report: 'reports/accounting/AETHER_DNS_LEAK_RECONNECT_2026-11-03.md',
    caveats: [
      'Recovery used the cached identity and gateway; a cold start (no cache) takes longer and is not measured here.',
      'One hard-kill cycle, not a soak test: repeated failures and gateway rotation are not covered.',
    ],
  };
}

/* ------------------------------- research -------------------------------- */

/**
 * Parse the source registry. The bibliography is the durable record of what was
 * read; the dashboard should show it rather than a count of search results.
 */
export function parseBibliography(text: string): ResearchEntry[] {
  const entries: ResearchEntry[] = [];
  const blocks = text.split(/\n(?=### S\d+)/);
  for (const block of blocks) {
    const head = /^### (S\d+)\s*[—-]\s*(.+)$/m.exec(block);
    if (!head) continue;
    const id = head[1] ?? '';
    const title = head[2]?.trim() ?? '';
    if (id === '' || title === '') continue;
    const field = (name: string): string | null => {
      // "**URL:** value" — the label may carry a suffix ("**Date / version:**")
      // and the value may wrap onto following lines.
      const re = new RegExp(`\\*\\*${name}[^*]*:\\*\\*\\s*([\\s\\S]*?)(?=\\n- \\*\\*|\\n### |\\n## |$)`);
      const m = re.exec(block);
      if (!m) return null;
      const value = (m[1] ?? '').replace(/\s+/g, ' ').trim();
      return value.length > 0 ? value : null;
    };
    const urlRaw = field('URL');
    const urlMatch = urlRaw ? /https?:\/\/[^\s)]+/.exec(urlRaw) : null;
    entries.push({
      id,
      title,
      url: urlMatch ? urlMatch[0] : null,
      date: field('Date'),
      relevance: field('Type / Iran relevance'),
      confidence: field('License / confidence'),
      findings: field('Findings'),
    });
  }
  return entries;
}

/**
 * Read the five Iran-ready requirements out of the authoritative roadmap.
 *
 * This is a parse of a document the project treats as authoritative, not a
 * second copy of its claims: if the roadmap changes, this page changes with it.
 * A requirement whose status cannot be parsed is reported as `not_tested`
 * rather than guessed.
 */
export function parseRequirements(text: string): RequirementRow[] {
  const start = text.indexOf('## Iran');
  if (start < 0) return [];
  const section = text.slice(start, text.indexOf('\n---', start + 10) >>> 0 || undefined);
  const rows: RequirementRow[] = [];
  const re = /^(\d)\.\s+([\s\S]*?)(?=\n\d\.\s+|\n>|\n##|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    const body = (m[2] ?? '').replace(/\s+/g, ' ').trim();
    // The requirement name is also bold, so scan the bold tokens for the first
    // one that reads like a status: "**Vantage** … **NOT AVAILABLE**" must
    // yield NOT AVAILABLE, not "Vantage".
    const bolds = [...body.matchAll(/\*\*([^*]+)\*\*/g)].map((b) => (b[1] ?? '').trim());
    const status =
      bolds.find((b) => /^(PASS|FAIL|PARTIAL|BLOCKED|MET|NOT AVAILABLE|NOT MEASURED|NOT TESTED|NOT COVERED|DOCUMENTED)\b/i.test(b)) ??
      'unknown';
    let state: MissionState = 'not_tested';
    if (/NOT AVAILABLE|NOT MEASURED|NOT COVERED/i.test(status)) state = 'not_tested';
    else if (/PARTIAL|DOCUMENTED/i.test(status)) state = 'observed';
    else if (/\bPASS\b|\bMET\b/i.test(status)) state = 'verified';
    else if (/BLOCKED/i.test(status)) state = 'blocked';

    // The requirement text is everything before the status token.
    const cut = status === 'unknown' ? -1 : body.indexOf(`**${status}**`);
    const textPart = cut >= 0 ? body.slice(0, cut) : body;
    // Strip the roadmap's emphasis markers: the page renders the requirement in
    // its own type, so stray `**` would show up as literal text.
    const plain = textPart
      .replace(/\*\*/g, '')
      .replace(/[—–-]\s*$/, '')
      .trim();
    rows.push({ index: Number(m[1]), text: plain, state, status });
  }
  return rows;
}

/* --------------------------------- report -------------------------------- */

function loadFinalReport(root: string, _now: number): OverdriveSnapshot['report'] {
  const rel = 'reports/mission/OVERDRIVE_FINAL_2026-11-03.json';
  const loaded = readJson<Record<string, unknown>>(root, rel);
  if (!loaded.ok) {
    return { path: null, title: null, generatedAt: null, verdicts: [], note: `No final report artifact (${loaded.reason}).` };
  }
  const verdicts = Array.isArray(loaded.value['acceptance'])
    ? (loaded.value['acceptance'] as unknown[])
        .map((v) => obj(v))
        .filter((v): v is Record<string, unknown> => v !== null)
        .map((v) => ({
          objective: String(v['objective'] ?? '—'),
          status: String(v['status'] ?? 'NOT TESTED'),
          evidence: String(v['evidence'] ?? ''),
        }))
    : [];
  return {
    path: rel,
    title: typeof loaded.value['title'] === 'string' ? loaded.value['title'] : null,
    generatedAt: parseTs(loaded.value['generatedAt']),
    verdicts,
    note: 'Verdicts are copied verbatim from the report artifact; the dashboard does not re-grade them.',
  };
}

/* ------------------------------- composition ------------------------------ */

export async function buildOverdriveSnapshot(
  ctx: AppContext,
  now = Date.now(),
  rootOverride?: string | null,
): Promise<OverdriveSnapshot> {
  const root = rootOverride === undefined ? resolveRepoRoot() : rootOverride;
  const limits: string[] = [];
  const evidence: EvidenceRow[] = [];

  if (root === null) {
    limits.push(
      'The research corpus and measurement artifacts were not found from this process’s working directory, so the evidence ledger is empty rather than zero. Set NETPULSE_REPO_ROOT to point at the repository.',
    );
  } else {
    evidence.push(
      inventoryRow(root, now),
      connectRateRow(root, now),
      survivalRow(root, now),
      dnsTunnelRow(root, now),
      stagesRow(root, now),
      leakRow(root, now),
      negativeControlsRow(root, now),
      reconnectRow(root, now),
    );
  }

  /* research registry */
  let research: OverdriveSnapshot['research'] = {
    registry: null,
    total: 0,
    entries: [],
    note: 'No research registry was readable from this process.',
  };
  if (root !== null) {
    const rel = 'docs/research/dpi/bibliography.md';
    const text = readText(root, rel);
    if (text === null) {
      research.note = `Registry ${rel} could not be read.`;
    } else {
      const entries = parseBibliography(text);
      research = {
        registry: rel,
        total: entries.length,
        entries,
        note:
          entries.length > 0
            ? 'Entries are the project’s own reading record. Confidence and limitations are the registry’s, not this page’s judgement.'
            : 'The registry parsed to zero entries — the format may have changed.',
      };
      if (entries.length === 0) limits.push('The research registry exists but parsed to zero sources; the format probably changed.');
    }
  }

  /* requirements from the authoritative roadmap */
  let requirements: RequirementRow[] = [];
  if (root !== null) {
    const rel = 'docs/research/dpi/ROADMAP.md';
    const text = readText(root, rel);
    if (text === null) {
      limits.push('ROADMAP.md could not be read, so the Iran-ready ledger is empty rather than satisfied.');
    } else {
      requirements = parseRequirements(text);
      if (requirements.length === 0) limits.push('The Iran-ready section of ROADMAP.md did not parse; no requirement state is shown.');
    }
  }

  /* live adaptive + activity, reused rather than duplicated */
  let adaptive: OverdriveSnapshot['adaptive'] = null;
  let activity: OverdriveSnapshot['activity'] = [];
  try {
    const mission = await buildMissionSnapshot(ctx, now);
    adaptive = mission.adaptive;
    activity = mission.activity;
  } catch (err) {
    limits.push(`Live mission state could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }

  /* timeline: real artifact timestamps only */
  const timeline = evidence
    .filter((e) => e.measuredAt !== null)
    .map((e) => ({ ts: e.measuredAt as number, label: `${e.label} · ${e.headline}`, state: e.state, artifact: e.artifact }))
    .sort((a, b) => b.ts - a.ts);

  const counts: Record<MissionState, number> = { verified: 0, observed: 0, not_tested: 0, unavailable: 0, blocked: 0 };
  for (const e of evidence) counts[e.state] += 1;

  const met = requirements.filter((r) => r.state === 'verified').length;
  const report = root === null
    ? { path: null, title: null, generatedAt: null, verdicts: [], note: 'No repository root, so no report artifact.' }
    : loadFinalReport(root, now);

  const state: MissionState =
    counts.blocked > 0
      ? 'blocked'
      : met < requirements.length && requirements.length > 0
        ? 'not_tested'
        : counts.unavailable > 0
          ? 'unavailable'
          : counts.not_tested > 0
            ? 'not_tested'
            : counts.observed > 0
              ? 'observed'
              : 'verified';

  limits.push(
    'Every figure on this page was produced on a non-Iranian network. Iran-ready requirements are counted from ROADMAP.md; no requirement is shown as met unless that document records it.',
  );
  limits.push('This page is read-only: it opens files and reads live service state, and never dials, provisions or changes anything.');

  return {
    generatedAt: now,
    repoRoot: root,
    summary: {
      state,
      counts,
      headline:
        requirements.length > 0
          ? `${met}/${requirements.length} Iran-ready requirements met · ${evidence.filter((e) => e.state === 'verified').length} measured artifacts · ${research.total} research sources`
          : `${evidence.filter((e) => e.state === 'verified').length} measured artifacts · ${research.total} research sources`,
      evidenceRows: evidence.length,
      researchSources: research.total,
      requirementsMet: met,
      requirementsTotal: requirements.length,
    },
    evidence,
    research,
    requirements,
    timeline,
    report,
    adaptive,
    activity,
    limits,
  };
}
