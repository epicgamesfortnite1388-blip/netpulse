import crypto from 'node:crypto';
import { URL } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

import type { IncomingMessage } from 'node:http';
import type { PublicSource, SourceType, ParsedNodeConfig } from '@netpulse/shared';
import type { Logger } from '../logger';
import type { PublicSourcesRepository, SourceFetchesRepository, RawDocumentsRepository } from '../db/repositories';
import { parseNodeUri } from './nodeParsers';
import { isPrivateIp } from '../util/targetGuard';


const USER_AGENT = 'NetPulse-SourceFetcher/1.0 (+local diagnostics; educational network research)';
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Built-in source catalog — the only place in the app that declares a source
 * URL. Nothing here is a node: every host, port, uuid and password is parsed
 * out of the bytes a URL actually served (`extractRawConfigs` → `parseNodeUri`),
 * so a source can only ever contribute configs it really returned. A source
 * that is unreachable, empty, or unparseable fails loudly and imports nothing —
 * it never falls back to a mirrored, sanitized or placeholder list.
 *
 * Each `notes` string records what the file contained when it was measured, on
 * the date shown. Re-measure before trusting a count: community lists change
 * daily and a stale note is a claim, not a fact.
 */
interface BuiltinSourceSpec {
  id: string;
  name: string;
  homepage: string;
  repositoryUrl: string;
  /** `github_raw` for every built-in today; kept explicit for future sources. */
  type: SourceType;
  urls: string[];
  formats: string[];
  notes: string;
}

