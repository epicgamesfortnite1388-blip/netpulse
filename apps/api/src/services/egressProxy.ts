/**
 * Outbound HTTP for the cloud — the ONE place that decides how a request
 * leaves this machine.
 *
 * Why this exists: sign-in and Telegram sync talk to the Worker over the public
 * internet, and in Iran that host is commonly unreachable directly. The user
 * already has a way out — NetPulse's own tunnel, or an external client like
 * v2rayN — and both of them publish it as the **Windows system proxy**
 * (HKCU Internet Settings), which is what `getSystemProxy()` reads. Those calls
 * used to be a bare `fetch()` in the webview, which does not consult the system
 * proxy at all. Measured on this machine: with a proxy listening on loopback,
 * bare `fetch` made 0 connections through it while undici's `ProxyAgent` made 1
 * and returned 200. So every sign-in attempt and every Telegram sync failed
 * with "check your connection" on exactly the users who had already solved the
 * problem — the proxy simply was never consulted.
 *
 * Resolution order, highest priority first:
 *
 *   1. `NETPULSE_EGRESS_PROXY` — explicit override, for diagnostics and tests.
 *   2. The Windows system proxy (WinINET). This is what NetPulse's own tunnel
 *      writes when `systemProxy` is on, and what external clients write.
 *   3. `HTTPS_PROXY` / `HTTP_PROXY` environment variables (POSIX convention).
 *   4. Direct — correct when nothing proxies, and also correct under a TUN-mode
 *      VPN, which intercepts traffic below this process and needs no proxy.
 *
 * Deliberately NOT supported: SOCKS proxies. undici has no SOCKS agent, and
 * silently ignoring a `socks=` system proxy would reintroduce the exact bug this
 * file fixes. It is detected and reported instead (see `SOCKS_UNSUPPORTED`).
 * A user whose only route is a SOCKS listener needs a TUN-mode VPN or an HTTP
 * proxy; both work here.
 *
 * Failures are classified rather than flattened to "unreachable", because the
 * cause determines the advice: a dead proxy is fixed by starting the tunnel, a
 * TLS failure is usually filtering.
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';

import { getSystemProxy, onSystemProxyChanged } from './systemProxy';

/** The Worker that owns accounts, sync and the Telegram bridge. */
export const CLOUD_API_BASE = 'https://netpulse-cloud.shuridehradin.workers.dev';

/** Host the egress route is allowed to reach. Structural, not a filter. */
export function cloudOrigin(): URL {
  return new URL(CLOUD_API_BASE);
}

/**
 * Why an outbound call failed, in terms a user can act on. Deliberately small:
 * these are transport outcomes, not a taxonomy of the cloud's error codes.
 */
export type EgressReason =
  | 'proxy_unreachable'
  | 'direct_unreachable'
  | 'timeout'
  | 'tls_failed'
  | 'socks_unsupported';

export interface EgressFailureDetail {
  reason: EgressReason;
  /** The proxy we tried to use, if any — named so the message can point at it. */
  proxy: string | null;
  /** One sentence the UI can show verbatim. */
  message: string;
}

/** Thrown for every transport-level failure. Carries the reason, not just text. */
export class EgressError extends Error {
  constructor(
    readonly reason: EgressReason,
    message: string,
    readonly proxy: string | null,
  ) {
    super(message);
    this.name = 'EgressError';
  }

  toDetail(): EgressFailureDetail {
    return { reason: this.reason, proxy: this.proxy, message: this.message };
  }
}

export const SOCKS_UNSUPPORTED =
  'This app can route cloud traffic through an HTTP proxy, but the system proxy is a SOCKS listener. ' +
  'Turn on TUN mode, or point the system proxy at the HTTP port of your client.';

