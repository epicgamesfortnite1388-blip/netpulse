#!/usr/bin/env node
/**
 * Compare two field measurements (the JSON that `scripts/field-iran-isp.ps1`
 * files as `REPLAY_LIVE_IR_ISP_<tag>.json` / `REPLAY_LIVE_TUNNEL_CONTROL_<tag>.json`).
 *
 * Why a comparison tool exists at all: a single field run says "this corpus,
 * this moment, this network". The interesting question is always the second
 * one - a different ISP, a different city, or the same network minutes later -
 * and the answer is not a second report, it is a diff. Every row in these files
 * is one (node, engine) attempt with a real `ok` and a real duration, so the
 * diff is exact rather than narrative:
 *
 *   * outcome flips: pairs that worked on one vantage and failed on the other,
 *     with both durations, which is where any "this ISP filters X" claim starts;
 *   * agreement: how much of the corpus behaves identically, so a claim of
 *     difference is measured against a baseline of sameness;
 *   * the adaptive arm's own aggregates (success rate, first choice, attempts,
 *     p50/p95) side by side.
 *
 * It compares ARMS as they are: an ISP-bypass run against a tunnel-control run
 * is a PATH comparison, not an ISP comparison, and the output says which it is
 * from the corpus and the arm's own metadata. It never turns a difference into
 * a cause.
 *
 * Usage:
 *   node scripts/compare-field-vantages.mjs \
 *     --a reports/adaptive/REPLAY_LIVE_IR_ISP.json --label-a "AS16322 raw path" \
 *     --b reports/adaptive/REPLAY_LIVE_TUNNEL_CONTROL.json --label-b "AS16322 via tunnel"
 *
 * Writes `reports/adaptive/COMPARE_<a>_vs_<b>.md` and a `.json` twin next to it.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (!arg?.startsWith('--')) continue;
  const key = arg.slice(2);
  const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  opts[key] = value;
}

if (!opts.a || !opts.b) {
  console.error('usage: node scripts/compare-field-vantages.mjs --a <run.json> --b <run.json> [--label-a X] [--label-b Y] [--out dir]');
  process.exit(2);
}

function readRun(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!Array.isArray(data.rows)) throw new Error('no rows[] — is this a replay/field JSON?');
    return data;
  } catch (err) {
    console.error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

function stem(file) {
  return path.basename(file).replace(/\.json$/i, '');
}

const A = readRun(opts.a);
const B = readRun(opts.b);
const labelA = typeof opts['label-a'] === 'string' ? opts['label-a'] : stem(opts.a);
const labelB = typeof opts['label-b'] === 'string' ? opts['label-b'] : stem(opts.b);

/** One corpus attempt is unique per node AND core: a node that works on xray but not sing-box is two facts. */
const keyOf = (row) => `${row.nodeId ?? row.node ?? '?'}|${row.engine ?? '?'}`;

function index(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    // Last write wins: the harness may repeat a pair, and the later attempt is
    // the one a retry-aware consumer would use.
    map.set(key, row);
  }
  return map;
}

const aRows = index(A.rows);
const bRows = index(B.rows);
const allKeys = [...new Set([...aRows.keys(), ...bRows.keys()])].sort();

const flips = [];
let agree = 0;
let bothOk = 0;
let bothFail = 0;
let onlyA = 0;
let onlyB = 0;

for (const key of allKeys) {
  const a = aRows.get(key);
  const b = bRows.get(key);
  if (!a || !b) continue; // present on one side only: reported separately
  const aOk = Boolean(a.ok);
  const bOk = Boolean(b.ok);
  if (aOk === bOk) {
    agree += 1;
    if (aOk) bothOk += 1;
    else bothFail += 1;
  } else if (aOk) {
    onlyA += 1;
    flips.push({ key, node: a.node ?? b.node, nodeId: a.nodeId ?? b.nodeId ?? null, protocol: a.protocol ?? b.protocol, engine: a.engine, workedOn: 'A', aMs: a.totalMs ?? null, bMs: b.totalMs ?? null, bError: b.error ?? null });
  } else {
    onlyB += 1;
    flips.push({ key, node: a.node ?? b.node, nodeId: a.nodeId ?? b.nodeId ?? null, protocol: a.protocol ?? b.protocol, engine: a.engine, workedOn: 'B', aMs: a.totalMs ?? null, bMs: b.totalMs ?? null, aError: a.error ?? null });
  }
}

