/**
 * Proxy tunnel — route the system through a tested public node (Aether-style).
 *
 * The app already *tests* nodes by spawning a local core (xray / sing-box /
 * v2ray) with an ephemeral HTTP inbound; this service keeps that core alive as
 * a long-lived tunnel and can optionally point the OS at it. Everything is
 * verified honestly:
 *
 *   - the tunnel is only reported `active` after traffic has PROVABLY
 *     traversed the node (an HTTPS request through the CONNECT inbound)
 *   - the exit IP is read from the node's own view of the world
 *     (https://www.cloudflare.com/cdn-cgi/trace → ip=), never asserted
 *   - a stop always kills the core process, deletes the temp config, and
 *     (if set) restores the previous system proxy — even on failure paths
 *   - crash detection: the core's 'close' event flips state to `down` and
 *     publishes a realtime event; a bounded auto-reconnect (default 3 tries,
 *     backoff) re-establishes it when enabled
 *
 * Only ONE tunnel runs at a time — starting a new one stops the old core.
 */
import http from 'node:http';

import { type ParsedNodeConfig, type ProxyEngineId } from '@netpulse/shared';

import type { NodeSecretVault } from './nodeSecretVault';
import { findEngineBinary, startCore, type CoreRun } from './proxyCores';

/** Long-lived core handle (vs the probe's start-and-kill cycle). */
interface TunnelCore {
  engine: ProxyEngineId;
  run: CoreRun;
}

export type TunnelState = 'idle' | 'starting' | 'active' | 'down' | 'stopping';

export interface TunnelStatus {
  state: TunnelState;
  nodeId: string | null;
  engine: ProxyEngineId | null;
  /** loopback HTTP proxy port apps can be pointed at */
  inboundPort: number | null;
  /** OS system proxy routed through the tunnel? */
  systemProxy: boolean;
  /** system proxy restored to this value after disconnect (null = was direct) */
  previousProxy: string | null;
  /** verified by reading ip= from a trace fetched THROUGH the tunnel */
  exitIp: string | null;
  exitCountry: string | null;
  verifiedAt: number | null;
  startedAt: number | null;
  error: string | null;
}

const IDLE: TunnelStatus = {
  state: 'idle',
  nodeId: null,
  engine: null,
  inboundPort: null,
  systemProxy: false,
  previousProxy: null,
  exitIp: null,
  exitCountry: null,
  verifiedAt: null,
  startedAt: null,
  error: null,
};

export interface TunnelDeps {
  nodeVault: NodeSecretVault | null;
  /** GET https://.../cdn-cgi/trace through an HTTP proxy port; returns the body */
  fetchThroughPort(port: number, url: string, timeoutMs: number): Promise<string>;
  setSystemProxy(proxyOrNull: string | null): Promise<{ ok: boolean; error?: string }>;
  getSystemProxy(): Promise<{ proxy: string | null }>;
  publish(kind: string, payload: Record<string, unknown>): void;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  /** seams for tests — default to the real core lifecycle */
  findBinary?(id: ProxyEngineId): string | null;
  startCoreFn?(engine: { id: ProxyEngineId; bin: string; args: string[] }, config: ParsedNodeConfig, secret: string | null, readyTimeoutMs: number): ReturnType<typeof startCore>;
}

const RESTART_BASE_MS = 1_500;
const RESTART_MAX_TRIES = 3;

/**
 * Minimal node fields the tunnel needs — structurally satisfied by both the
 * public-node DB row (alpn: string[]) and ParsedNodeConfig.
 */
export interface TunnelNodeInput {
  id: string;
  protocol: string;
  host: string;
  port: number;
  transport: string | null;
  security: string | null;
  sni: string | null;
  alpn: string[] | string | null;
  fingerprint: string | null;
  flow: string | null;
  alterId: number | null;
  path: string | null;
  hostHeader: string | null;
  serviceName: string | null;
  allowInsecure: boolean | null;
  encryption: string | null;
  ssrProtocol: string | null;
  realityPublicKey: string | null;
  realityShortId: string | null;
  realityServerName: string | null;
  remark: string | null;
}