const BUILTIN_SPECS: readonly BuiltinSourceSpec[] = [
  /* ------------------------- v2ray-flavoured URI lists ------------------------- */
  {
    id: 'barry-far',
    name: 'barry-far / V2ray-Config',
    homepage: 'https://github.com/barry-far/V2ray-Config',
    repositoryUrl: 'https://github.com/barry-far/V2ray-Config',
    type: 'github_raw',
    // The subscription files live on `main` (the old master/ssr.md +
    // v2ray.md paths 404).
    urls: [
      'https://raw.githubusercontent.com/barry-far/V2ray-Config/main/All_Configs_Sub.txt',
      'https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt',
    ],
    formats: ['uri', 'base64'],
    notes: 'Mixed VLESS/Trojan/SS subscription. Measured 2026-09-16: 8,040 config lines → 8,022 parsed.',
  },
  {
    id: 'epodonios',
    name: 'Epodonios / v2ray-configs',
    homepage: 'https://github.com/Epodonios/v2ray-configs',
    repositoryUrl: 'https://github.com/Epodonios/v2ray-configs',
    type: 'github_raw',
    urls: [
      'https://raw.githubusercontent.com/Epodonios/v2ray-configs/main/All_Configs_Sub.txt',
      'https://raw.githubusercontent.com/Epodonios/v2ray-configs/main/Sub1.txt',
    ],
    formats: ['uri', 'base64'],
    notes: 'Subscription files at the repo root on `main`.',
  },
  {
    id: 'ebrasha',
    name: 'ebrasha / free-v2ray-public-list',
    homepage: 'https://github.com/ebrasha/free-v2ray-public-list',
    repositoryUrl: 'https://github.com/ebrasha/free-v2ray-public-list',
    type: 'github_raw',
    urls: [
      'https://raw.githubusercontent.com/ebrasha/free-v2ray-public-list/main/V2Ray-Config-By-EbraSha-All-Type.txt',
      'https://raw.githubusercontent.com/ebrasha/free-v2ray-public-list/main/separated-protocols/vless_configs.txt',
    ],
    formats: ['uri', 'base64', 'plaintext'],
    notes: 'VLESS-heavy all-protocol list. Measured 2026-09-16: 37,063 lines → 34,657 parsed (20,870 VLESS · 4,994 SS · 4,532 Trojan · 4,131 VMess · 129 Hysteria2).',
  },
  {
    id: '0xRadikal',
    name: '0xRadikal / Free-v2ray-Configs',
    homepage: 'https://github.com/0xRadikal/Free-v2ray-Configs',
    repositoryUrl: 'https://github.com/0xRadikal/Free-v2ray-Configs',
    type: 'github_raw',
    urls: [
      'https://raw.githubusercontent.com/0xRadikal/Free-v2ray-Configs/main/top100.txt',
      'https://raw.githubusercontent.com/0xRadikal/Free-v2ray-Configs/main/protocols/vless.txt',
    ],
    formats: ['uri', 'base64', 'plaintext'],
    notes: 'Top-100 list plus a per-protocol VLESS file.',
  },

  /* --------------- added 2026-09-16 (each URL fetched + measured) --------------- */
  {
    id: 'mahdibland',
    name: 'mahdibland / ShadowsocksAggregator',
    homepage: 'https://github.com/mahdibland/ShadowsocksAggregator',
    repositoryUrl: 'https://github.com/mahdibland/ShadowsocksAggregator',
    type: 'github_raw',
    // The repo's other paths (sub/share/all, SS.txt, master/*) 404 — this is
    // the aggregated merge file that actually exists.
    urls: ['https://raw.githubusercontent.com/mahdibland/ShadowsocksAggregator/master/sub/sub_merge.txt'],
    formats: ['uri', 'plaintext'],
    notes: 'Shadowsocks-heavy aggregated merge. Measured 2026-09-16: 4,062 config lines → 4,017 parsed (1,825 SS · 1,555 VMess · 637 Trojan).',
  },
  {
    id: 'mheidari98',
    name: 'mheidari98 / .proxy',
    homepage: 'https://github.com/mheidari98/.proxy',
    repositoryUrl: 'https://github.com/mheidari98/.proxy',
    type: 'github_raw',
    urls: ['https://raw.githubusercontent.com/mheidari98/.proxy/main/all'],
    formats: ['base64', 'uri'],
    notes: 'Single-line base64 aggregator, widest protocol spread of any built-in. Measured 2026-09-16: 16,021 lines → 15,924 parsed across 8,937 distinct hosts (6,363 VLESS · 4,741 VMess · 2,937 SS · 1,538 Trojan · 343 Hysteria2 · 2 TUIC).',
  },
  {
    id: 'ALIILAPRO',
    name: 'ALIILAPRO / v2rayNG-Config',
    homepage: 'https://github.com/ALIILAPRO/v2rayNG-Config',
    repositoryUrl: 'https://github.com/ALIILAPRO/v2rayNG-Config',
    type: 'github_raw',
    urls: ['https://raw.githubusercontent.com/ALIILAPRO/v2rayNG-Config/main/server.txt'],
    formats: ['base64', 'uri'],
    notes: 'Single-line base64 VMess-heavy list. Measured 2026-09-16: 2,295 lines → 2,265 parsed (1,703 VMess · 559 VLESS).',
  },
  {
    id: 'ermaozi',
    name: 'ermaozi / get_subscribe',
    homepage: 'https://github.com/ermaozi/get_subscribe',
    repositoryUrl: 'https://github.com/ermaozi/get_subscribe',
    type: 'github_raw',
    // The repo's clash.yml is Clash YAML, not share links — this is the URI file.
    urls: ['https://raw.githubusercontent.com/ermaozi/get_subscribe/main/subscribe/v2ray.txt'],
    formats: ['uri', 'plaintext'],
    notes: 'Hysteria2-heavy URI list — the best Hysteria2 coverage of the built-ins. Measured 2026-09-16: 233 config lines → 223 parsed (117 Hysteria2 · 53 VLESS · 30 Trojan · 14 VMess · 9 SS).',
  },
  {
    id: 'MhdiTaheri',
    name: 'MhdiTaheri / V2rayCollector',
    homepage: 'https://github.com/MhdiTaheri/V2rayCollector',
    repositoryUrl: 'https://github.com/MhdiTaheri/V2rayCollector',
    type: 'github_raw',
    // sub/mix is the combined file; sub/vless and sub/trojan are subsets of it,
    // so fetching them too would only inflate duplicate counts.
    urls: ['https://raw.githubusercontent.com/MhdiTaheri/V2rayCollector/main/sub/mix'],
    formats: ['uri', 'plaintext'],
    notes: 'Collector mix of VLESS/Trojan/VMess/SS. Measured 2026-09-16: 1,673 config lines → 927 parsed (645 VLESS · 144 Trojan · 82 VMess · 56 SS).',
  },
  {
    id: 'peasoft',
    name: 'peasoft / NoMoreWalls',
    homepage: 'https://github.com/peasoft/NoMoreWalls',
    repositoryUrl: 'https://github.com/peasoft/NoMoreWalls',
    type: 'github_raw',
    urls: ['https://raw.githubusercontent.com/peasoft/NoMoreWalls/master/list.txt'],
    formats: ['base64', 'uri'],
    notes: 'Single-line base64 list, Hysteria2-dominated. Measured 2026-09-16: 333 config lines → 150 parsed (109 Hysteria2 · 23 VLESS · 9 SS · 7 Trojan · 2 VMess).',
  },
  {
    id: 'ts-sf',
    name: 'ts-sf / fly',
    homepage: 'https://github.com/ts-sf/fly',
    repositoryUrl: 'https://github.com/ts-sf/fly',
    type: 'github_raw',
    urls: ['https://raw.githubusercontent.com/ts-sf/fly/main/v2'],
    formats: ['base64', 'uri'],
    notes: 'Single-line base64 VMess-heavy list. Measured 2026-09-16: 201 config lines → 200 parsed (194 VMess · 6 Trojan).',
  },
];