/**
 * Normalise a WinINET / env proxy value into something undici accepts.
 *
 * WinINET stores three shapes and they are all still in the wild:
 *   `127.0.0.1:8080`                  bare host:port, the usual
 *   `http=…;https=…`                  per-protocol, written by several clients
 *   `socks=127.0.0.1:1080`            SOCKS, which undici cannot speak
 *
 * Returns `null` when there is no proxy, and the sentinel
 * `SOCKS_UNSUPPORTED` when a SOCKS proxy is configured, so the caller can
 * report it rather than quietly connecting direct.
 */
export function normalizeProxy(raw: string | null | undefined): string | null | typeof SOCKS_UNSUPPORTED {
  const value = (raw ?? '').trim();
  if (value === '') return null;

  // Per-protocol form: prefer https (that is what cloud calls are), else http.
  if (value.includes('=')) {
    const parts = new Map<string, string>();
    for (const pair of value.split(';')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      parts.set(pair.slice(0, eq).trim().toLowerCase(), pair.slice(eq + 1).trim());
    }
    const scheme = parts.get('socks') ? 'socks' : null;
    if (scheme && !parts.get('https') && !parts.get('http')) return SOCKS_UNSUPPORTED;
    const picked = parts.get('https') ?? parts.get('http');
    if (picked) return withScheme(picked);
    if (scheme) return SOCKS_UNSUPPORTED;
    return null;
  }

  if (/^socks/i.test(value)) return SOCKS_UNSUPPORTED;
  return withScheme(value);
}