export class ProxyTunnelService {
  private status: TunnelStatus = { ...IDLE };
  private core: TunnelCore | null = null;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  /** serialized start/stop so rapid toggles can't interleave */
  private transition: Promise<void> = Promise.resolve();
  /** bumped by stop() so a queued restart's start() aborts instead of resurrecting */
  private stopGeneration = 0;

  constructor(private readonly deps: TunnelDeps) {}

  getStatus(): TunnelStatus {
    return { ...this.status };
  }

  /**
   * Start (or restart onto) a node tunnel. `node` carries the same normalized
   * fields the probe path uses; the secret comes from the at-rest vault — a
   * node without a stored secret can still tunnel if its protocol is
   * unauthenticated (ss with none cipher, plain vmess...), so we pass null
   * through and let the core decide, but we RECORD that honestly in `error`
   * when the core rejects it.
   */
  async start(node: TunnelNodeInput, opts: { systemProxy: boolean; preferredEngine: 'auto' | ProxyEngineId }): Promise<TunnelStatus> {
    const myGeneration = this.stopGeneration;
    const prev = this.transition;
    let done!: () => void;
    this.transition = new Promise<void>((res) => { done = res; });
    await prev.catch(() => {});
    // A stop() that queued behind us (or ahead of us) must win: if the
    // generation moved while we waited, this start is stale — drop it.
    if (myGeneration !== this.stopGeneration) {
      done();
      return this.getStatus();
    }
    try {
      return await this.startInner(node, opts);
    } finally {
      done();
    }
  }