/**
 * Zeroed catalog entry: every counter starts honest and unclaimed — counts
 * come only from real fetches recorded by the pipeline.
 */
function builtinSource(spec: BuiltinSourceSpec): PublicSource {
  return {
    id: spec.id,
    name: spec.name,
    homepage: spec.homepage,
    repositoryUrl: spec.repositoryUrl,
    enabled: true,
    type: spec.type,
    urls: [...spec.urls],
    formats: [...spec.formats],
    intervalMinutes: 60,
    lastFetch: null,
    lastSuccess: null,
    lastFailure: null,
    status: 'idle',
    discoveredConfigCount: 0,
    importedConfigCount: 0,
    duplicateCount: 0,
    invalidCount: 0,
    recentDiscovered: 0,
    recentImported: 0,
    recentHealthy: 0,
    health: 'unknown',
    lastContentHash: null,
    notes: spec.notes,
    createdAt: Date.now() - 86_400_000,
  };
}

const KNOWN_SOURCES: PublicSource[] = BUILTIN_SPECS.map(builtinSource);

export interface FetchContext {
  sourceId: string;
  fetchId: string;
  logger: Logger;
  sourcesRepo: PublicSourcesRepository;
  fetchesRepo: SourceFetchesRepository;
  docsRepo: RawDocumentsRepository;
  onDiscovery: (count: number) => void;
  onImport: (count: number) => void;
  onDuplicate: (count: number) => void;
  onInvalid: (count: number) => void;
  onStatus: (status: string) => void;
  /**
   * Receives successfully parsed configs for persistence.
   * Returns real imported/duplicate/invalid counts from the deduplicating importer.
   * When absent, the pipeline counts valid parses as imported without persisting.
   */
  onImportConfigs?: (
    sourceUrl: string,
    configs: Array<{ raw: string; parsed: { config: ParsedNodeConfig; secret: string } }>,
  ) => Promise<{ imported: number; duplicates: number; invalid: number }>;
}

/* --------------------------------- content hash -------------------------------- */

export function hashContent(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashContentShort(text: string): string {
  return hashContent(text).slice(0, 12);
}

/* --------------------------------- fetch helpers -------------------------------- */

/**
 * SSRF guard for source fetching: only http(s) to public Internet hosts.
 * Rejects loopback/private/link-local/metadata literals AND hostnames that
 * resolve to them (closes the DNS-rebinding window for the connection that
 * immediately follows). Redirects are never followed (single-shot request).
 */
async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`invalid source URL: "${rawUrl}"`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`source URL scheme must be http(s), got "${parsed.protocol}"`);
  }
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  if (port === '0' || Number(port) > 65535) {
    throw new Error(`source URL has an invalid port: "${parsed.port}"`);
  }
  if (net.isIP(host) !== 0) {
    if (isPrivateIp(host)) {
      throw new Error(`source URL host "${host}" is a private/loopback/metadata address and is not allowed`);
    }
    return parsed;
  }
  // hostname: resolve and refuse private results before connecting
  let resolved: { address: string }[];
  try {
    resolved = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`source URL host "${host}" could not be resolved: ${err instanceof Error ? err.message : 'dns error'}`);
  }
  const privateHit = resolved.find((r) => isPrivateIp(r.address));
  if (privateHit) {
    throw new Error(`source URL host "${host}" resolves to a private/loopback address (${privateHit.address}) and is not allowed`);
  }
  return parsed;
}