function withScheme(server: string): string | null {
  const v = server.trim().replace(/^\/\//, '');
  if (v === '') return null;
  if (/^https?:\/\//i.test(v)) return v;
  return `http://${v}`;
}

export interface ProxyResolutionInput {
  /** `NETPULSE_EGRESS_PROXY`, the explicit override. */
  override?: string | null;
  /** What WinINET reports (null when no system proxy is enabled). */
  systemProxy?: string | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Decide the proxy, purely. Split out from any I/O so the ordering is
 * testable without a registry or a network.
 */
export function resolveProxy(input: ProxyResolutionInput): string | null | typeof SOCKS_UNSUPPORTED {
  const override = normalizeProxy(input.override);
  if (override !== null) return override;

  const system = normalizeProxy(input.systemProxy);
  if (system !== null) return system;

  const env = input.env ?? process.env;
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const fromEnv = normalizeProxy(env[key]);
    if (fromEnv !== null) return fromEnv;
  }
  return null;
}

/**
 * The live proxy decision for this process, cached briefly.
 *
 * The system proxy changes when a tunnel starts or stops, and the resolution
 * above shells out to `reg` — caching for a few seconds keeps a sync burst from
 * spawning a process per request while still noticing a tunnel within a
 * second of it coming up.
 */
let cached: { proxy: string | null | typeof SOCKS_UNSUPPORTED; at: number } | null = null;
const CACHE_MS = 3_000;

export async function currentProxy(): Promise<string | null | typeof SOCKS_UNSUPPORTED> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.proxy;
  const { proxy } = await getSystemProxy();
  const resolved = resolveProxy({
    override: process.env['NETPULSE_EGRESS_PROXY'],
    systemProxy: proxy,
    env: process.env,
  });
  cached = { proxy: resolved, at: Date.now() };
  return resolved;
}

/** Test seam, and the way a tunnel change clears the cache. */
export function resetProxyCache(): void {
  cached = null;
}

// A tunnel that just took over the system proxy must be visible to the very
// next outbound call. Without this the cache can hold the "no proxy" answer
// from a moment earlier, and the user's first sign-in after switching the VPN
// on would go direct — and fail — which is the exact report this fixes.
onSystemProxyChanged(resetProxyCache);

/** One agent per proxy URL; undici pools connections per dispatcher. */
const agents = new Map<string, ProxyAgent>();
function agentFor(proxy: string): ProxyAgent {
  let agent = agents.get(proxy);
  if (!agent) {
    agent = new ProxyAgent(proxy);
    agents.set(proxy, agent);
  }
  return agent;
}

/** Turn a thrown transport error into the reason a user can act on. */
export function classify(err: unknown, proxy: string | null): EgressError {
  const e = err as { name?: string; message?: string; cause?: { code?: string }; code?: string };
  const code = e?.cause?.code ?? e?.code ?? '';
  const name = e?.name ?? '';

  if (name === 'AbortError' || name === 'TimeoutError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return new EgressError(
      'timeout',
      proxy
        ? `The cloud did not answer through the proxy (${proxy}) in time.`
        : 'The cloud did not answer in time.',
      proxy,
    );
  }

  const tls =
    code.includes('CERT') ||
    code.includes('SSL') ||
    code.includes('EPROTO') ||
    /certificate|self[- ]signed/i.test(e?.message ?? '');
  if (tls) {
    return new EgressError(
      'tls_failed',
      proxy
        ? `The TLS connection through the proxy (${proxy}) was rejected — this often means the connection is being filtered.`
        : 'The TLS connection was rejected — this often means the connection is being filtered.',
      proxy,
    );
  }

  // A refused connection *while a proxy is configured* is the proxy, not the
  // destination: nothing ever reached the cloud. Saying "check your connection"
  // here sends the user to debug the thing that is already working.
  if (proxy && (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH')) {
    return new EgressError(
      'proxy_unreachable',
      `Could not reach the system proxy at ${proxy}. Start the tunnel (or your proxy client) and try again.`,
      proxy,
    );
  }

  return new EgressError(
    'direct_unreachable',
    proxy
      ? `Could not reach the cloud through ${proxy}.`
      : 'Could not reach the cloud — it is blocked or offline on this network.',
    proxy,
  );
}

export interface EgressRequest {
  /** Absolute URL; must be on the cloud origin. */
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface EgressResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Perform one outbound cloud request through the resolved proxy.
 *
 * The caller supplies an absolute URL; `assertCloudUrl` is the guard that keeps
 * this from becoming a general-purpose proxy for the machine.
 */
export async function egressFetch(req: EgressRequest): Promise<EgressResponse> {
  const resolved = await currentProxy();

  if (resolved === SOCKS_UNSUPPORTED) {
    // Not a crash: try direct anyway, because a TUN-mode VPN intercepts
    // traffic below this process and needs no proxy at all. Only if that
    // fails do we report the SOCKS limitation, which is then the real cause.
    try {
      return await direct(req);
    } catch {
      throw new EgressError('socks_unsupported', SOCKS_UNSUPPORTED, null);
    }
  }

  const proxy = resolved ?? null;
  try {
    return proxy
      ? await viaProxy(req, proxy)
      : await direct(req);
  } catch (err) {
    throw classify(err, proxy);
  }
}

async function direct(req: EgressRequest): Promise<EgressResponse> {
  return read(await undiciFetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(req.timeoutMs),
  }));
}

async function viaProxy(req: EgressRequest, proxy: string): Promise<EgressResponse> {
  return read(
    await undiciFetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      dispatcher: agentFor(proxy),
      signal: AbortSignal.timeout(req.timeoutMs),
    }),
  );
}

/** Only the headers the client needs; never echo a whole remote header set. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'retry-after'];

async function read(res: Response): Promise<EgressResponse> {
  const headers: Record<string, string> = {};
  for (const h of FORWARDED_RESPONSE_HEADERS) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  return { status: res.status, headers, body: await res.text() };
}

/**
 * Keep this route from turning into an open relay: only the cloud origin is
 * reachable, so the route cannot be used to fetch anything else on the network.
 */
export function assertCloudUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('invalid egress url');
  }
  const allowed = cloudOrigin();
  if (parsed.protocol !== 'https:' || parsed.origin !== allowed.origin) {
    throw new Error(`egress is limited to ${allowed.origin}`);
  }
  return parsed;
}