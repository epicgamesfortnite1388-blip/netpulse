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
 * NESTED MODE chains TWO local cores so the observed exit address is not the
 * entry edge: the entry core carries the node the user picked for the edge, and
 * the exit core dials ITS node *through* the entry core (`dialerProxy` /
 * `detour`), so traffic is local → entry node → exit node → internet. Both hops
 * are verified separately — the entry's own exit IP is read through the entry
 * core alone, then the final exit IP through the exit core — and the two are
 * compared, so "the exit differs from the entry edge" is an observation the
 * status reports (and can report as false) rather than a claim.
 *
 * Only ONE tunnel runs at a time — starting a new one stops the old cores.
 */
import http from 'node:http';

import {
  bypassIsEmpty,
  bypassSummary,
  type BypassRuleSet,
  type GatewaySuccessInput,
  type ParsedNodeConfig,
  type ProxyEngineId,
  type ProxyTunnelStatus,
  type TunnelChain,
  type TunnelHop,
  type TunnelSource,
} from '@netpulse/shared';

import {
  PROXY_ENGINE_ORDER,
  chainExitProtocolUnsupported,
  chainExitUnsupported,
  engineArgs,
  engineSupports,
  engineSupportsConfig,
  engineSupportsOptions,
  findEngineBinary,
  startCore,
  tunRouteExclusions,
  type CoreRun,
  type DnsThroughTunnel,
} from './proxyCores';
import { TunGatewayHandle, type TunGatewayEvent } from './tunGatewayHandle';

import type { NodeSecretVault } from './nodeSecretVault';

/** Long-lived core handle (vs the probe's start-and-kill cycle). */
interface TunnelCore {
  engine: ProxyEngineId;
  run: CoreRun;
}

export type TunnelStatus = ProxyTunnelStatus;
export type TunnelState = ProxyTunnelStatus['state'];

/**
 * Exit-IP trace endpoint — the node's own view of the world. Exported because
 * every path that proves an exit address (hop checks, and Aether's TUN relay
 * proof) must ask the SAME question; two URLs would be two different truths.
 */
export const EXIT_TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

const IDLE: TunnelStatus = {
  state: 'idle',
  nodeId: null,
  nodeName: null,
  engine: null,
  inboundPort: null,
  systemProxy: false,
  previousProxy: null,
  exitIp: null,
  exitCountry: null,
  verifiedAt: null,
  startedAt: null,
  error: null,
  reconnectAttempts: 0,
  reconnectLimit: 0,
  source: null,
  bypass: null,
  chain: null,
};

/**
 * The slice of the kill switch this service uses. Declared structurally so the
 * tunnel stays unit-testable without constructing the real service.
 */
export interface KillSwitchHandle {
  /** Persist the hold before the system proxy write (crash-safe ordering). */
  preArm(input: { previousProxy: string | null; label: string }): void;
  /** Claim the hold once the capture is verified (proxy write, or TUN active). */
  arm(input: { previousProxy: string | null; label: string; mode?: 'proxy' | 'route' }): unknown;
  /** Drop a hold that was never armed (the proxy write failed). */
  release(reason: string): Promise<unknown>;
  onTunnelDropped(reason: string): Promise<unknown>;
  onTunnelStopped(): Promise<unknown>;
}