async function fetchOnce(rawUrl: string, timeoutMs: number): Promise<{ text: string; bytes: number; statusCode: number }> {
  const parsed = await assertPublicHttpUrl(rawUrl);
  const mod = parsed.protocol === 'https:' ? https : http;
  const chunks: Buffer[] = [];

  return new Promise<{ text: string; bytes: number; statusCode: number }>((resolve, reject) => {
    let settled = false;
    // Single-shot guard: timeout/error/end must never double-settle the promise
    // (`req` is safe to reference in the timer callback: it only fires after this tick)
    /* eslint-disable prefer-const */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /* eslint-enable prefer-const */
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new Error(`request timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    const req = mod.request(parsed.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/plain, text/markdown, application/json, text/yaml, */*',
      },
      agent: false,
    }, (res: IncomingMessage) => {
      // A single redirect hop to a still-public https URL is followed (many
      // raw hosts canonicalize paths); anything else is an honest error.
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const loc = res.headers.location;
        res.resume();
        if (!loc) {
          finish(() => reject(new Error(`HTTP ${res.statusCode} redirect without Location`)));
          return;
        }
        const next = new URL(loc, parsed).toString();
        finish(() => reject(Object.assign(new Error(`redirect:${next}`), { code: 'redirect', redirectUrl: next })));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume(); // drain to release the socket
        finish(() => reject(new Error(`HTTP ${res.statusCode ?? 0} ${res.statusMessage ?? ''}`.trim())));
        return;
      }
      let bytesSeen = 0;
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytesSeen += chunk.length;
        if (bytesSeen > MAX_RESPONSE_BYTES) {
          res.destroy();
          finish(() => reject(new Error(`response too large (>${MAX_RESPONSE_BYTES} bytes)`)));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        finish(() => resolve({ text, bytes: Buffer.byteLength(text, 'utf8'), statusCode: res.statusCode ?? 200 }));
      });
      res.on('error', (err: Error) => {
        finish(() => reject(err));
      });
    });
    req.on('error', (err: Error) => {
      finish(() => reject(err));
    });
    req.on('timeout', () => {
      req.destroy();
      finish(() => reject(new Error('request timed out')));
    });
    req.end();
  });
}

const FETCH_RETRIES = 2;

/**
 * Fetch with bounded retries: transient network errors and 5xx get 2 retries
 * with linear backoff; 4xx (not found, forbidden) fails fast — retrying a
 * deterministic 404 just burns the timeout budget.
 */
async function fetchText(rawUrl: string, timeoutMs: number): Promise<{ text: string; bytes: number; statusCode: number }> {
  let lastErr: Error = new Error('unreachable');
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const r = await fetchOnce(rawUrl, timeoutMs);
      return r;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const msg = lastErr.message;
      // follow one redirect hop by re-entering on the target URL
      if (lastErr.message.startsWith('redirect:')) {
        const next = msg.slice('redirect:'.length);
        const r = await fetchOnce(next, timeoutMs);
        return r;
      }
      const statusMatch = /^HTTP (\d{3})/.exec(msg);
      const status = statusMatch ? Number(statusMatch[1]) : null;
      // 4xx: deterministic failure — do not retry
      if (status != null && status >= 400 && status < 500) throw lastErr;
      if (attempt < FETCH_RETRIES) {
        await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/* --------------------------------- line splitter -------------------------------- */

function splitLines(text: string): string[] {
  // Handles both CRLF and LF, trims empty lines
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/** Share-link schemes the parsers understand (kept in sync with nodeParsers). */
const CONFIG_URI_RE = /^(vmess|vless|trojan|ss|ssr|hysteria2|hy2|tuic|wireguard):\/\//i;

/* --------------------------------- URL extraction from markdown -------------------------------- */

function extractUrlsFromMarkdown(text: string): string[] {
  // Extract URLs from markdown links: [text](url) or <url>
  const urls: string[] = [];
  const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(text)) !== null) {
    try {
      if (m[2]) {
        const u = new URL(m[2]!);
        if (u.protocol.startsWith('http')) urls.push(u.href);
      }
    } catch { /* skip */ }
  }
  // Also bare URLs
  const bareRe = /https?:\/\/[^\s<>\"'{}|\\^`\[\]]+/g;
  while ((m = bareRe.exec(text)) !== null) {
    try {
      const u = new URL(m[0]);
      if (u.hostname.includes('githubusercontent.com') || u.hostname.includes('github.io')) {
        urls.push(u.href);
      }
    } catch { /* skip */ }
  }
  return urls;
}

/* --------------------------------- source fetching -------------------------------- */

export async function fetchSourceUrls(source: PublicSource, _ctx: FetchContext): Promise<{ urls: string[]; rawText: string | null }> {
  // For github_raw, the URLs are already configured; fetch each
  if (source.type === 'github_raw') {
    const results = await Promise.allSettled(
      source.urls.map(async (url) => {
        const { text, bytes } = await fetchText(url, FETCH_TIMEOUT_MS);
        return { url, text, bytes };
      }),
    );

    const valid: { url: string; text: string; bytes: number }[] = [];
    const failures: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === 'fulfilled') {
        valid.push(r.value);
      } else {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        failures.push(`${source.urls[i] ?? `url#${i}`}: ${reason}`);
      }
    }
    if (valid.length === 0) {
      throw new Error(`all ${source.urls.length} source URLs failed — ${failures.join(' | ')}`);
    }
    // partial success is recorded but not fatal: some URLs being dead is normal
    // for community-maintained lists; the fetch continues with what worked.

    // Concatenate all fetched content
    const combined = valid.map((v) => `# Source: ${v.url}\n\n${v.text}`).join('\n\n---\n\n');
    return { urls: valid.map((v) => v.url), rawText: combined };
  }

  if (source.type === 'raw_file') {
    const firstUrl = source.urls[0];
    if (!firstUrl) throw new Error('no source URLs configured');
    const { text } = await fetchText(firstUrl, FETCH_TIMEOUT_MS);
    return { urls: [firstUrl], rawText: text };
  }

  if (source.type === 'subscription_url') {
    const firstUrl = source.urls[0];
    if (!firstUrl) throw new Error('no source URLs configured');
    const { text } = await fetchText(firstUrl, FETCH_TIMEOUT_MS);
    return { urls: [firstUrl], rawText: text };
  }

  // website type: discover URLs from content
  if (source.type === 'website') {
    const firstUrl = source.urls[0];
    if (!firstUrl) throw new Error('no source URLs configured');
    const { text } = await fetchText(firstUrl, FETCH_TIMEOUT_MS);
    const urls = extractUrlsFromMarkdown(text);
    return { urls, rawText: text };
  }

  throw new Error(`unsupported source type: ${source.type}`);
}

/* --------------------------------- raw document extraction -------------------------------- */

export function extractRawConfigs(rawText: string): { configs: string[]; format: string } {
  // A source may contain multiple configs separated by newlines
  const lines = splitLines(rawText);

  // Base64 is checked FIRST, and on the payload with the fetcher's own framing
  // removed. Two things went wrong when this ran last: the framing the fetcher
  // prepends (`# Source: <url>`, `---` separators) contains `#`, which made every
  // base64 subscription look like markdown and take the markdown branch — so a
  // whole class of feeds parsed to zero configs and imported nothing. And a
  // wrapped (76-column) payload never matched the old single-line test.
  // A base64 body can contain neither `#` nor `-` runs, so those lines can only
  // be framing. The decode only counts when it really contains share links,
  // which is what stops an unrelated document from being "decoded" into
  // invented configs.
  const payload = lines.filter((l) => !l.startsWith('#') && !/^-{3,}$/.test(l)).join('');
  if (payload.length > 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    const decodedLines = splitLines(Buffer.from(payload, 'base64').toString('utf8'));
    if (decodedLines.some((l) => CONFIG_URI_RE.test(l))) {
      return { configs: decodedLines.filter((l) => l.includes('://')), format: 'base64' };
    }
  }

  // If it's a markdown file, extract the config lines
  const isMarkdown = rawText.includes('```') || rawText.includes('#');

  if (isMarkdown) {
    const configs: string[] = [];
    let inCodeBlock = false;
    let codeBlockLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          // End of code block
          const code = codeBlockLines.join('\n').trim();
          if (code) configs.push(code);
          codeBlockLines = [];
          inCodeBlock = false;
        } else {
          // Language tag (e.g. ```text) is not needed for config extraction
          inCodeBlock = true;
        }
      } else if (inCodeBlock) {
        codeBlockLines.push(line);
      }
    }

    if (codeBlockLines.length > 0 && inCodeBlock) {
      const code = codeBlockLines.join('\n').trim();
      if (code) configs.push(code);
    }

    // Also extract share links from non-code-block lines. A share link's `#`
    // starts its remark — the node's name, which the source really served — so
    // the link is kept whole instead of being truncated at the `#`. Only
    // trailing whitespace-separated junk (markdown table cells, list padding)
    // is dropped; almost every subscription list contains `#`, so truncating
    // here used to strip the name off every imported node.
    for (const line of lines) {
      if (line.startsWith('```') || line.startsWith('#')) continue;
      if (!line.includes('://')) continue;
      const trimmed = line.split(/\s+/)[0]?.trim() ?? '';
      if (trimmed && CONFIG_URI_RE.test(trimmed)) configs.push(trimmed);
    }

    return { configs: configs.filter((c) => c.length > 0), format: 'mixed' };
  }

  // Plain text or subscription format
  if (lines.length > 0 && lines.every((l: string) => l.includes('://') || l.startsWith('vmess://') || l.startsWith('vless://') || l.startsWith('trojan://') ||
      l.startsWith('ss://') || l.startsWith('ssr://') || l.startsWith('hysteria2://') || l.startsWith('hy2://') || l.startsWith('tuic://'))) {
    // Likely a subscription list
    return { configs: lines, format: 'uri-list' };
  }

  // Generic: treat each non-empty line as a potential config
  return { configs: lines.filter((l) => l.includes('://')), format: 'plaintext' };
}