  private async startInner(node: TunnelNodeInput, opts: { systemProxy: boolean; preferredEngine: 'auto' | ProxyEngineId }): Promise<TunnelStatus> {
    // Teardown any existing tunnel first (single-tunnel invariant).
    await this.stopInner({ keepStatus: true });

    this.status = {
      ...IDLE,
      state: 'starting',
      nodeId: node.id,
      error: null,
    };
    this.deps.publish('tunnel:starting', { nodeId: node.id });

    // 1) Resolve config + secret exactly like the test path.
    const config: ParsedNodeConfig = {
      protocol: node.protocol as ParsedNodeConfig['protocol'],
      host: node.host,
      port: node.port,
      transport: (node.transport ?? 'tcp') as ParsedNodeConfig['transport'],
      security: (node.security ?? 'none') as ParsedNodeConfig['security'],
      sni: node.sni,
      alpn: Array.isArray(node.alpn) ? node.alpn : node.alpn ? [node.alpn] : null,
      fingerprint: node.fingerprint,
      flow: node.flow,
      alterId: node.alterId,
      path: node.path,
      hostHeader: node.hostHeader,
      serviceName: node.serviceName,
      allowInsecure: node.allowInsecure === true,
      encryption: node.encryption,
      ssrProtocol: node.ssrProtocol,
    realityPublicKey: node.realityPublicKey,
    realityShortId: node.realityShortId,
    realityServerName: node.realityServerName,
    vmessSecurity: node.encryption,
    extra: (node as unknown as { extra?: Record<string, unknown> | null }).extra ?? null,
    remark: node.remark,
  };
    const secret = this.deps.nodeVault?.get(node.id) ?? null;

    // 2) Engine choice: preference first, then any installed core (same
    //    capability matrix as the probe — protocol must be supported).
    const engine = this.pickEngine(config.protocol, opts.preferredEngine);
    if (!engine) {
      this.status = { ...this.status, state: 'down', error: 'no installed proxy core supports this protocol' };
      this.deps.publish('tunnel:error', { nodeId: node.id, error: this.status.error });
      return this.getStatus();
    }

    // 3) Start the core with a LONG-LIVED readiness budget (the probe allows
    //    5s; remote handshakes on cold networks can be slower).
    const bin = (this.deps.findBinary ?? findEngineBinary)(engine);
    if (!bin) {
      this.status = { ...this.status, state: 'down', error: `${engine} binary not found` };
      return this.getStatus();
    }
    const startFn = this.deps.startCoreFn ?? startCore;
    const started = await startFn({ id: engine, bin, args: ['run'] }, config, secret, 10_000);
    if (!started.ok) {
      this.status = { ...this.status, state: 'down', error: `${engine}: ${started.error}` };
      this.deps.publish('tunnel:error', { nodeId: node.id, error: this.status.error });
      return this.getStatus();
    }

    this.core = { engine, run: started.run };
    // Crash watcher: any core exit while we think the tunnel is up = down.
    started.run.child.once('close', (code) => {
      if (this.stopping || this.core?.run !== started.run) return;
      this.core = null;
      this.status = { ...this.status, state: 'down', error: `core exited unexpectedly (code ${code ?? '?'})` };
      this.deps.publish('tunnel:down', { nodeId: node.id, reason: 'core_exit' });
      void this.scheduleRestart(node, opts);
    });

    this.status = {
      ...this.status,
      state: 'active',
      engine,
      inboundPort: started.run.inboundPort,
      startedAt: Date.now(),
    };

    // 4) Verify by fetching a real trace THROUGH the tunnel (not a TCP check —
    //    that would light "active" for a core that cannot actually relay).
    try {
      const trace = await this.deps.fetchThroughPort(started.run.inboundPort, 'https://www.cloudflare.com/cdn-cgi/trace', 12_000);
      const ip = trace.match(/^ip=(.+)$/m)?.[1]?.trim() ?? null;
      const loc = trace.match(/^loc=(.+)$/m)?.[1]?.trim() ?? null;
      if (!ip) throw new Error('trace did not contain an ip= line');
      this.status = { ...this.status, exitIp: ip, exitCountry: loc, verifiedAt: Date.now(), error: null };
      this.deps.publish('tunnel:active', { nodeId: node.id, engine, exitIp: ip, exitCountry: loc });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The core started but cannot relay — that is a dead tunnel; be honest.
      this.status = { ...this.status, state: 'down', error: `started but verification failed: ${msg}` };
      this.deps.publish('tunnel:error', { nodeId: node.id, error: this.status.error });
      this.killCore();
      // We never reached the handoff step, so there is nothing of ours to
      // restore — do NOT write null blindly or we would wipe a proxy the user
      // had configured before this attempt.
      return this.getStatus();
    }

    // 5) Optionally route the OS through the tunnel.
    if (opts.systemProxy) {
      try {
        const prevProxy = await this.deps.getSystemProxy();
        const set = await this.deps.setSystemProxy(`127.0.0.1:${started.run.inboundPort}`);
        if (set.ok) {
          this.status = { ...this.status, systemProxy: true, previousProxy: prevProxy.proxy };
        } else {
          this.status = { ...this.status, systemProxy: false, error: `system proxy: ${set.error ?? 'failed'}` };
        }
      } catch (err) {
        this.status = { ...this.status, systemProxy: false, error: `system proxy: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    this.restarts = 0;
    return this.getStatus();
  }

  async stop(): Promise<TunnelStatus> {
    const prev = this.transition;
    let done!: () => void;
    this.transition = new Promise<void>((res) => { done = res; });
    await prev.catch(() => {});
    try {
      return await this.stopInner({ keepStatus: false });
    } finally {
      done();
    }
  }

  private async stopInner(o: { keepStatus: boolean }): Promise<TunnelStatus> {
    this.stopping = true;
    this.stopGeneration += 1;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const wasNodeId = this.status.nodeId;

    if (this.status.systemProxy) {
      try {
        await this.deps.setSystemProxy(this.status.previousProxy);
      } catch (err) {
        this.deps.log.warn(`tunnel: failed to restore system proxy: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.killCore();

    if (!o.keepStatus) {
      this.status = { ...IDLE };
      if (wasNodeId) this.deps.publish('tunnel:stopped', { nodeId: wasNodeId });
    }
    this.stopping = false;
    return this.getStatus();
  }

  private killCore(): void {
    if (this.core) {
      try { this.core.run.cleanup(); } catch { /* idempotent */ }
      this.core = null;
    }
  }

  /** Bounded auto-reconnect after a core crash. */
  private scheduleRestart(node: TunnelNodeInput, opts: { systemProxy: boolean; preferredEngine: 'auto' | ProxyEngineId }): void {
    if (this.stopping) return;
    if (this.restarts >= RESTART_MAX_TRIES) {
      this.deps.publish('tunnel:error', { nodeId: node.id, error: `gave up after ${RESTART_MAX_TRIES} reconnect attempts` });
      return;
    }
    this.restarts += 1;
    const delay = RESTART_BASE_MS * 2 ** (this.restarts - 1);
    const myGeneration = this.stopGeneration;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping || this.status.state === 'active') return;
      void this.start(node, opts).then((s) => {
        // start() is a no-op if a stop() superseded us (generation moved);
        // state will be idle — do not reschedule from a dead restart chain.
        if (this.stopGeneration !== myGeneration) return;
        if (s.state === 'down' && !s.error?.includes('gave up')) return this.scheduleRestart(node, opts);
      });
    }, delay);
  }

