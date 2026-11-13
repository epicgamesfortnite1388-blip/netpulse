/**
 * Free-config survival measurement (F-05, roadmap open question 5).
 *
 * Round 1 dials a deterministic sample and keeps the endpoints that carried
 * traffic. After a gap, round 2 re-dials exactly those endpoints. A config that
 * answered in round 1 and not in round 2 is the honest definition of "did not
 * survive"; a config that answered in neither round was never a candidate.
 *
 * Raw share links are held in memory only — never written to the report, never
 * logged. The JSON carries protocol, latency and outcome per probe.
 *
 * Env: PROBE_SOURCES (comma ids), PROBE_SAMPLE (per source),
 *      PROBE_CONC, PROBE_TIMEOUT_MS, PROBE_GAP_MIN, PROBE_OUT.
 */
import fs from 'node:fs';
import { getKnownSources, fetchSourceUrls, extractRawConfigs, partitionConfigs } from '../apps/api/src/services/nodeSourceRegistry.js';
import { proxyProbeWithEngine } from '../apps/api/src/services/proxyEngineRunner.js';
import { configIsTestable } from '../apps/api/src/services/proxyCores.js';

const SOURCES = (process.env['PROBE_SOURCES'] ?? 'barry-far,0xRadikal,MhdiTaheri')
  .split(',').map((s) => s.trim()).filter(Boolean);
const SAMPLE = Number(process.env['PROBE_SAMPLE'] ?? 25);
const CONC = Number(process.env['PROBE_CONC'] ?? 6);
const TIMEOUT = Number(process.env['PROBE_TIMEOUT_MS'] ?? 12_000);
const GAP_MIN = Number(process.env['PROBE_GAP_MIN'] ?? 60);
const OUT = process.env['PROBE_OUT'] ?? 'reports/accounting/free-config-survival-2026-11-03.json';

type Probe = { protocol: string; ok: boolean; latencyMs: number | null; failureKind: string | null };
type Candidate = { source: string; config: Parameters<typeof proxyProbeWithEngine>[0]; secret: string | null };

function stride<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr.slice();
  const step = Math.floor(arr.length / n);
  const out: T[] = [];
  for (let i = 0; i < arr.length && out.length < n; i += step) out.push(arr[i]!);
  return out;
}

async function probe(c: Candidate): Promise<Probe> {
  const res = await proxyProbeWithEngine(c.config, { secret: c.secret, preferred: 'auto', timeoutMs: TIMEOUT });
  return {
    protocol: c.config.protocol,
    ok: res.status === 'done',
    latencyMs: res.latencyMs,
    failureKind: res.failureKind,
  };
}

async function probeAll(list: Candidate[]): Promise<Probe[]> {
  const out: Probe[] = new Array(list.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (i < list.length) {
        const idx = i++;
        out[idx] = await probe(list[idx]!);
      }
    }),
  );
  return out;
}

(async () => {
  const startedAt = new Date().toISOString();
  const wanted = getKnownSources().filter((s) => SOURCES.includes(s.id));
  const picked: Candidate[] = [];
  const discovered: Record<string, number> = {};

  for (const src of wanted) {
    const { rawText } = await fetchSourceUrls(src, { fetch: globalThis.fetch } as never);
    const { configs } = extractRawConfigs(rawText ?? '');
    const { valid } = partitionConfigs(configs);
    discovered[src.id] = configs.length;
    for (const v of stride(valid.filter((x) => configIsTestable(x.parsed.config).ok), SAMPLE)) {
      picked.push({ source: src.id, config: v.parsed.config, secret: v.parsed.secret ?? null });
    }
  }
  console.log(`[round1] candidates=${picked.length} from ${wanted.map((s) => s.id).join(',')}`);

  const round1 = await probeAll(picked);
  const survivors = picked.filter((_, i) => round1[i]!.ok);
  console.log(`[round1] reachable=${survivors.length}/${picked.length}; waiting ${GAP_MIN} min`);

  // Report only what a reader needs: no share links, no addresses.
  const write = (round2: Probe[] | null, note: string) => {
    const paired = survivors.map((c, i) => ({
      source: c.source,
      protocol: c.config.protocol,
      round1: round1[picked.indexOf(c)]!,
      round2: round2 ? round2[i]! : null,
    }));
    const survived = round2 ? paired.filter((p) => p.round2!.ok).length : null;
    const doc = {
      generatedAt: startedAt,
      finishedAt: new Date().toISOString(),
      gapMinutes: GAP_MIN,
      timeoutMs: TIMEOUT,
      sources: wanted.map((s) => s.id),
      discovered,
      round1: {
        sampled: picked.length,
        reachable: survivors.length,
        rate: picked.length ? +(survivors.length / picked.length).toFixed(3) : 0,
        bySource: Object.fromEntries(
          wanted.map((s) => {
            const total = picked.filter((c) => c.source === s.id).length;
            const ok = survivors.filter((c) => c.source === s.id).length;
            return [s.id, { sampled: total, ok }];
          }),
        ),
        byProtocol: Object.fromEntries(
          [...new Set(picked.map((c) => c.config.protocol))].map((p) => {
            const idx = picked.map((c, i) => ({ c, i })).filter((x) => x.c.config.protocol === p);
            return [p, { sampled: idx.length, ok: idx.filter((x) => round1[x.i]!.ok).length }];
          }),
        ),
      },
      round2: round2
        ? {
            retried: survivors.length,
            survived,
            survivalRate: survivors.length ? +(survived! / survivors.length).toFixed(3) : null,
            endpoints: paired,
          }
        : null,
      note,
    };
    fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
    return doc;
  };

  // Written before the wait so a crash or a closed laptop still leaves round 1.
  write(null, `round 2 not run yet (gap ${GAP_MIN} min)`);

  await new Promise((r) => setTimeout(r, GAP_MIN * 60_000));

  console.log(`[round2] re-probing ${survivors.length} survivors`);
  const round2 = await probeAll(survivors);
  const doc = write(round2, `round 2 run after ${GAP_MIN} min`);
  console.log(JSON.stringify({ round1: doc.round1, round2: doc.round2 && { retried: doc.round2.retried, survived: doc.round2.survived, survivalRate: doc.round2.survivalRate } }, null, 2));
})();