export interface TunnelDeps {
  nodeVault: NodeSecretVault | null;
  /** GET https://.../cdn-cgi/trace through an HTTP proxy port; returns the body */
  fetchThroughPort(port: number, url: string, timeoutMs: number): Promise<string>;
  setSystemProxy(proxyOrNull: string | null): Promise<{ ok: boolean; error?: string }>;
  getSystemProxy(): Promise<{ proxy: string | null }>;
  publish(kind: string, payload: Record<string, unknown>): void;
  /**
   * Kill switch — owns what happens to the system proxy when this tunnel
   * drops. Structurally typed (not an import) so the two stay independently
   * testable; optional so existing callers/tests keep working.
   */
  killSwitch?: KillSwitchHandle;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  /**
   * Called ONLY after a tunnel has been verified by traffic through the node,
   * so gateway memory can never hold an unproven entry.
   */
  onVerifiedGateway?(input: GatewaySuccessInput): void;
  /** Called when a verified gateway later fails verification (demote it). */
  onGatewayFailed?(nodeId: string): void;
  /** seams for tests — default to the real core lifecycle */
  findBinary?(id: ProxyEngineId): string | null;
  startCoreFn?(
    engine: { id: ProxyEngineId; bin: string; args: string[] },
    config: ParsedNodeConfig,
    secret: string | null,
    readyTimeoutMs: number,
    opts?: { bypass?: BypassRuleSet | null; dialThroughPort?: number | null; dns?: DnsThroughTunnel | null },
  ): ReturnType<typeof startCore>;
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

/** What the service was asked to keep up — what reconnect restores. */
type StartTarget =
  | { kind: 'single'; node: TunnelNodeInput }
  | { kind: 'nested'; entry: TunnelNodeInput; exit: TunnelNodeInput };

interface StartOpts {
  systemProxy: boolean;
  preferredEngine: 'auto' | ProxyEngineId;
  bypass?: BypassRuleSet | null;
  /** Resolve DNS inside the core through the node outbound (dnsThroughVpn). */
  dns?: DnsThroughTunnel | null;
  source?: TunnelSource;
  /**
   * TUN mode: put a sing-box TUN gateway in front of the engine hop(s) so
   * system-wide traffic (not just proxy-aware apps) rides the tunnel. Proxy
   * handoff is skipped when TUN is verified — a TUN default route already
   * captures everything, and both at once double-captures.
   */
  tun?: boolean;
}

/** Which hop of a chain a core is running. */
type HopRole = { kind: 'single' } | { kind: 'entry' } | { kind: 'exit'; entryPort: number };

/** What a core must be able to honour for one hop (see engineSupportsOptions). */
interface EngineOptions {
  bypass: boolean;
  dns: boolean;
  chain: boolean;
}

type HopStart =
  | { ok: true; engine: ProxyEngineId; run: CoreRun }
  | { ok: false; error: string };

/** `ip=` / `loc=` from a Cloudflare trace body; null when absent. Exported for tests. */
export function traceField(body: string, field: 'ip' | 'loc'): string | null {
  return body.match(new RegExp(`^${field}=(.+)$`, 'm'))?.[1]?.trim() ?? null;
}

/**
 * The nested-mode verdict. `exitDiffers` is false whenever either hop reported
 * no address OR both observed the same one — never assume a difference.
 * Exported for tests.
 */
export function chainRecord(entry: TunnelHop, exit: TunnelHop): TunnelChain {
  const exitDiffers = Boolean(entry.exitIp && exit.exitIp && entry.exitIp !== exit.exitIp);
  const note = !entry.exitIp || !exit.exitIp
    ? 'One hop reported no exit IP, so the chain could not be compared.'
    : exitDiffers
      ? `Exit differs from the entry edge: entry ${entry.exitIp} → exit ${exit.exitIp}.`
      : `Exit address is identical to the entry edge (${exit.exitIp}) — this pair does not change your observed address.`;
  return { mode: 'nested', hops: [entry, exit], entryExitIp: entry.exitIp, exitIp: exit.exitIp, exitDiffers, note };
}

export class ProxyTunnelService {
  private status: TunnelStatus = { ...IDLE };
  /** Every core this tunnel owns — a single hop has one, nested mode has two. */
  private cores: TunnelCore[] = [];
  private target: StartTarget | null = null;
  private targetOpts: StartOpts | null = null;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  /** serialized start/stop so rapid toggles can't interleave */
  private transition: Promise<void> = Promise.resolve();
  /** bumped by stop() so a queued restart's start() aborts instead of resurrecting */
  private stopGeneration = 0;
  /** DNS-through-tunnel wiring captured from the most recent start options. */
  private dns: DnsThroughTunnel | null = null;
  /**
   * TUN mode: the shared gateway state machine (see TunGatewayHandle). This
   * service supplies the tunnel-specific wiring — what to front, what to keep
   * out of the route, who to notify — and mirrors its transitions into
   * `status`; every honesty rule (verify, tear down on failure, fail closed on
   * a drop) lives in the handle, shared with Aether's TUN path.
   */
  private readonly tun: TunGatewayHandle;