  private pickEngine(protocol: string, preferred: 'auto' | ProxyEngineId): ProxyEngineId | null {
    const find = this.deps.findBinary ?? findEngineBinary;
    const SUPPORTS: Record<ProxyEngineId, RegExp> = {
      'xray': /^(vless|vmess|trojan|shadowsocks)$/i,
      'sing-box': /^(vless|vmess|trojan|shadowsocks|hysteria2|tuic)$/i,
      'v2ray': /^(vless|vmess|trojan|shadowsocks)$/i,
    };
    const order: ProxyEngineId[] = preferred === 'auto' ? ['xray', 'sing-box', 'v2ray'] : [preferred, ...(['xray', 'sing-box', 'v2ray'] as const).filter((e) => e !== preferred)];
    return order.find((e) => find(e) !== null && SUPPORTS[e].test(protocol)) ?? null;
  }
}

/**
 * GET a URL through a loopback HTTP proxy port (the core's inbound) and
 * return the body — used for exit-IP verification. Node-fetch does not honor
 * a per-call proxy, so this is a hand-rolled CONNECT + GET, same as the probe
 * but returning the full body instead of just timing.
 */
export function fetchThroughHttpProxy(port: number, url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      timeout: timeoutMs,
      setHost: false,
    });
    req.on('connect', (_res, socket) => {
      if (_res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT rejected: ${_res.statusCode}`));
        return;
      }
      // TLS through the tunnel, then plain GET (reuse tls lazily to keep the import light).
      void import('node:tls')
        .then((tls) => {
          const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
            tlsSocket.write(
              `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.hostname}\r\nUser-Agent: NetPulse-Tunnel/1.0\r\nConnection: close\r\n\r\n`,
            );
            let raw = '';
            let settled = false;
            const finishOk = () => {
              if (settled) return;
              settled = true;
              tlsSocket.destroy();
              socket.destroy();
              resolve(stripChunked(raw));
            };
            const finishErr = (err: Error) => {
              if (settled) return;
              settled = true;
              tlsSocket.destroy();
              socket.destroy();
              reject(err);
            };
            tlsSocket.on('data', (d: Buffer) => { raw += d.toString('latin1'); });
            tlsSocket.on('end', finishOk);
            // A body stall after the headers must not hang past the budget.
            tlsSocket.setTimeout(timeoutMs, () => finishErr(new Error('trace fetch timed out')));
            tlsSocket.on('error', finishErr);
            tlsSocket.on('close', () => { if (!settled) finishOk(); });
          });
          tlsSocket.setTimeout(timeoutMs, () => { tlsSocket.destroy(); socket.destroy(); reject(new Error('TLS handshake through proxy timed out')); });
          tlsSocket.on('error', reject);
        })
        .catch((err: Error) => {
          // Dynamic import failed (never in practice) — the CONNECT socket is
          // still open and would leak.
          socket.destroy();
          reject(err);
        });
    });
    req.on('timeout', () => { req.destroy(new Error('CONNECT timed out')); });
    req.on('error', reject);
    req.end();
  });
}

/** Minimal de-chunk + body extraction (trace bodies are tiny; no gzip). Exported for tests. */
export function stripChunked(raw: string): string {
  const split = raw.indexOf('\r\n\r\n');
  if (split < 0) return raw;
  const head = raw.slice(0, split).toLowerCase();
  let body = raw.slice(split + 4);
  if (head.includes('transfer-encoding: chunked')) {
    const lines = body.split('\r\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += 2) {
      const size = parseInt(lines[i] ?? '', 16);
      if (!Number.isFinite(size) || size === 0) break;
      out.push((lines[i + 1] ?? '').slice(0, size));
    }
    body = out.join('');
  }
  return body;
}