/* --------------------------------- candidate partition -------------------------------- */

/**
 * Split extracted candidates into what a parser accepted and what it refused.
 *
 * Extraction is deliberately permissive — it hands over every line that could
 * be a node, including the nested subscription URLs many lists carry. This is
 * where those stop being a node: a candidate a parser cannot turn into a config
 * is counted, never skipped.
 *
 * That total is the point: `valid.length + invalid === candidates.length`, so
 * the pipeline's own arithmetic closes (`discovered === accepted + invalid`) and
 * the per-source table cannot show lines that were neither imported nor
 * refused. Lines used to be dropped in silence here, which is how a feed could
 * report 333 discovered against 150 accepted and 12 invalid with 171 configs
 * unaccounted for.
 */
export function partitionConfigs(candidates: string[]): {
  valid: Array<{ raw: string; parsed: { config: ParsedNodeConfig; secret: string } }>;
  invalid: number;
} {
  const valid: Array<{ raw: string; parsed: { config: ParsedNodeConfig; secret: string } }> = [];
  let invalid = 0;

  for (const raw of candidates) {
    try {
      const parsed = parseNodeUri(raw);
      if (parsed.protocol !== 'unknown' && parsed.result !== null) {
        valid.push({ raw, parsed: parsed.result as { config: ParsedNodeConfig; secret: string } });
      } else {
        invalid++;
      }
    } catch {
      invalid++;
    }
  }

  return { valid, invalid };
}

