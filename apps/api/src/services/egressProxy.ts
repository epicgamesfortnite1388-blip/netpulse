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
 * SOCKS5 is supported here rather than refused, because it is what the affected
 * users actually run: v2rayN's default listener is SOCKS on 127.0.0.1:10808.
 * undici has no SOCKS agent, so the handshake is ours (see `socksConnector`) —
 * which also means no new dependency that could fail to survive being inlined
 * into the desktop sidecar bundle. A SOCKS **4** listener uses a different
 * handshake that we genuinely cannot speak; it is reported by name
 * (`socks_unsupported`) rather than quietly connecting direct.
 *
 * Failures are classified rather than flattened to "unreachable", because the
 * cause determines the advice: a dead proxy is fixed by starting the tunnel, a
 * TLS failure is usually filtering.
 */

import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';

import net from 'node:net';
import tls from 'node:tls';

import { getSystemProxy, onSystemProxyChanged } from './systemProxy';

import type { Dispatcher } from 'undici';

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
  | 'socks_failed'
  | 'socks_unsupported';

export class EgressError extends Error {
  constructor(
    readonly reason: EgressReason,
    message: string,
    readonly proxy: string | null,
  ) {
    super(message);
    this.name = 'EgressError';
  }
}

/** The SOCKS listener speaks a handshake we cannot perform (SOCKS4/4a). */
export const SOCKS_UNSUPPORTED =
  'The system proxy is a SOCKS4 listener, which this app cannot speak. ' +
  'Switch your proxy client to SOCKS5 (or HTTP), or turn on TUN mode.';

/**
 * Normalise a WinINET / env proxy value into something the egress path can use.
 *
 * WinINET stores several shapes and they are all still in the wild:
 *   `127.0.0.1:8080`                       bare host:port, the usual
 *   `http=…;https=…`                       per-protocol, written by several clients
 *   `socks=127.0.0.1:10808`                v2rayN's default — SOCKS5
 *   `https=…;socks=…`                      mixed lists, one client serving both
 *   `socks5://host:1080`                   env-var form
 *
 * A mixed list is served by its HTTP entry — cloud calls are HTTPS, so an HTTP
 * listener carries them with no handshake at all. Only a SOCKS-only list falls
 * through to the SOCKS5 path, and the whole string is never treated as one
 * host: `socks=127.0.0.1:10808` is a scheme and an endpoint, not a hostname
 * containing an equals sign.
 *
 * Returns `null` when there is no proxy, and the `SOCKS_UNSUPPORTED` sentinel
 * for a SOCKS4 listener, so the caller reports it rather than connecting direct.
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
    const http = parts.get('https') ?? parts.get('http');
    if (http) return withScheme(http);
    for (const scheme of SOCKS_SCHEMES) {
      const server = parts.get(scheme);
      if (server) return socksUrl(scheme, server);
    }
    return null;
  }

  // `socks5://host:port` / `socks4://host:port`
  const urlMatch = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(value);
  if (urlMatch) {
    const scheme = (urlMatch[1] ?? '').toLowerCase();
    const server = urlMatch[2] ?? '';
    if (scheme === 'http' || scheme === 'https') return withScheme(value);
    if (scheme.startsWith('socks')) return socksUrl(scheme, server);
    return null;
  }

  // `socks:host:port` — scheme and endpoint, no `://`.
  const colonMatch = /^(socks[0-9a-z]*)\s*[:=]\s*(.+)$/i.exec(value);
  if (colonMatch) return socksUrl((colonMatch[1] ?? '').toLowerCase(), colonMatch[2] ?? '');

  return withScheme(value);
}

/** Scheme keys a Windows proxy list may use for a SOCKS listener. */
const SOCKS_SCHEMES = ['socks', 'socks5', 'socks5h', 'socks4', 'socks4a'] as const;

/**
 * A SOCKS5 endpoint, or the sentinel for a variant we cannot speak.
 *
 * SOCKS4/4a negotiate differently (no domain names, different handshake) and
 * are vanishingly rare — but reporting them by name beats the alternative,
 * which is connecting direct behind the user's back.
 */
