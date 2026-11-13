import fs from 'node:fs';
import { getKnownSources, fetchSourceUrls, extractRawConfigs, partitionConfigs } from '../apps/api/src/services/nodeSourceRegistry.js';
import { proxyProbeWithEngine } from '../apps/api/src/services/proxyEngineRunner.js';
import { configIsTestable } from '../apps/api/src/services/proxyCores.js';

const WANTED = (process.env['PROBE_SOURCES'] ?? 'mheidari98,ALIILAPRO,peasoft')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SAMPLE = Number(process.env['PROBE_SAMPLE'] ?? 20);
const CONC = Number(process.env['PROBE_CONC'] ?? 4);
const TIMEOUT = Number(process.env['PROBE_TIMEOUT_MS'] ?? 10_000);
const OUT = process.env['PROBE_OUT'] ?? 'reports/accounting/free-config-connect-2026-11-03.json';

type Row = { source: string; protocol: string; host: string; ok: boolean; latencyMs: number | null; failureKind: string | null; error: string | null };

function sampleStride<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr.slice();
  const step = Math.floor(arr.length / n);
  const out: T[] = [];
  for (let i = 0; i < arr.length && out.length < n; i += step) out.push(arr[i]!);
  return out;
}

(async () => {
  const all = getKnownSources().filter((s) => WANTED.includes(s.id));
  const rows: Row[] = [];
  const perSource: Record<string, { discovered: number; valid: number; sampled: number; ok: number }> = {};

  for (const src of all) {
    const t0 = Date.now();
    const { rawText } = await fetchSourceUrls(src, { fetch: globalThis.fetch } as never);
    const { configs } = extractRawConfigs(rawText ?? '');
    const { valid } = partitionConfigs(configs);
    const testable = valid.filter((v) => configIsTestable(v.parsed.config).ok);
    const picked = sampleStride(testable, SAMPLE);
    perSource[src.id] = { discovered: configs.length, valid: valid.length, sampled: picked.length, ok: 0 };
    console.log(`[${src.id}] fetched=${configs.length} valid=${valid.length} testable=${testable.length} sampled=${picked.length} (${Date.now() - t0}ms)`);

    let idx = 0;
    const workers = Array.from({ length: CONC }, async () => {
      while (idx < picked.length) {
        const item = picked[idx++]!;
        const cfg = item.parsed.config;
        const res = await proxyProbeWithEngine(cfg, { secret: item.parsed.secret ?? null, preferred: 'auto', timeoutMs: TIMEOUT });
        const host = (cfg as unknown as { server?: string; address?: string }).server ?? (cfg as unknown as { address?: string }).address ?? '?';
        rows.push({
          source: src.id,
          protocol: cfg.protocol,
          host: String(host),
          ok: res.status === 'done',
          latencyMs: res.latencyMs,
          failureKind: res.failureKind,
          error: res.error,
        });
        if (res.status === 'done') perSource[src.id]!.ok++;
      }
    });
    await Promise.all(workers);
  }

  const lat = rows.filter((r) => r.ok).map((r) => r.latencyMs!).sort((a, b) => a - b);
  const summary = {
    generatedAt: new Date().toISOString(),
    probeUrl: 'https://www.cloudflare.com/cdn-cgi/trace',
    timeoutMs: TIMEOUT,
    engine: 'xray (installed 26.10.31)',
    perSource,
    totals: {
      sampled: rows.length,
      reachable: rows.filter((r) => r.ok).length,
      rate: rows.length ? +(rows.filter((r) => r.ok).length / rows.length).toFixed(3) : 0,
      latencyMs: lat.length ? { min: lat[0], median: lat[Math.floor(lat.length / 2)], max: lat[lat.length - 1] } : null,
    },
    byProtocol: Object.fromEntries(
      [...new Set(rows.map((r) => r.protocol))].map((p) => {
        const g = rows.filter((r) => r.protocol === p);
        return [p, { sampled: g.length, ok: g.filter((r) => r.ok).length }];
      }),
    ),
    byFailureKind: Object.fromEntries(
      [...new Set(rows.filter((r) => !r.ok).map((r) => r.failureKind ?? 'unknown'))].map((k) => [
        k,
        rows.filter((r) => !r.ok && (r.failureKind ?? 'unknown') === k).length,
      ]),
    ),
    results: rows,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ perSource, totals: summary.totals, byProtocol: summary.byProtocol, byFailureKind: summary.byFailureKind }, null, 2));
})();