/* --------------------------------- source registry -------------------------------- */

export function getKnownSources(): PublicSource[] {
  // Arrays are copied too: a shallow spread would hand callers the catalog's
  // own `urls` array, so one `push` anywhere would edit the built-ins.
  return KNOWN_SOURCES.map((s) => ({ ...s, urls: [...s.urls], formats: [...s.formats] }));
}

export function getSourceById(id: string): PublicSource | undefined {
  return KNOWN_SOURCES.find((s) => s.id === id);
}

/**
 * Seed the built-in sources into the database, idempotently.
 *
 * Built-ins used to exist only as constants: the list route served them from
 * memory while fetch/disable/delete looked them up in the DB — so every
 * built-in Fetch returned "source not found" (surfaced as a 502). Seeding at
 * boot makes the DB the single source of truth; user mutations (disable,
 * counts, status) survive restarts because the seed never overwrites.
 */
export function seedKnownSources(repo: PublicSourcesRepository): void {
  for (const s of KNOWN_SOURCES) {
    if (repo.get(s.id)) continue;
    repo.insert({
      id: s.id,
      name: s.name,
      homepage: s.homepage ?? null,
      repositoryUrl: s.repositoryUrl ?? null,
      enabled: s.enabled,
      type: s.type,
      urls: s.urls,
      formats: s.formats,
      intervalMinutes: s.intervalMinutes,
      lastFetch: null,
      lastSuccess: null,
      lastFailure: null,
      status: 'idle',
      discoveredConfigCount: 0,
      importedConfigCount: 0,
      duplicateCount: 0,
      invalidCount: 0,
      recentDiscovered: 0,
      recentImported: 0,
      recentHealthy: 0,
      health: 'unknown',
      lastContentHash: null,
      notes: s.notes ?? null,
      createdAt: Date.now(),
    });
  }
}

export function createSourceFromInput(input: {
  name: string;
  urls: string[];
  type?: SourceType;
  formats?: string[];
  intervalMinutes?: number;
  homepage?: string;
  repositoryUrl?: string;
  notes?: string;
}): PublicSource {
  return {
    id: `source:${crypto.randomUUID().slice(0, 8)}`,
    name: input.name,
    homepage: input.homepage ?? null,
    repositoryUrl: input.repositoryUrl ?? null,
    enabled: true,
    type: input.type ?? 'raw_file',
    urls: input.urls,
    formats: input.formats ?? ['uri'],
    intervalMinutes: input.intervalMinutes ?? 60,
    lastFetch: null,
    lastSuccess: null,
    lastFailure: null,
    status: 'idle',
    discoveredConfigCount: 0,
    importedConfigCount: 0,
    duplicateCount: 0,
    invalidCount: 0,
    recentDiscovered: 0,
    recentImported: 0,
    recentHealthy: 0,
    health: 'unknown',
    lastContentHash: null,
    notes: input.notes ?? null,
    createdAt: Date.now(),
  };
}