function socksUrl(scheme: string, server: string): string | null | typeof SOCKS_UNSUPPORTED {
  const value = server.trim().replace(/^\/\//, '');
  if (value === '') return SOCKS_UNSUPPORTED;
  if (/^socks4/i.test(scheme)) return SOCKS_UNSUPPORTED;
  return `socks5://${value}`;
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

/** One dispatcher per proxy URL; undici pools connections per dispatcher. */
const agents = new Map<string, Dispatcher>();
function agentFor(proxy: string): Dispatcher {
  let agent = agents.get(proxy);
  if (!agent) {
    agent = /^socks5?:/i.test(proxy)
      ? new Agent({ connect: socksConnector(proxy) })
      : new ProxyAgent(proxy);
    agents.set(proxy, agent);
  }
  return agent;
}

/* ------------------------------ SOCKS5 ------------------------------------ */

/** A SOCKS5 listener that would not carry the connection. Named, not generic. */
export class SocksTunnelError extends Error {
  constructor(readonly detail: string) {
    super(`SOCKS5 tunnel failed: ${detail}`);
    this.name = 'SocksTunnelError';
  }
}

/** Bytes a SOCKS5 reply occupies after the two-byte version/reply prefix. */
function replyLength(buf: Buffer): number | null {
  if (buf.length < 4) return null;
  switch (buf[3]) {
    case 0x01:
      return 10; // IPv4 + port
    case 0x04:
      return 22; // IPv6 + port
    case 0x03:
      return buf.length >= 5 ? 7 + (buf[4] ?? 0) : null; // domain + port
    default:
      return -1; // address type we do not know
  }
}

/**
 * Open a TCP tunnel to `host:port` through a SOCKS5 proxy (RFC 1928): greeting
 * with "no authentication", then CONNECT. Only the "no auth" method is
 * offered, because every client these users run — v2rayN, Clash, Xray — serves
 * it; a listener demanding credentials fails loudly instead of hanging.
 */
/** Credentials for a SOCKS listener that authenticates (RFC 1929). */
export interface SocksCredentials {
  username: string;
  password: string;
}

function socksTunnel(
  proxyHost: string,
  proxyPort: number,
  host: string,
  port: number,
  credentials: SocksCredentials | null,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    let stage: 'greeting' | 'auth' | 'reply' = 'greeting';
    let buf: Buffer = Buffer.alloc(0);
    let settled = false;

    const fail = (detail: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new SocksTunnelError(detail));
    };
    const succeed = (leftover: Buffer): void => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', fail);
      // Bytes the proxy already sent past the reply belong to the TLS
      // handshake that starts next; dropping them would hang the connection.
      socket.pause();
      if (leftover.length > 0) socket.unshift(leftover);
      resolve(socket);
    };

    function sendConnect(): void {
      stage = 'reply';
      const name = Buffer.from(host, 'utf8');
      socket.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
          name,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]),
      );
    }

    function onData(chunk: Buffer): void {
      buf = Buffer.concat([buf, chunk]);

      if (stage === 'greeting') {
        if (buf.length < 2) return;
        const method = buf[1] ?? 0;
        if (buf[0] !== 0x05) {
          fail(`it is not a SOCKS5 listener (reply 0x${method.toString(16)})`);
          return;
        }
        if (method === 0x00) {
          buf = buf.subarray(2);
          sendConnect();
          return;
        }
        if (method === 0xff) {
          // A listener that requires auth answers 0xFF when we offered none.
          // That is the ordinary v2rayN-with-a-password case, so say so.
          fail(
            credentials
              ? 'it refused every authentication method we offered'
              : 'it requires a password, and the Windows system-proxy setting cannot carry one. ' +
                  'Turn off SOCKS authentication in your proxy client, or use an HTTP proxy or TUN mode',
          );
          return;
        }
        if (method !== 0x02) {
          fail(`it demands an authentication method we do not offer (reply 0x${method.toString(16)})`);
          return;
        }
        // Username/password (RFC 1929). Credentials reach us only through the
        // proxy URL — the Windows system-proxy setting is host:port and cannot
        // carry one — so say THAT, not "restart your client".
        if (!credentials) {
          fail(
            'it requires a password, and the Windows system-proxy setting cannot carry one. ' +
              'Turn off SOCKS authentication in your proxy client, or use an HTTP proxy or TUN mode',
          );
          return;
        }
        stage = 'auth';
        buf = buf.subarray(2);
        const user = Buffer.from(credentials.username.slice(0, 255), 'utf8');
        const pass = Buffer.from(credentials.password.slice(0, 255), 'utf8');
        socket.write(
          Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]),
        );
      }

      if (stage === 'auth') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x01 || buf[1] !== 0x00) {
          const who = credentials ? `"${credentials.username}"` : 'the supplied credentials';
          fail(`it rejected ${who} (status 0x${(buf[1] ?? 0).toString(16).padStart(2, '0')})`);
          return;
        }
        buf = buf.subarray(2);
        sendConnect();
      }

      if (stage !== 'reply') return;
      const total = replyLength(buf);
      if (total === null) return;
      if (total === -1) {
        fail('the listener sent a malformed reply');
        return;
      }
      if (buf.length < total) return;
      const reply = buf[1] ?? 0;
      if (reply !== 0x00) {
        fail(`the listener refused the tunnel (SOCKS5 reply 0x${reply.toString(16).padStart(2, '0')})`);
        return;
      }
      succeed(buf.subarray(total));
    }

    socket.on('data', onData);
    socket.once('error', (err: NodeJS.ErrnoException) => fail(`the connection failed (${err.message})`));
    socket.once('connect', () => {
      // Greeting: SOCKS5 offering "no authentication" and, when we have them,
      // username/password.
      socket.write(credentials ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
    });
  });
}