  constructor(private readonly deps: TunnelDeps) {
    this.tun = new TunGatewayHandle(
      {
        upstream: 'http',
        upstreamPort: () => this.status.inboundPort,
        bypass: () => this.targetOpts?.bypass ?? null,
        // The device takes the default route, so the hop's OWN dial to the node
        // must be excluded from it — otherwise that dial re-enters the gateway,
        // which forwards it back to the hop, relaying nothing. In a chain only
        // the ENTRY hop dials a real address (the exit hop dials loopback
        // through the entry), so the exit host must NOT be excluded: excluding
        // it would open a hole where direct traffic to the exit node's IP
        // bypasses the tunnel entirely.
        excludeAddresses: async () =>
          tunRouteExclusions(
            this.target == null
              ? []
              : this.target.kind === 'nested'
                ? [this.target.entry.host]
                : [this.target.node.host],
          ),
        label: () => this.tunLabel(),
        armRouteMode: async () => {
          // Route mode: the gateway owns the default route and the system proxy
          // was NOT touched, so without this hold a crash would withdraw the
          // TUN routes and traffic would silently fall back to direct.
          try {
            const prev = await this.deps.getSystemProxy();
            this.deps.killSwitch?.arm({ previousProxy: prev.proxy, label: this.tunLabel(), mode: 'route' });
          } catch (err) {
            // The capture is real; only the fail-closed hold failed, and the
            // kill switch's own status reports that.
            this.deps.log.warn(`kill switch could not be armed in route mode: ${message(err)}`);
          }
        },
        onCapturedDrop: (reason) => {
          void this.deps.killSwitch?.onTunnelDropped(reason).catch(() => undefined);
        },
        onState: (event) => this.onTunState(event),
      },
      // The relay proof runs through this service's own fetch seam, so a test
      // (or a future transport swap) keeps holding that lever.
      {
        verifyRelay: async (port) => traceField(await this.deps.fetchThroughPort(port, EXIT_TRACE_URL, 15_000), 'ip'),
      },
    );
  }

  /** Kill-switch hold label for the current tunnel. */
  private tunLabel(): string {
    return this.status.nodeName ?? this.status.nodeId ?? 'proxy tunnel';
  }

  /**
   * Mirror a TUN transition into this service's status and publish it. The
   * handle is the source of truth; nothing here decides state.
   */
  private onTunState(event: TunGatewayEvent): void {
    this.status = { ...this.status, ...this.tun.status() };
    const nodeId = this.status.nodeId;
    if (event.kind === 'active') {
      this.deps.publish('tunnel:tun_active', { nodeId, exitIp: event.exitIp });
      return;
    }
    if (event.kind === 'degraded') {
      // A lost capture has no diagnosed cause, so it must not claim one.
      this.deps.publish(
        'tunnel:tun_degraded',
        event.blockedBy ? { nodeId, error: event.error, blockedBy: event.blockedBy } : { nodeId, error: event.error },
      );
    }
  }

  getStatus(): TunnelStatus {
    return { ...this.status };
  }

  /**
   * Start (or restart onto) a single-node tunnel.
   */
  async start(node: TunnelNodeInput, opts: StartOpts): Promise<TunnelStatus> {
    this.dns = opts.dns ?? null;
    return this.enqueue(() => this.startTarget({ kind: 'single', node }, opts));
  }

  /**
   * NESTED mode: two cores chained, so the exit address differs from the entry
   * edge. `entry` carries the connection out of this machine; `exit` dials its
   * node through the entry core.
   */
  async startNested(pair: { entry: TunnelNodeInput; exit: TunnelNodeInput }, opts: StartOpts): Promise<TunnelStatus> {
    this.dns = opts.dns ?? null;
    return this.enqueue(() => this.startTarget({ kind: 'nested', entry: pair.entry, exit: pair.exit }, opts));
  }

  /** Re-establish whatever target is currently requested (used by reconnect). */
  async restartStored(): Promise<TunnelStatus> {
    const target = this.target;
    const opts = this.targetOpts;
    if (!target || !opts) return this.getStatus();
    return this.enqueue(() => this.startTarget(target, opts));
  }

  /** Serialize a transition; a stop() that superseded it wins. */
  private async enqueue(fn: () => Promise<TunnelStatus>): Promise<TunnelStatus> {
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
      return await fn();
    } finally {
      done();
    }
  }

