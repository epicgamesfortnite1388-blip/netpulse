/**
 * Free-config inventory probe.
 *
 * The VPN host is retired, so the free-source catalog is now one of the two
 * real ways to obtain a working config (the other is Aether, which needs no
 * server at all). This probe answers the only question that matters about that
 * catalog: which of the built-in sources still serve parseable configs from
 * THIS machine, right now.
 *
 * Honesty rules it keeps:
 *   - it reuses the app's own pipeline (`extractRawConfigs` → `partitionConfigs`),
 *     so a "parsed" count means exactly what the importer would mean by it;
 *   - it never reports "reachable" as "usable": a 200 that yields zero
 *     parseable configs is a failure with a reason;
 *   - it is read-only — no DB writes, no imports, nothing persisted;
 *   - it uses Node's fetch, not the app's https client, because the app's
 *     transport retries and this probe is a measurement. Parsing is identical,
 *     transport is not, and the report says so.
 *
 * Usage:
 *   npx tsx scripts/free-config-probe.ts [--out <file.json>] [--only id,id]
 *                                       [--timeout 25000] [--max-bytes 50000000]
 */
import fs from 'node:fs';
import path from 'node:path';

import { extractRawConfigs, getKnownSources, partitionConfigs } from '../apps/api/src/services/nodeSourceRegistry';

interface SourceResult {
  id: string;
  name: string;
  url: string;
  ok: boolean;
  status: number | null;
  error: string | null;
  bytes: number;
  lines: number;
  discovered: number;
  parsed: number;
  invalid: number;
  /** Share-link scheme counts across the candidates that parsed. */
  schemes: Record<string, number>;
  /** Distinct host:port pairs seen in parsed candidates. */
  distinctEndpoints: number;
  elapsedMs: number;
}

const args = process.argv.slice(2);
function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

const TIMEOUT_MS = Number(flag('timeout') ?? 25_000);
const MAX_BYTES = Number(flag('max-bytes') ?? 50 * 1024 * 1024);
const OUT = flag('out');
const ONLY = flag('only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;

/** Scheme of a share link, or `other` — never a guess about the protocol inside. */
function schemeOf(raw: string): string {
  const m = /^([a-z0-9+.-]+):\/\//i.exec(raw.trim());
  return m ? m[1]!.toLowerCase() : 'other';
}

/**
 * Best-effort endpoint identity for a config, used only to report how many
 * distinct servers a source covers. vmess carries its host in base64 JSON, so
 * it falls back to the raw string rather than pretending to know.
 */
function endpointOf(raw: string): string | null {
  const text = raw.trim();
  if (/^vmess:\/\//i.test(text)) {
    try {
      const doc = JSON.parse(Buffer.from(text.slice('vmess://'.length), 'base64').toString('utf8')) as { add?: string; port?: number | string };
      if (doc.add) return `${doc.add}:${doc.port ?? ''}`;
    } catch {
      return null;
    }
    return null;
  }
  const m = /@\[?([^\]/:@]+)\]?:(\d+)/.exec(text);
  if (m) return `${m[1]}:${m[2]}`;
  return null;
}