/**
 * A connector undici can use instead of its own.
 *
 * undici applies NO TLS of its own once a connector is supplied — it writes to
 * whatever socket comes back — so for https the tunnel is wrapped in TLS here,
 * with the servername the request used. Getting this wrong yields a socket the
 * HTTP parser cannot read, which is why the TLS step lives in this function
 * rather than being assumed.
 */
/** The fields undici hands a connector; all optional so its own type fits. */
interface ConnectorOptions {
  host?: string;
  hostname?: string;
  protocol?: string;
  port?: number | string;
  servername?: string | null;
  localAddress?: string | null;
}

/**
 * undici's connector callback shape, mirrored locally: undici does not export
 * it, and a success carries the socket while a failure carries no socket at all.
 */
type ConnectorCallback = (...args: [null, net.Socket | tls.TLSSocket] | [Error, null]) => void;

/**
 * The port to ask the SOCKS listener for.
 *
 * undici hands the connector the port from the parsed URL, which is an EMPTY
 * STRING when the URL names no port — and `Number('') === 0`, which produced a
 * tunnel request for port 0 and a silent hang until the request timed out. The
 * default comes from the protocol, the way a browser does it.
 */
export function socksTargetPort(port: number | string | null | undefined, protocol: string): number {
  const parsed = Number(port);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return protocol === 'http:' ? 80 : 443;
}

export function socksConnector(proxy: string): (opts: ConnectorOptions, cb: ConnectorCallback) => void {
  let endpoint: URL;
  try {
    endpoint = new URL(proxy);
  } catch {
    throw new Error(`invalid SOCKS proxy url: ${proxy}`);
  }
  const proxyPort = Number(endpoint.port || 1080);
  const proxyHost = endpoint.hostname.replace(/^\[|\]$/g, '');

  return (opts, callback) => {
    const hostname = opts.hostname ?? opts.host ?? '';
    const protocol = opts.protocol ?? 'https:';
    const port = socksTargetPort(opts.port, protocol);
    const servername = opts.servername ?? null;
    let done = false;
    const finish = (err: Error | null, socket?: net.Socket): void => {
      if (done) return;
      done = true;
      if (err) callback(...([err, null] as [Error, null]));
      else callback(...([null, socket as net.Socket] as [null, net.Socket]));
    };

    const credentials =
      endpoint.username || endpoint.password
        ? { username: decodeURIComponent(endpoint.username), password: decodeURIComponent(endpoint.password) }
        : null;

    socksTunnel(proxyHost, proxyPort, hostname, port, credentials).then((socket) => {
      if (protocol !== 'https:') return finish(null, socket);
      const secure = tls.connect({
        socket,
        servername: servername || hostname,
        host: hostname,
        port,
        ALPNProtocols: ['http/1.1'],
      });
      secure.once('secureConnect', () => finish(null, secure));
      secure.once('error', (err: Error) => finish(err));
    }, (err: Error) => finish(err));
  };
}

/**
 * undici nests transport errors — `fetch` rejects with a TypeError whose cause
 * holds the real one — so the error worth naming can be several links down.
 */
function findSocksError(err: unknown): SocksTunnelError | null {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 5; depth++) {
    if (current instanceof SocksTunnelError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Turn a thrown transport error into the reason a user can act on. */
export function classify(err: unknown, proxy: string | null): EgressError {
  const e = err as { name?: string; message?: string; cause?: { code?: string }; code?: string };
  const code = e?.cause?.code ?? e?.code ?? '';
  const name = e?.name ?? '';

  // A SOCKS listener we reached but could not use is its own failure mode: it
  // is not "unreachable", and it is not filtering. Say which listener and why.
  const socks = findSocksError(err);
  if (socks) {
    return new EgressError(
      'socks_failed',
      `The SOCKS proxy at ${proxy} could not carry the connection: ${socks.detail}.`,
      proxy,
    );
  }

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