  private async startTarget(target: StartTarget, opts: StartOpts): Promise<TunnelStatus> {
    // Teardown any existing tunnel first (single-tunnel invariant).
    await this.stopInner({ keepStatus: true });

    const nested = target.kind === 'nested';
    const entryNode = target.kind === 'nested' ? target.entry : null;
    const exitNode = target.kind === 'nested' ? target.exit : target.node;

    this.target = target;
    this.targetOpts = opts;
    const bypass = opts.bypass && !bypassIsEmpty(opts.bypass) ? opts.bypass : null;
    this.status = {
      ...IDLE,
      state: 'starting',
      nodeId: exitNode.id,
      nodeName: exitNode.remark ?? null,
      source: opts.source ?? 'explicit',
      bypass: bypass ? bypassSummary(bypass) : null,
      error: null,
    };
    // Refuse a hop that cannot be started BEFORE spawning anything: a chain
    // that would immediately unwind must not leave a stray core behind.
    // Options are known here (bypass and DNS are resolved above), so the
    // preflight answers the same question startHop will ask.
    const preflightOptions: EngineOptions = {
      bypass: bypass != null,
      dns: this.dns != null,
      chain: false,
    };
    const entryBar = entryNode ? this.preflight(toParsedConfig(entryNode), opts.preferredEngine, { kind: 'entry' }, preflightOptions) : null;
    const exitBar = this.preflight(
      toParsedConfig(exitNode),
      opts.preferredEngine,
      nested ? { kind: 'exit', entryPort: -1 } : { kind: 'single' },
      nested ? { ...preflightOptions, chain: true } : preflightOptions,
    );
    if (entryBar || exitBar) {
      this.fail(entryBar ? `entry hop — ${entryBar}` : nested ? `exit hop — ${exitBar}` : exitBar!, exitNode.id);
      return this.getStatus();
    }
    this.deps.publish('tunnel:starting', { nodeId: exitNode.id, nested });

    // 1) ENTRY hop (nested only). It is started and verified first: the exit
    //    core will dial through it, so it must provably relay before we depend
    //    on it.
    let entryHop: TunnelHop | null = null;
    if (entryNode) {
      const entry = await this.startHop(entryNode, opts.preferredEngine, { kind: 'entry' }, bypass);
      if (!entry.ok) {
        this.fail(`entry hop — ${entry.error}`, exitNode.id);
        return this.getStatus();
      }
      this.cores.push({ engine: entry.engine, run: entry.run });
      this.watch(entry.run);
      try {
        const trace = await this.deps.fetchThroughPort(entry.run.inboundPort, EXIT_TRACE_URL, 12_000);
        const ip = traceField(trace, 'ip');
        if (!ip) throw new Error('trace did not contain an ip= line');
        // The entry edge's OWN observed address — the thing the exit must differ from.
        entryHop = {
          nodeId: entryNode.id,
          name: entryNode.remark ?? null,
          engine: entry.engine,
          host: entryNode.host,
          port: entryNode.port,
          exitIp: ip,
          exitCountry: traceField(trace, 'loc'),
          inboundPort: entry.run.inboundPort,
        };
      } catch (err) {
        this.fail(`entry hop started but could not relay: ${message(err)}`, exitNode.id);
        return this.getStatus();
      }
    }

    // 2) EXIT hop — dials its node THROUGH the entry core in nested mode.
    const exit = await this.startHop(exitNode, opts.preferredEngine, nested ? { kind: 'exit', entryPort: entryHop!.inboundPort } : { kind: 'single' }, bypass);
    if (!exit.ok) {
      this.fail(nested ? `exit hop — ${exit.error}` : exit.error, exitNode.id);
      return this.getStatus();
    }
    this.cores.push({ engine: exit.engine, run: exit.run });
    this.watch(exit.run);

    this.status = {
      ...this.status,
      state: 'active',
      engine: exit.engine,
      inboundPort: exit.run.inboundPort,
      startedAt: Date.now(),
    };

    // 3) Verify by fetching a real trace THROUGH the final hop (not a TCP check
    //    — that would light "active" for a core that cannot actually relay).
    try {        const trace = await this.deps.fetchThroughPort(exit.run.inboundPort, EXIT_TRACE_URL, 12_000);
      const ip = traceField(trace, 'ip');
      const loc = traceField(trace, 'loc');
      if (!ip) throw new Error('trace did not contain an ip= line');
      const now = Date.now();
      const chain = entryHop
        ? chainRecord(entryHop, {
            nodeId: exitNode.id,
            name: exitNode.remark ?? null,
            engine: exit.engine,
            host: exitNode.host,
            port: exitNode.port,
            exitIp: ip,
            exitCountry: loc,
            inboundPort: exit.run.inboundPort,
          })
        : null;
      this.status = {
        ...this.status,
        exitIp: ip,
        exitCountry: loc,
        verifiedAt: now,
        error: null,
        reconnectAttempts: 0,
        reconnectLimit: RESTART_MAX_TRIES,
        chain,
      };
      this.deps.publish('tunnel:active', {
        nodeId: exitNode.id,
        engine: exit.engine,
        exitIp: ip,
        exitCountry: loc,
        ...(chain ? { nested: true, entryExitIp: chain.entryExitIp, exitDiffers: chain.exitDiffers } : {}),
      });
      // Proven: this is the only place gateway memory is written.
      this.deps.onVerifiedGateway?.({
        nodeId: exitNode.id,
        name: exitNode.remark ?? null,
        host: exitNode.host,
        port: exitNode.port,
        protocol: exitNode.protocol,
        engine: exit.engine,
        exitIp: ip,
        exitCountry: loc,
        verifyMs: this.status.startedAt != null ? now - this.status.startedAt : null,
      });
    } catch (err) {
      // The cores started but cannot relay — that is a dead tunnel; be honest.
      // Cancel any pending restart chain: reconnecting into a target that just
      // failed traffic verification would resurrect a dead node over and over.
      this.stopGeneration += 1;
      if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
      this.status = { ...this.status, state: 'down', error: `started but verification failed: ${message(err)}` };
      this.deps.publish('tunnel:error', { nodeId: exitNode.id, error: this.status.error });
      this.killAll();
      // A remembered gateway that no longer relays must be demoted, not trusted.
      this.deps.onGatewayFailed?.(exitNode.id);
      // We never reached the handoff step, so there is nothing of ours to
      // restore — do NOT write null blindly or we would wipe a proxy the user
      // had configured before this attempt.
      return this.getStatus();
    }

    // 4) Optionally route the OS through the FINAL hop of the chain.
    //    TUN mode replaces the system-proxy handoff: the gateway claims the
    //    default route itself, which captures everything a proxy setting
    //    would (and everything that ignores proxy settings too).
    if (opts.tun) {
      // The handle owns the whole TUN lifecycle — including the rule that a
      // gateway whose relay check fails is stopped rather than left holding the
      // default route. Its transitions land in `status` via onTunState.
      await this.tun.start();
    } else if (opts.systemProxy) {
      try {
        const prevProxy = await this.deps.getSystemProxy();
        // Persist the hold BEFORE the registry write: a crash between
        // setSystemProxy and arm() would strand the OS on a dead port with no
        // recovery record. With the hold saved first, boot recovery can undo it.
        this.deps.killSwitch?.preArm({
          previousProxy: prevProxy.proxy,
          label: (this.status.chain ? `chain ${this.status.nodeName ?? ''}`.trim() : this.status.nodeName) ?? 'proxy tunnel',
        });
        const set = await this.deps.setSystemProxy(`127.0.0.1:${exit.run.inboundPort}`);
        if (set.ok) {
          this.status = { ...this.status, systemProxy: true, previousProxy: prevProxy.proxy };
          // Arm here, not at start: the handoff is only real once the write
          // succeeded, and the kill switch must never claim a hold it does
          // not have.
          this.deps.killSwitch?.arm({
            previousProxy: prevProxy.proxy,
            label: this.status.chain ? `chain ${this.status.nodeName ?? ''}`.trim() : this.status.nodeName ?? 'proxy tunnel',
          });
        } else {
          this.status = { ...this.status, systemProxy: false, error: `system proxy: ${set.error ?? 'failed'}` };
          // The proxy write failed — nothing was taken over, so drop the
          // pre-armed hold rather than leaving a phantom record behind.
          void this.deps.killSwitch?.release(`system proxy write failed: ${set.error ?? 'unknown'}`).catch(() => undefined);
        }
      } catch (err) {
        this.status = { ...this.status, systemProxy: false, error: `system proxy: ${message(err)}` };
      }
    }

    this.restarts = 0;
    return this.getStatus();
  }