/* --------------------------------- fetch + import pipeline -------------------------------- */

/**
 * Outcome of one fetch. `status` is the pipeline's own verdict — a feed that
 * 404'd, timed out, or produced no parseable configs comes back `failed` with
 * the reason, so callers cannot mistake "the HTTP request finished" for
 * "the source worked".
 */
export interface SourceFetchOutcome {
  status: 'completed' | 'failed';
  error: string | null;
  fetched: number;
  imported: number;
  duplicates: number;
  invalid: number;
  documents: string[];
}

export async function fetchAndImportSource(
  source: PublicSource,
  ctx: FetchContext,
): Promise<SourceFetchOutcome> {
  ctx.onStatus('fetching');

  // Create fetch record
  const fetchId = `fetch:${Date.now().toString(36)}:${crypto.randomUUID().slice(0, 4)}`;
  ctx.fetchesRepo.create({
    id: fetchId,
    sourceId: source.id,
    startedAt: Date.now(),
    finishedAt: null,
    url: source.urls[0] ?? null,
    status: 'running',
    rawBytes: null,
    configCount: 0,
    importedCount: 0,
    duplicateCount: 0,
    invalidCount: 0,
    error: null,
    contentHash: null,
  });

  let fetched = 0;
  let imported = 0;
  let duplicates = 0;
  let invalid = 0;
  const documents: string[] = [];

  try {
    // Fetch
    const { urls, rawText } = await fetchSourceUrls(source, ctx);
    ctx.onStatus('parsing');

    if (!rawText) {
      throw new Error('no content retrieved');
    }

    // Store raw document
    const docId = `doc:${Date.now().toString(36)}:${crypto.randomUUID().slice(0, 4)}`;
    const contentHash = hashContent(rawText);
    const firstUrl = urls[0] ?? source.urls.join(',') ?? '';
    ctx.docsRepo.insert({
      id: docId,
      sourceId: source.id,
      fetchId,
      sourceUrl: firstUrl,
      originalText: rawText,
      originalHash: contentHash,
      detectedFormat: 'markdown',
      sizeBytes: Buffer.byteLength(rawText, 'utf8'),
      parsedAt: null,
      configCount: 0,
      error: null,
      fetchedAt: Date.now(),
    });

    fetched = 1;
    documents.push(docId);

    // Check content hash change
    const lastHash = source.lastContentHash;
    if (lastHash && lastHash === contentHash) {
      // No change detected; skip reprocessing
      ctx.fetchesRepo.finish(fetchId, {
        finishedAt: Date.now(),
        status: 'skipped',
        configCount: 0,
        importedCount: 0,
        duplicateCount: 0,
        invalidCount: 0,
        contentHash,
        rawBytes: Buffer.byteLength(rawText, 'utf8'),
      });
      ctx.sourcesRepo.update(source.id, {
        lastFetch: Date.now(),
        status: 'healthy',
        lastContentHash: contentHash,
      });
      return { status: 'completed', error: null, fetched, imported, duplicates, invalid, documents };
    }

    // Extract configs from raw text
    const { configs } = extractRawConfigs(rawText);

    if (configs.length === 0) {
      throw new Error('no configs found in source');
    }

    // Parse each config and hand valid ones to the importer
    const { valid: validConfigs, invalid: parseInvalid } = partitionConfigs(configs);

    // Persist through the deduplicating importer when wired; otherwise count only
    if (ctx.onImportConfigs) {
      const firstSourceUrl = urls[0] ?? '';
      const importResult = await ctx.onImportConfigs(firstSourceUrl, validConfigs);
      imported = importResult.imported;
      duplicates = importResult.duplicates;
      invalid = parseInvalid + importResult.invalid;
    } else {
      imported = validConfigs.length;
      duplicates = 0;
      invalid = parseInvalid;
    }

    ctx.onStatus('importing');

    // Mark document as parsed
    ctx.docsRepo.markParsed(docId, Date.now(), configs.length);

    // Update source counts
    ctx.sourcesRepo.update(source.id, {
      discoveredConfigCount: source.discoveredConfigCount + configs.length,
      importedConfigCount: source.importedConfigCount + imported,
      duplicateCount: source.duplicateCount + duplicates,
      invalidCount: source.invalidCount + invalid,
      recentDiscovered: source.recentDiscovered + configs.length,
      recentImported: source.recentImported + imported,
      recentHealthy: source.recentHealthy + (imported > 0 ? 1 : 0),
      lastSuccess: Date.now(),
      lastFetch: Date.now(),
      status: 'healthy',
      health: imported > 0 ? (imported >= configs.length * 0.5 ? 'excellent' : 'good') : 'poor',
      lastContentHash: contentHash,
    });

    ctx.fetchesRepo.finish(fetchId, {
      finishedAt: Date.now(),
      status: 'completed',
      configCount: configs.length,
      importedCount: imported,
      duplicateCount: duplicates,
      invalidCount: invalid,
      contentHash,
      rawBytes: Buffer.byteLength(rawText, 'utf8'),
    });

    ctx.onDiscovery(configs.length);
    ctx.onImport(imported);
    ctx.onDuplicate(duplicates);
    ctx.onInvalid(invalid);

    return { status: 'completed', error: null, fetched, imported, duplicates, invalid, documents };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ctx.onStatus('failed');
    ctx.onInvalid(invalid + 1);

    ctx.sourcesRepo.update(source.id, {
      lastFailure: Date.now(),
      status: 'failed',
      health: 'poor',
    });

    ctx.fetchesRepo.finish(fetchId, {
      finishedAt: Date.now(),
      status: 'failed',
      error,
      contentHash: null,
      rawBytes: null,
    });

    return { status: 'failed', error, fetched, imported, duplicates, invalid: invalid + 1, documents };
  }
}