async function probe(id: string, name: string, url: string): Promise<SourceResult> {
  const started = Date.now();
  const base: SourceResult = {
    id, name, url, ok: false, status: null, error: null,
    bytes: 0, lines: 0, discovered: 0, parsed: 0, invalid: 0,
    schemes: {}, distinctEndpoints: 0, elapsedMs: 0,
  };

  let text: string;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'NetPulse-SourceProbe/1.0', Accept: 'text/plain, */*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    base.status = res.status;
    if (!res.ok) {
      base.error = `HTTP ${res.status} ${res.statusText}`.trim();
      base.elapsedMs = Date.now() - started;
      return base;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) {
      base.error = `response too large (${buf.byteLength} bytes)`;
      base.elapsedMs = Date.now() - started;
      return base;
    }
    base.bytes = buf.byteLength;
    text = buf.toString('utf8');
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    base.error = `${e.name}: ${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`;
    base.elapsedMs = Date.now() - started;
    return base;
  }

  base.lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0).length;

  // The app's real extraction + parse path. A source that yields no candidate
  // is a failure, not an empty success.
  const { configs } = extractRawConfigs(text);
  base.discovered = configs.length;
  if (configs.length === 0) {
    base.error = 'no configs found in source';
    base.elapsedMs = Date.now() - started;
    return base;
  }

  const { valid, invalid } = partitionConfigs(configs);
  base.parsed = valid.length;
  base.invalid = invalid;

  const endpoints = new Set<string>();
  for (const v of valid) {
    const s = schemeOf(v.raw);
    base.schemes[s] = (base.schemes[s] ?? 0) + 1;
    const ep = endpointOf(v.raw);
    if (ep) endpoints.add(ep);
  }
  base.distinctEndpoints = endpoints.size;

  base.ok = valid.length > 0;
  if (!base.ok) base.error = `0 of ${configs.length} candidates parsed`;
  base.elapsedMs = Date.now() - started;
  return base;
}

function pct(n: number, total: number): string {
  if (total === 0) return '—';
  return `${((n / total) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  // Retired built-ins stay in the catalog (their ids remain stable) but are not
  // candidates: probing a repository the app already knows is deleted would
  // only add a 404 to every run.
  const sources = getKnownSources().filter((s) => (ONLY ? ONLY.includes(s.id) : s.enabled));
  console.log(`[probe] ${sources.length} source(s), timeout ${TIMEOUT_MS} ms, node ${process.version}`);
  console.log('[probe] reading only: no database writes, no imports, no persistence\n');

  const results: SourceResult[] = [];
  for (const s of sources) {
    // One URL per source is enough to characterise it: the built-ins list a
    // primary and a fallback, and the fallback is a subset in every case.
    const url = s.urls[0];
    if (!url) continue;
    const r = await probe(s.id, s.name, url);
    results.push(r);
    const verdict = r.ok ? 'OK  ' : 'FAIL';
    console.log(
      `[${verdict}] ${s.id.padEnd(11)} ${String(r.parsed).padStart(6)} parsed / ${String(r.discovered).padStart(6)} found` +
        ` · ${(r.bytes / 1024).toFixed(0).padStart(6)} KiB · ${String(r.elapsedMs).padStart(6)} ms` +
        (r.ok ? ` · ${r.distinctEndpoints} endpoints` : ` · ${r.error}`),
    );
  }

  const okSources = results.filter((r) => r.ok);
  const totalParsed = okSources.reduce((a, r) => a + r.parsed, 0);
  const schemes: Record<string, number> = {};
  for (const r of okSources) for (const [k, v] of Object.entries(r.schemes)) schemes[k] = (schemes[k] ?? 0) + v;

  const summary = {
    generatedAt: Date.now(),
    generatedAtIso: new Date().toISOString(),
    vantage: `${process.platform} ${process.arch}, node ${process.version}`,
    transport: 'node fetch (follow redirects, bounded timeout); parsing via the app pipeline',
    sourcesProbed: results.length,
    sourcesOk: okSources.length,
    sourcesFailed: results.length - okSources.length,
    totalParsed,
    byScheme: schemes,
  };

  console.log('\n[probe] --- summary ---');
  console.log(`[probe] ${okSources.length}/${results.length} sources usable · ${totalParsed} parseable configs total`);
  console.log(`[probe] schemes: ${Object.entries(schemes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}`);
  for (const r of results.filter((x) => !x.ok)) console.log(`[probe] unusable: ${r.id} — ${r.error}`);

  const payload = { summary, sources: results, parseRate: okSources.map((r) => ({ id: r.id, rate: pct(r.parsed, r.discovered) })) };
  if (OUT) {
    const outPath = path.resolve(OUT);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\n[probe] wrote ${outPath}`);
  } else {
    console.log(`\n${JSON.stringify(payload, null, 2)}`);
  }

  // Non-zero when NOTHING worked: an empty catalog is a real failure worth
  // surfacing to a caller, while one dead community list is normal.
  process.exitCode = okSources.length === 0 ? 1 : 0;
}

void main();