  /** Honest failure: record it, publish it, and leave no core behind. */
  private fail(error: string, nodeId: string): void {
    // Cancel any pending restart chain: a failure must not be followed by
    // reconnect attempts against a target that just proved dead.
    this.stopGeneration += 1;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.status = { ...this.status, state: 'down', error };
    this.deps.publish('tunnel:error', { nodeId, error });
    this.killAll();
  }

  /**
   * Start one hop's core. The exit hop of a chain must be an engine that really
   * honours the dial-through wiring — refused upfront rather than shipping a
   * "chain" that silently dials the node directly.
   */
  private async startHop(node: TunnelNodeInput, preferred: 'auto' | ProxyEngineId, role: HopRole, bypass: BypassRuleSet | null): Promise<HopStart> {
    const config = toParsedConfig(node);
    // What this hop actually needs a core to honour, decided once here so the
    // preflight and the pick agree.
    const options: EngineOptions = {
      bypass: bypass != null,
      dns: this.dns != null,
      chain: role.kind === 'exit',
    };
    const bar = this.preflight(config, preferred, role, options);
    if (bar) return { ok: false, error: bar };
    const engine = this.pickEngine(config, preferred, options)!;
    const bin = (this.deps.findBinary ?? findEngineBinary)(engine);
    if (!bin) return { ok: false, error: `${engine} binary not found` };
    // The secret comes from the at-rest vault — a node without a stored secret
    // can still tunnel if its protocol is unauthenticated, so we pass null
    // through and let the core decide.
    const secret = this.deps.nodeVault?.get(node.id) ?? null;
    const startFn = this.deps.startCoreFn ?? startCore;
    // Split-tunnel rules ride on the tunnel cores only — the probe path never
    // bypasses, or a test would measure the wrong path.
    const started = await startFn({ id: engine, bin, args: engineArgs(engine) }, config, secret, 10_000, {
      bypass,
      dns: this.dns,
      ...(role.kind === 'exit' ? { dialThroughPort: role.entryPort } : {}),
    });
    if (!started.ok) return { ok: false, error: `${engine}: ${started.error}` };
    return { ok: true, engine, run: started.run };
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
        this.deps.log.warn(`tunnel: failed to restore system proxy: ${message(err)}`);
      }
    }
    // Deliberate stop: always hand the user's proxy back and clear the hold
    // (also covers disconnecting while the switch was engaged).
    void this.deps.killSwitch?.onTunnelStopped().catch(() => undefined);
    this.killAll();

    if (!o.keepStatus) {
      this.status = { ...IDLE };
      this.target = null;
      this.targetOpts = null;
      if (wasNodeId) this.deps.publish('tunnel:stopped', { nodeId: wasNodeId });
    }
    this.stopping = false;
    return this.getStatus();
  }

  /** Kill every core this tunnel owns, including the TUN gateway (idempotent). */
  private killAll(): void {
    const cores = this.cores;
    this.cores = [];
    for (const core of cores) {
      try { core.run.cleanup(); } catch { /* idempotent */ }
    }
    // Route capture ends with the gateway process — never leave the status
    // claiming a TUN device (or its port) that no longer exists. This is a
    // deliberate teardown, so the handle reports no drop event for it.
    this.tun.stop();
    if (this.status.tun != null || this.status.tunGatewayPort != null) {
      this.status = { ...this.status, tun: null, tunGatewayPort: null };
    }
  }

  /**
   * Crash watcher: any core exit while we think the tunnel is up = down. Only
   * the first close is acted on — the second core's event finds no matching
   * core and returns.
   */
  private watch(run: CoreRun): void {
    run.child.once('close', (code) => {
      // The TUN gateway is watched by its own handle (a gateway crash withdraws
      // route capture while the engine hop may still relay, so it degrades to
      // proxy mode instead of taking the tunnel down).
      if (this.stopping || !this.cores.some((c) => c.run === run)) return;
      const nodeId = this.status.nodeId;
      this.killAll();
      this.status = { ...this.status, state: 'down', error: `core exited unexpectedly (code ${code ?? '?'})` };
      this.deps.publish('tunnel:down', { nodeId, reason: 'core_exit' });
      // The OS proxy still points at the dead core port. Let the kill switch
      // decide: block (enabled) or hand the user's own proxy back. Without
      // this, a crashed tunnel left a stale dead proxy setting behind with no
      // explanation.
      void this.deps.killSwitch?.onTunnelDropped(`core exited (code ${code ?? '?'})`).catch(() => undefined);
      this.scheduleRestart();
    });
  }

  /** Bounded auto-reconnect after a core crash — restores the whole target. */
  private scheduleRestart(): void {
    if (this.stopping || !this.target) return;
    if (this.restarts >= RESTART_MAX_TRIES) {
      this.status = { ...this.status, reconnectLimit: RESTART_MAX_TRIES };
      this.deps.publish('tunnel:error', { nodeId: this.status.nodeId, error: `gave up after ${RESTART_MAX_TRIES} reconnect attempts` });
      return;
    }
    this.restarts += 1;
    // Surfaced so the UI can say "reconnecting (attempt 2 of 3)" instead of
    // leaving the user to guess whether anything is happening.
    this.status = { ...this.status, reconnectAttempts: this.restarts, reconnectLimit: RESTART_MAX_TRIES };
    const delay = RESTART_BASE_MS * 2 ** (this.restarts - 1);
    const myGeneration = this.stopGeneration;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping || this.status.state === 'active') return;
      void this.restartStored().then((s) => {
        // start() is a no-op if a stop() superseded us (generation moved);
        // state will be idle — do not reschedule from a dead restart chain.
        if (this.stopGeneration !== myGeneration) return;
        if (s.state === 'down' && !s.error?.includes('gave up')) this.scheduleRestart();
      });
    }, delay);
  }

  /**
   * Why this hop cannot be started, or null when it can. Names the REAL
   * blocker: a protocol that can never chain is a different problem from a
   * core that simply is not installed.
   */
  private preflight(config: ParsedNodeConfig, preferred: 'auto' | ProxyEngineId, role: HopRole, options: EngineOptions): string | null {
    if (this.pickEngine(config, preferred, options)) return null;
    // An installed core may have been rejected for an OPTION rather than for the
    // protocol — name that case, because "no core supports this protocol" would
    // be false and would send the user hunting for a core they already have.
    const find = this.deps.findBinary ?? findEngineBinary;
    const blockedByOption = PROXY_ENGINE_ORDER
      .filter((e) => find(e) !== null && engineSupports(e, config.protocol) && engineSupportsConfig(e, config).ok && !options.chain)
      .map((e) => engineSupportsOptions(e, options))
      .find((reason): reason is string => reason !== null);
    if (blockedByOption) return blockedByOption;
    if (role.kind !== 'exit') return 'no installed proxy core supports this protocol';
    return chainExitProtocolUnsupported(config.protocol)
      ?? `no installed proxy core can dial this ${config.protocol} node as the chain exit hop (needs xray or sing-box — v2ray ignores the dial-through wiring)`;
  }

  /**
   * Engine choice: the user's preference first, then any installed core that
   * can dial the protocol AND honour this hop's options. The chain guard is
   * part of the option check, so a core that cannot dial through is never
   * chosen for an exit hop.
   */
  private pickEngine(config: ParsedNodeConfig, preferred: 'auto' | ProxyEngineId, options: EngineOptions): ProxyEngineId | null {
    const find = this.deps.findBinary ?? findEngineBinary;
    const order: ProxyEngineId[] = preferred === 'auto'
      ? [...PROXY_ENGINE_ORDER]
      : [preferred, ...PROXY_ENGINE_ORDER.filter((e) => e !== preferred)];
    return order.find((e) =>
      find(e) !== null
      && engineSupports(e, config.protocol)
      && engineSupportsConfig(e, config).ok
      && engineSupportsOptions(e, options) === null
      && (!options.chain || chainExitUnsupported(e, config.protocol) === null),
    ) ?? null;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Normalize a node row into the config shape the core builders consume. */
function toParsedConfig(node: TunnelNodeInput): ParsedNodeConfig {
  return {
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