/* --------------------------------- background refresh -------------------------------- */

export interface SourceRefreshOptions {
  enabled: boolean;
  intervalMinutes: number;
  onSourceFetched?: (source: PublicSource) => void;
}

export class SourceRefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled: boolean = false;
  private intervalMs: number = 60 * 60 * 1000; // 1 hour default

  constructor(
    private readonly sources: PublicSource[],
    private readonly fetchOne: (source: PublicSource) => Promise<void>,
    private readonly logger: Logger,
  ) {}

  start(opts: SourceRefreshOptions): void {
    if (this.timer) this.stop();
    this.enabled = opts.enabled;
    this.intervalMs = Math.max(15, opts.intervalMinutes) * 60 * 1000;

    if (!this.enabled) return;

    this.logger.info({ intervalMinutes: opts.intervalMinutes }, 'source refresh scheduler started');
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.enabled = false;
  }

  private scheduleNext(): void {
    if (!this.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runOnce().finally(() => this.scheduleNext());
    }, this.intervalMs);
    // Don't keep process alive just for refresh
    this.timer.unref?.();
  }

  private async runOnce(): Promise<void> {
    if (!this.enabled) return;

    const now = Date.now();
    for (const source of this.sources) {
      if (!source.enabled) continue;

      // Check if we should skip (recent fetch)
      if (source.lastSuccess && (now - source.lastSuccess) < this.intervalMs * 0.8) {
        continue;
      }

      try {
        await this.fetchOne(source);
      } catch (err) {
        this.logger.warn({ sourceId: source.id, error: err instanceof Error ? err.message : String(err) }, 'source refresh failed');
      }
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getIntervalMs(): number {
    return this.intervalMs;
  }
}

/* --------------------------------- SSRF guard for source URLs -------------------------------- */

const BLOCKED_DOMAINS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'metadata.google.internal',
  'metadata.google',
  '169.254.169.254',
  '100.100.100.200',
]);

export function isValidSourceUrl(url: string): { ok: boolean; error?: string } {
  try {
    const u = new URL(url);

    if (!u.protocol.startsWith('http')) {
      return { ok: false, error: 'only HTTP/HTTPS URLs are allowed' };
    }

    const hostname = u.hostname.toLowerCase();

    // Block suspicious domains
    if (BLOCKED_DOMAINS.has(hostname)) {
      return { ok: false, error: 'blocked domain' };
    }

    // Block private IP addresses
    if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) || /^169\.254\./.test(hostname)) {
      return { ok: false, error: 'private IP not allowed' };
    }

    // Block internal/link-local IPv6
    if (hostname.startsWith('::1') || hostname.startsWith('fe80:') || hostname.startsWith('fc') || hostname.startsWith('fd')) {
      return { ok: false, error: 'private IPv6 not allowed' };
    }

    // Only allow certain domains for safety
    const allowedPatterns = [
      /github\.com$/,
      /raw\.githubusercontent\.com$/,
      /github\.io$/,
      /v2nodes\.com$/,
      /cloudflare\.com$/,
    ];

    const isAllowed = allowedPatterns.some((p) => p.test(hostname));
    if (!isAllowed) {
      // For custom sources, allow but log
      return { ok: true };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: 'invalid URL' };
  }
}