const onlyInA = [...aRows.keys()].filter((k) => !bRows.has(k));
const onlyInB = [...bRows.keys()].filter((k) => !aRows.has(k));
const compared = agree + flips.length;
const agreementPct = compared > 0 ? (agree / compared) * 100 : null;

const rate = (rows) => {
  const total = rows.length;
  const ok = rows.filter((r) => r.ok).length;
  return { total, ok, pct: total > 0 ? (ok / total) * 100 : null };
};
const aRate = rate(A.rows);
const bRate = rate(B.rows);

const num = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace('%', ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const arm = (run, name) => run[name] ?? {};
const metricRows = [
  ['episodes', 'episodes', ''],
  ['successRate', 'successRate', '%'],
  ['firstChoiceRate', 'firstChoiceRate', '%'],
  ['meanAttempts', 'meanAttempts', ''],
  ['p50MsToWorking', 'p50MsToWorking', 'ms'],
  ['p95MsToWorking', 'p95MsToWorking', 'ms'],
  ['wastedAttempts', 'wastedAttempts', ''],
];

const sameCorpus = typeof A.corpus === 'string' && A.corpus === B.corpus;
const samePlatform = A.host?.platform === B.host?.platform;
const aIsControl = /CONTROL/.test(stem(opts.a));
const bIsControl = /CONTROL/.test(stem(opts.b));
const comparisonKind =
  !sameCorpus
    ? 'different corpora — per-pair rows are NOT directly comparable; aggregates are indicative only'
    : aIsControl === bIsControl
      ? 'same corpus and same arm — repeatability / time-of-day comparison'
      : 'same corpus, different arm — raw-ISP path vs tunnel path on this network (NOT a different ISP)';

const generatedAtA = A.generatedAt ?? null;
const generatedAtB = B.generatedAt ?? null;

const report = {
  generatedAt: new Date().toISOString(),
  comparison: {
    kind: comparisonKind,
    sameCorpus,
    samePlatform,
    armA: aIsControl ? 'control' : 'isp',
    armB: bIsControl ? 'control' : 'isp',
  },
  a: { label: labelA, file: opts.a, generatedAt: generatedAtA, corpus: A.corpus ?? null, attempts: aRate, arm: aIsControl ? 'control' : 'isp' },
  b: { label: labelB, file: opts.b, generatedAt: generatedAtB, corpus: B.corpus ?? null, attempts: bRate, arm: bIsControl ? 'control' : 'isp' },
  rows: {
    compared,
    agreementPct: agreementPct === null ? null : Number(agreementPct.toFixed(1)),
    bothOk,
    bothFail,
    onlyA,
    onlyB,
    onlyInA,
    onlyInB,
    flips,
  },
  aggregate: {
    a: { baseline: arm(A, 'baseline'), adaptive: arm(A, 'adaptive'), wins: A.adaptiveWins ?? null, losses: A.adaptiveLosses ?? null, firstChoiceDiffered: A.firstChoiceDiffered ?? null },
    b: { baseline: arm(B, 'baseline'), adaptive: arm(B, 'adaptive'), wins: B.adaptiveWins ?? null, losses: B.adaptiveLosses ?? null, firstChoiceDiffered: B.firstChoiceDiffered ?? null },
  },
  verdicts: { a: A.verdict ?? null, b: B.verdict ?? null },
  limitations: [...new Set([...(A.limitations ?? []), ...(B.limitations ?? [])])],
};

const outDir = typeof opts.out === 'string' ? opts.out : path.join('reports', 'adaptive');
fs.mkdirSync(outDir, { recursive: true });
const base = `COMPARE_${stem(opts.a)}_vs_${stem(opts.b)}`;
const jsonPath = path.join(outDir, `${base}.json`);
const mdPath = path.join(outDir, `${base}.md`);
fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed ? v.toFixed(1) : v}%`);
const line = (label, a, b, unit = '') => {
  const av = num(a);
  const bv = num(b);
  const delta = av !== null && bv !== null ? bv - av : null;
  const sign = delta === null ? '' : delta > 0 ? '+' : '';
  return `| ${label} | ${av === null ? '—' : `${av}${unit}`} | ${bv === null ? '—' : `${bv}${unit}`} | ${delta === null ? '—' : `${sign}${Number(delta.toFixed(2))}${unit}`} |`;
};

const md = [];
md.push(`# Field vantage comparison: ${labelA} vs ${labelB}`);
md.push('');
md.push(`generated: ${report.generatedAt}`);
md.push('');
md.push(`**Kind:** ${comparisonKind}`);
md.push('');
md.push('| | A | B |');
md.push('| --- | --- | --- |');
md.push(`| label | ${labelA} | ${labelB} |`);
md.push(`| file | \`${opts.a}\` | \`${opts.b}\` |`);
md.push(`| measured | ${generatedAtA ?? '—'} | ${generatedAtB ?? '—'} |`);
md.push(`| arm | ${aIsControl ? 'control (through tunnel)' : 'isp (raw path)'} | ${bIsControl ? 'control (through tunnel)' : 'isp (raw path)'} |`);
md.push(`| attempts | ${aRate.ok}/${aRate.total} ok (${pct(aRate.pct)}) | ${bRate.ok}/${bRate.total} ok (${pct(bRate.pct)}) |`);
md.push('');
md.push('## Adaptive arm, side by side');
md.push('');
md.push('| metric | A | B | delta |');
md.push('| --- | --- | --- | --- |');
for (const [label, key, unit] of metricRows) {
  md.push(line(label, report.aggregate.a.adaptive[key], report.aggregate.b.adaptive[key], unit));
}
md.push(line('adaptiveWins', report.aggregate.a.wins, report.aggregate.b.wins));
md.push(line('adaptiveLosses', report.aggregate.a.losses, report.aggregate.b.losses));
md.push('');
md.push('## Outcome agreement');
md.push('');
md.push(`- compared pairs (node + engine present in both): **${compared}**`);
md.push(`- agree: **${agree}** (${pct(agreementPct)}) — ${bothOk} worked on both, ${bothFail} failed on both`);
md.push(`- flips: **${flips.length}** — ${onlyA} worked only on A, ${onlyB} worked only on B`);
if (onlyInA.length || onlyInB.length) {
  md.push(`- pairs present on one side only: ${onlyInA.length} in A, ${onlyInB.length} in B (excluded from agreement)`);
}
md.push('');
if (flips.length > 0) {
  md.push('### Flips');
  md.push('');
  // The node label alone repeats in this corpus (the same endpoint appears under
  // more than one index), so the corpus id is printed beside it: without it two
  // opposite flips on the same label read as a contradiction.
  md.push('| node | corpus id | engine | worked on | A ms | B ms | error on the failing side |');
  md.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const flip of flips) {
    md.push(`| ${flip.node} | \`${flip.nodeId ?? '?'}\` | ${flip.engine} | ${flip.workedOn} | ${flip.aMs ?? '—'} | ${flip.bMs ?? '—'} | ${(flip.aError ?? flip.bError ?? '—').replaceAll('|', '/')} |`);
  }
  md.push('');
}
md.push('## Reading');
md.push('');
if (!sameCorpus) {
  md.push('The two files name different corpora, so the per-pair table is not a controlled comparison: the nodes themselves may differ. Only the aggregate rows are worth reading, and even those carry the corpus difference.');
} else if (aIsControl === bIsControl) {
  md.push('Same corpus, same arm: this is a **repeatability** comparison. Agreement here bounds how much of any difference between two networks can be blamed on the network rather than on the corpus or the moment.');
} else {
  md.push('Same corpus, different arm: this measures what the **path** changes on one network (raw ISP route vs the tunnel), not what a different ISP does. A different ISP needs its own field run (`npm run field:iran -- -Tag <vantage>` on that network) and its own comparison.');
}
md.push('');
md.push('No cause is claimed: a flip is a pair that behaved differently, not proof that filtering caused it. The shared limitations of both runs are listed below.');
md.push('');
for (const limitation of report.limitations) {
  const text = typeof limitation === 'string' ? limitation : JSON.stringify(limitation);
  md.push(`- ${text}`);
}
md.push('');
fs.writeFileSync(mdPath, `${md.join('\n')}\n`);

console.log(`kind        : ${comparisonKind}`);
console.log(`attempts    : A ${aRate.ok}/${aRate.total} · B ${bRate.ok}/${bRate.total}`);
console.log(`agreement   : ${compared} compared, ${agree} agree (${pct(agreementPct)}), ${flips.length} flips (A-only ${onlyA}, B-only ${onlyB})`);
console.log(`evidence    : ${mdPath}`);
console.log(`evidence    : ${jsonPath}`);
