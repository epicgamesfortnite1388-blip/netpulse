/**
 * Local proxy cores for testing public V2Ray/Xray-flavored nodes.
 *
 * Two engines, one interface:
 *   - sing-box (already supported) — universal protocol coverage
 *   - xray (NEW) — the reference V2Ray core; best Reality/XTLS fidelity
 *
 * Flow per probe: generate a config with the node as outbound + an inbound on
 * an EPHEMERAL loopback port → spawn the core (windowsHide, bounded lifecycle)
 * → CONNECT through it → measure → always kill + delete temp config.
 *
 * If a core binary is not installed the probe reports `engine_unavailable`
 * instead of a fake success.
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { reservePort, spawnCoreProcess, startupReason } from './coreProcess';

import type { CoreProcess } from './coreProcess';
import { isProcessElevated } from '../util/privileges';

import { bypassIsEmpty, type BypassRuleSet, type ParsedNodeConfig, type ProxyEngineId } from '@netpulse/shared';

/* ============================ config generation ============================ */

/** Outbound tag of the injected dial-through outbound in a chained core. */
const CHAIN_DIAL_TAG = 'chain-upstream';

/**
 * Temp-dir prefixes this app creates for core binaries. Every dir we make is
 * prefixed, so housekeeping can recognise ours without touching anything else
 * in the shared temp directory.
 */
const CORE_TMP_PREFIXES = [
  'netpulse-core-',
  'netpulse-probe-',
  'netpulse-aether-',
  'netpulse-xray-',
  'netpulse-sing-box-',
  'netpulse-v2ray-',
  'netpulse-hysteria-',
] as const;

/**
 * Remove core config dirs abandoned by a previous run.
 *
 * The graceful path deletes its dir when a core stops, but a crashed or
 * force-killed process cannot — and those dirs hold `core.json`, which embeds
 * the node's credentials (uuid/password), so leftovers are both litter and a
 * secrets-hygiene problem.
 *
 * Only dirs older than `maxAgeMs` are touched. A core's config is written once
 * at spawn and never rewritten, so age alone cannot distinguish a finished
 * probe from a long-lived tunnel core; the 24h default is far beyond any core
 * this app keeps running, which makes sweeping safe while still bounded.
 */
export function sweepStaleCoreDirs(maxAgeMs = 24 * 60 * 60 * 1000): { removed: number; failed: number } {
  const dir = os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { removed: 0, failed: 0 };
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let failed = 0;
  for (const name of entries) {
    if (!CORE_TMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const target = path.join(dir, name);
    try {
      const stat = fs.statSync(target);
      if (!stat.isDirectory() || stat.mtimeMs > cutoff) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

/**
 * NESTED MODE guard — why an engine must not be the DIAL-THROUGH (exit) hop.
 *
 * Measured against the real binaries: v2ray-core 5.53 silently IGNORES
 * `streamSettings.sockopt.dialerProxy`, so a v2ray exit hop relays directly to
 * the node while the UI claims two hops. It is refused rather than trusted.
 * Only the exit hop is affected: any engine can serve as the entry hop, since
 * an entry only has to expose an HTTP-CONNECT inbound.
 */
export function chainExitUnsupported(engine: ProxyEngineId, protocol: string): string | null {
  if (engine === 'v2ray') {
    return 'v2ray-core ignores streamSettings.sockopt.dialerProxy, so it cannot chain to another core (use xray or sing-box)';
  }
  if (engine === 'hysteria') {
    return 'the Hysteria2 client has no dial-through option, so it cannot chain to another core (use xray or sing-box) — and it only dials hysteria2 anyway';
  }
  return chainExitProtocolUnsupported(protocol);
}

/**
 * Start-time options a core must be able to HONOUR.
 *
 * These are not protocol questions, so they cannot live in
 * `engineSupportsConfig`: they are choices about how a tunnel behaves. A core
 * that cannot express one is excluded rather than silently ignoring it —
 * routing a bypass list through the tunnel anyway, or quietly keeping DNS on
 * the local resolver, would be a real traffic change rather than a cosmetic
 * difference. Returns the honest reason, or null when the core supports it.
 */
export function engineSupportsOptions(
  engine: ProxyEngineId,
  opts: { bypass?: boolean; dns?: boolean; chain?: boolean },
): string | null {
  if (engine !== 'hysteria') return null;
  if (opts.bypass) {
    return 'the Hysteria2 client has no per-domain bypass rules, so it cannot honour split tunneling (use sing-box or xray while bypass is on)';
  }
  if (opts.dns) {
    return 'the Hysteria2 client resolves through its own TLS session and exposes no DNS block, so DNS-through-tunnel cannot be wired (use sing-box)';
  }
  if (opts.chain) {
    return 'the Hysteria2 client has no dial-through option, so it cannot join a chain (use xray or sing-box)';
  }
  return null;
}

/**
 * The engine-independent half of the same rule: a UDP protocol can never be
 * the exit hop, whichever core runs it.
 */
export function chainExitProtocolUnsupported(protocol: string): string | null {
  if (protocol === 'hysteria2' || protocol === 'tuic') {
    return `${protocol} is UDP-based and cannot be dialled through a local TCP proxy, so it cannot be the exit hop of a chain`;
  }
  return null;
}

/**
 * Legacy SS ciphers none of the cores accepts for AEAD-style configs — running
 * them produces cryptic core exit codes instead of an honest error.
 */
const LEGACY_SS_CIPHERS = new Set(['rc4', 'rc4-md5', 'des-cfb', 'table', 'bf-cfb', 'chacha20', 'chacha20-ietf']);

/** True when a node's protocol/transport combination is engine-testable. */
export function configIsTestable(config: ParsedNodeConfig): { ok: true } | { ok: false; error: string } {
  if (config.protocol === 'shadowsocksr') {
    return { ok: false, error: 'shadowsocksr is not supported by xray, sing-box or v2ray (use a shadowsocks/vless/trojan node)' };
  }
  if (config.protocol === 'shadowsocks' && config.encryption && LEGACY_SS_CIPHERS.has(config.encryption.toLowerCase())) {
    return { ok: false, error: `shadowsocks cipher "${config.encryption}" is legacy and unsupported by xray/sing-box/v2ray (use an AEAD cipher, e.g. aes-256-gcm or chacha20-ietf-poly1305)` };
  }
  return { ok: true };
}

/* ------------------------------ DNS through tunnel ------------------------ */

/**
 * DNS-through-VPN wiring for tunnel cores.
 *
 * When enabled, domain lookups INSIDE the core (and DNS queries the user sends
 * to the tunnel's inbound) are resolved through the node's outbound — the
 * resolver is reached via the tunnel, so the local network never sees the DNS
 * packets and the resolver never sees the local address. What this layer does
 * NOT do is capture the OS's own resolver traffic: only the system-proxy
 * handoff moves apps onto the tunnel, and apps that ignore it keep their own
 * DNS path (stated honestly in the UI note).
 */
export interface DnsThroughTunnel {
  /** Where the tunnel's DNS answers land, for any server that supports DoH. */
  doh: string;
  /** Classic UDP:53 fallback for resolvers that cannot DoH (e.g. 10.x LAN). */
  plainFallback: string;
}

/** Explicit tag for the node outbound so DNS wiring can reference it. */
const NODE_OUT_TAG = 'np-node';

/**
 * Xray/v2ray: a `dns` object + routing rule that pins every query arriving on
 * the internal `dns` inbound to the node outbound. `queryStrategy` is omitted
 * (UseIP default) so the node's resolver decides A/AAAA. Measured against the
 * installed Xray 26.3.27: with this block, lookups egress via the node.
 */
function applyXrayDns(base: Record<string, unknown>, outbounds: unknown[], dns: DnsThroughTunnel | null): void {
  if (!dns) return;
  base['dns'] = {
    // Ordered: DoH through the tunnel first, classic UDP fallback second.
    servers: [dns.doh, dns.plainFallback],
  };
  // Xray tags queries generated by its own dns module with the special
  // inboundTag "dns"; pinning THAT tag to the node outbound is what sends
  // resolver packets through the tunnel instead of the local network.
  const dnsRule = { type: 'field', inboundTag: ['dns'], outboundTag: NODE_OUT_TAG };
  const routing = base['routing'] as { rules?: unknown[] } | undefined;
  if (routing) routing.rules = [dnsRule, ...(routing.rules ?? [])];
  else base['routing'] = { domainStrategy: 'AsIs', rules: [dnsRule] };
}

/**
 * sing-box 1.11+ (installed: 1.14.0): `route.default_domain_resolver` points
 * the internal resolver at DNS servers that themselves `detour` through the
 * node outbound, so resolver packets ride the tunnel. A `local`-tagged server
 * stays as last-resort fallback (e.g. DoH blocked on the exit network).
 *
 * Returns the top-level `dns` object (the caller places it — it is NOT part of
 * `route`), or null when there is no node outbound to resolve through.
 */
function singboxDnsConfig(dns: DnsThroughTunnel, outbounds: readonly Record<string, unknown>[]): Record<string, unknown> | null {
  const nodeOut = outbounds.find((o) => o['tag'] === NODE_OUT_TAG);
  if (!nodeOut) return null;
  let dohHost: string;
  try {
    dohHost = new URL(dns.doh).hostname;
  } catch {
    return null; // malformed DoH URL — refuse rather than emit a broken resolver
  }
  return {
    servers: [
      { type: 'https', tag: 'dns-tun', server: dohHost, detour: NODE_OUT_TAG },
      { type: 'udp', tag: 'dns-plain', server: dns.plainFallback, detour: NODE_OUT_TAG },
      { type: 'local', tag: 'dns-fallback' },
    ],
  };
}

/**
 * V2Ray-family outbound for a node (Xray-core AND v2ray-core share the
 * outbound schema; buildXrayConfig serves both — `buildV2rayConfig` is an
 * alias so intent is explicit at call sites).
 *
 * Reality and the xhttp transport are Xray-only extensions: when the caller
 * routes a Reality node to v2ray-core, the public key has nowhere to go, so
 * engineSupports() refuses that combination upstream — this builder still
 * emits plain TLS for it rather than a silently wrong config.
 */
export function buildXrayOutbound(config: ParsedNodeConfig, secret: string | null): Record<string, unknown> {
  const proto = config.protocol;
  const isReality = config.security === 'reality' || Boolean(config.realityPublicKey);

  const network = config.transport === 'none' || config.transport === 'unknown' || config.transport === 'quic' || config.transport === 'udp' ? 'tcp' : config.transport;
  const streamSettings: Record<string, unknown> = {
    network,
    security: config.security === 'reality' ? 'reality' : config.security === 'tls' ? 'tls' : 'none',
  };

  if (config.security === 'tls' && !isReality) {
    const tlsSettings: Record<string, unknown> = {
      serverName: config.sni ?? config.host,
      allowInsecure: config.allowInsecure === true,
      fingerprint: config.fingerprint ?? 'chrome',
    };
    if (config.alpn && config.alpn.length > 0) tlsSettings['alpn'] = config.alpn;
    streamSettings['tlsSettings'] = tlsSettings;
  }
  if (isReality) {
    streamSettings['realitySettings'] = {
      serverName: config.sni ?? config.realityServerName ?? config.host,
      fingerprint: config.fingerprint ?? 'chrome',
      publicKey: config.realityPublicKey ?? '',
      shortId: config.realityShortId ?? '',
      spiderX: '/',
    };
  }

  if (config.transport === 'ws') {
    streamSettings['wsSettings'] = {
      path: config.path ?? '/',
      ...(config.hostHeader ? { headers: { Host: config.hostHeader } } : {}),
    };
  } else if (config.transport === 'grpc') {
    streamSettings['grpcSettings'] = { serviceName: config.serviceName ?? '' };
  } else if (config.transport === 'http') {
    streamSettings['httpSettings'] = {
      path: config.path ?? '/',
      ...(config.hostHeader ? { host: [config.hostHeader] } : {}),
    };
  } else if (config.transport === 'httpupgrade') {
    streamSettings['httpupgradeSettings'] = {
      path: config.path ?? '/',
      ...(config.hostHeader ? { host: config.hostHeader } : {}),
    };
  } else if (config.transport === 'xhttp') {
    streamSettings['xhttpSettings'] = {
      path: config.path ?? '/',
      ...(config.hostHeader ? { host: config.hostHeader } : {}),
    };
  }

  let settings: Record<string, unknown>;
  switch (proto) {
    case 'hysteria2': {
      // xray-core has no hysteria2 outbound — engineSupports() never routes
      // hy2 here; keep the honest guard in case routing changes.
      settings = { servers: [{ address: config.host, port: config.port }] };
      break;
    }
    case 'vless':
      settings = {
        vnext: [{
          address: config.host,
          port: config.port,
          users: [{ id: secret ?? '', encryption: 'none', ...(config.flow ? { flow: config.flow } : {}), level: 0 }],
        }],
      };
      break;
    case 'vmess':
      settings = {
        vnext: [{
          address: config.host,
          port: config.port,
          users: [{ id: secret ?? '', alterId: config.alterId ?? 0, security: config.encryption ?? 'auto', level: 0 }],
        }],
      };
      break;
    case 'trojan':
      settings = { servers: [{ address: config.host, port: config.port, password: secret ?? '' }] };
      break;
    case 'shadowsocks':
      settings = { servers: [{ address: config.host, port: config.port, method: config.encryption ?? 'aes-256-gcm', password: secret ?? '', uot: true }] };
      break;
    default:
      settings = {};
  }

  return { protocol: proto, settings, streamSettings, tag: 'proxy' };
}

/**
 * Xray/v2ray routing rules for a bypass set. Xray matches `domain:example.com`
 * against the name AND every subdomain, which is exactly the suffix semantics
 * the settings UI describes; `geoip:private` covers loopback/RFC1918/ULA.
 * Exported so the rule shape is unit-tested directly (it is easy to get subtly
 * wrong and a wrong rule silently routes the wrong traffic).
 */
export function buildXrayRoutingRules(rs: BypassRuleSet): Record<string, unknown>[] {
  const domain = rs.domains.map((d) => `domain:${d}`);
  const ip = [...rs.ips];
  if (rs.lan) ip.push('geoip:private');
  const rules: Record<string, unknown>[] = [];
  if (domain.length > 0 || ip.length > 0 || rs.ports.length > 0) {
    const rule: Record<string, unknown> = { type: 'field', outboundTag: 'direct' };
    if (domain.length > 0) rule['domain'] = domain;
    if (ip.length > 0) rule['ip'] = ip;
    if (rs.ports.length > 0) rule['port'] = rs.ports.join(',');
    rules.push(rule);
  }
  return rules;
}

/**
 * Xray config JSON: node outbound + one HTTP inbound on the given port.
 *
 * `bypass` is applied ONLY by the long-lived tunnel — a probe that skipped the
 * node would be measuring the wrong path, so the default (undefined) leaves
 * routing untouched.
 *
 * `dialThroughPort` is NESTED MODE: the node connection is dialled through a
 * local HTTP proxy (the other core in the chain) via `sockopt.dialerProxy`, so
 * this core's traffic leaves through the other hop. Measured against xray
 * 26.3.27: the chain is real (killing the peer core kills the path).
 */
export function buildXrayConfig(
  config: ParsedNodeConfig,
  secret: string | null,
  httpPort: number,
  bypass?: BypassRuleSet | null,
  dialThroughPort?: number | null,
  dns?: DnsThroughTunnel | null,
): Record<string, unknown> {
  const nodeOutbound = buildXrayOutbound(config, secret) as Record<string, unknown> & { streamSettings: Record<string, unknown> };
  nodeOutbound['tag'] = NODE_OUT_TAG;
  const outbounds: unknown[] = [nodeOutbound];
  if (dialThroughPort != null) {
    nodeOutbound.streamSettings['sockopt'] = { dialerProxy: CHAIN_DIAL_TAG };
    // An HTTP outbound performs CONNECT, which is what the peer core's inbound
    // speaks. (A SOCKS outbound only matches a SOCKS inbound.)
    outbounds.push({
      protocol: 'http',
      tag: CHAIN_DIAL_TAG,
      settings: { servers: [{ address: '127.0.0.1', port: dialThroughPort }] },
    });
  }
  const base: Record<string, unknown> = {
    log: { loglevel: 'warning' },
    inbounds: [{
      tag: 'probe-in',
      listen: '127.0.0.1',
      port: httpPort,
      protocol: 'http',
    }],
    outbounds,
  };
  if (bypass && !bypassIsEmpty(bypass)) {
    outbounds.push({ protocol: 'freedom', tag: 'direct' });
    base['routing'] = { domainStrategy: 'AsIs', rules: buildXrayRoutingRules(bypass) };
  }
  applyXrayDns(base, outbounds, dns ?? null);
  return base;
}

/** v2ray-core uses the same JSON schema as Xray-core (it is the upstream). */
export const buildV2rayConfig = buildXrayConfig;

/**
 * sing-box routing rules for a bypass set. Private ranges get their OWN rule:
 * `ip_is_private` is a standalone matcher, and folding it into the
 * domain/CIDR/port rule would make that rule match far more than intended.
 * Exported for direct unit testing.
 */
export function buildSingboxRouteRules(rs: BypassRuleSet): Record<string, unknown>[] {
  const rules: Record<string, unknown>[] = [];
  if (rs.domains.length > 0 || rs.ips.length > 0 || rs.ports.length > 0) {
    const rule: Record<string, unknown> = { outbound: 'direct' };
    if (rs.domains.length > 0) rule['domain_suffix'] = rs.domains;
    if (rs.ips.length > 0) rule['ip_cidr'] = rs.ips;
    if (rs.ports.length > 0) rule['port'] = rs.ports;
    rules.push(rule);
  }
  if (rs.lan) rules.push({ ip_is_private: true, outbound: 'direct' });
  return rules;
}

/**
 * sing-box config (same shape proxyProbe already used, extracted so both
 * engines share one lifecycle). `bypass` is tunnel-only, same rationale as
 * buildXrayConfig.
 */
export function buildSingboxConfig(
  config: ParsedNodeConfig,
  secret: string | null,
  mixedPort: number,
  bypass?: BypassRuleSet | null,
  dialThroughPort?: number | null,
  dns?: DnsThroughTunnel | null,
): Record<string, unknown> {
  const proto = config.protocol;
  const outbound: Record<string, unknown> = {
    type: proto,
    server: config.host,
    server_port: config.port,
  };

  const tlsBlock: Record<string, unknown> = {
    enabled: true,
    server_name: config.sni ?? config.host,
    insecure: config.allowInsecure === true,
  };
  if (config.realityPublicKey) {
    tlsBlock['reality'] = {
      enabled: true,
      public_key: config.realityPublicKey,
      short_id: config.realityShortId ?? '',
    };
  } else {
    tlsBlock['utls'] = { enabled: true, fingerprint: config.fingerprint ?? 'chrome' };
  }

  const needsTls = proto === 'vless' || proto === 'vmess' || proto === 'trojan'
    ? config.security === 'tls' || config.security === 'reality' || Boolean(config.realityPublicKey)
    : proto === 'hysteria2' || proto === 'tuic';
  if (needsTls) outbound['tls'] = tlsBlock;

  if (config.transport === 'ws') {
    // Host header is the CDN routing key on ws-over-CDN nodes — dropping it
    // makes the edge reset the connection (observed live: Fastly vless+ws
    // passed on xray, ECONNRESET on sing-box) while the node itself is fine.
    outbound['transport'] = {
      type: 'ws',
      path: config.path ?? '/',
      ...(config.hostHeader ? { headers: { Host: config.hostHeader } } : {}),
    };
  } else if (config.transport === 'grpc') {
    outbound['transport'] = { type: 'grpc', service_name: config.serviceName ?? '' };
  } else if (config.transport === 'http') {
    outbound['transport'] = {
      type: 'http',
      path: config.path ?? '/',
      ...(config.hostHeader ? { host: [config.hostHeader] } : {}),
    };
  } else if (config.transport === 'httpupgrade') {
    outbound['transport'] = {
      type: 'httpupgrade',
      path: config.path ?? '/',
      ...(config.hostHeader ? { host: config.hostHeader } : {}),
    };
  }

  switch (proto) {
    case 'vless':
      outbound['uuid'] = secret ?? '';
      if (config.flow) outbound['flow'] = config.flow;
      break;
    case 'vmess':
      outbound['uuid'] = secret ?? '';
      outbound['alter_id'] = config.alterId ?? 0;
      outbound['security'] = config.vmessSecurity ?? config.encryption ?? 'auto';
      break;
    case 'trojan':
      outbound['password'] = secret ?? '';
      break;
    case 'shadowsocks':
      outbound['method'] = config.encryption ?? 'aes-256-gcm';
      outbound['password'] = secret ?? '';
      break;
    case 'hysteria2': {
      // Credentials are REQUIRED — without them sing-box exits at startup
      // and the probe blames the node for a local config bug.
      outbound['password'] = secret ?? '';
      if (typeof config.extra?.['obfs'] === 'string' && config.extra['obfs']) {
        outbound['obfs'] = { type: String(config.extra['obfs']), password: String(config.extra['obfs-password'] ?? '') };
      }
      if (config.extra && config.extra['up'] != null) outbound['up_mbps'] = Number(config.extra['up']) || undefined;
      if (config.extra && config.extra['down'] != null) outbound['down_mbps'] = Number(config.extra['down']) || undefined;
      break;
    }
    case 'tuic': {
      outbound['uuid'] = secret ?? '';
      if (config.extra && config.extra['password'] != null) outbound['password'] = String(config.extra['password']);
      outbound['congestion_control'] = String(config.extra?.['congestion_control'] ?? 'bbr');
      outbound['udp_relay_mode'] = String(config.extra?.['udp_relay_mode'] ?? 'native');
      break;
    }
    default:
      break;
  }

  outbound['tag'] = NODE_OUT_TAG;
  const outbounds: Record<string, unknown>[] = [outbound];
  if (dialThroughPort != null) {
    // NESTED MODE: `detour` makes this outbound dial through the peer core.
    outbound['detour'] = CHAIN_DIAL_TAG;
    outbounds.push({ type: 'http', tag: CHAIN_DIAL_TAG, server: '127.0.0.1', server_port: dialThroughPort });
  }
  const route: Record<string, unknown> = { auto_detect_interface: true };
  if (bypass && !bypassIsEmpty(bypass)) {
    outbounds.push({ type: 'direct', tag: 'direct' });
    route['rules'] = buildSingboxRouteRules(bypass);
  }

  const dnsConfig = dns ? singboxDnsConfig(dns, outbounds) : null;
  // The core's own hostname resolutions (its dial to the node, DoH server
  // lookups) follow default_domain_resolver — pointed at the detoured server,
  // they ride the tunnel. User DNS already rides the tunnel as proxied traffic.
  if (dnsConfig) route['default_domain_resolver'] = { server: 'dns-tun' };

  return {
    log: { level: 'warn', timestamp: true },
    ...(dnsConfig ? { dns: dnsConfig } : {}),
    inbounds: [{ type: 'mixed', tag: 'probe-in', listen: '127.0.0.1', listen_port: mixedPort }],
    outbounds,
    route,
  };
}

/* ============================== hysteria2 ================================= */

/**
 * Hysteria2 client config.
 *
 * YAML, because that is what the binary reads (verified against the project's
 * documented client config): `server` as `host:port`, the node password as
 * `auth`, a `tls` block, optional salamander obfuscation, Brutal bandwidth
 * hints, and the local inbound.
 *
 * The inbound is HTTP rather than SOCKS5 deliberately: this app both probes
 * nodes and hands the OS its system proxy over HTTP CONNECT, and the Hysteria
 * client has no mixed inbound (its `http` and `socks5` listeners are separate
 * ports). `http.listen` is therefore what both paths talk to — and the honest
 * consequence, no local UDP relay through this core, is stated in its
 * capability matrix rather than hidden.
 */
export function buildHysteria2ClientConfig(config: ParsedNodeConfig, secret: string, httpPort: number): string {
  // Always quoted: node credentials, SNI values and host:port pairs routinely
  // contain YAML-significant characters (IPv6 brackets, ':', '*')
  const yv = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines: string[] = [
    `server: ${yv(`${config.host}:${config.port}`)}`,
    `auth: ${yv(secret)}`,
    'tls:',
    `  sni: ${yv(config.sni ?? config.host)}`,
  ];
  if (config.allowInsecure === true) lines.push('  insecure: true');
  const alpn = (config.alpn ?? []).filter((a) => typeof a === 'string' && a.length > 0);
  if (alpn.length > 0) lines.push(`  alpn: [${alpn.map(yv).join(', ')}]`);

  const obfs = typeof config.extra?.['obfs'] === 'string' && config.extra['obfs'] ? config.extra['obfs'] : null;
  if (obfs) {
    lines.push('obfs:', `  type: ${yv(obfs)}`, '  salamander:', `    password: ${yv(String(config.extra?.['obfs-password'] ?? ''))}`);
  }

  // Brutal bandwidth hints. Only emitted when the node actually advertised
  // them — inventing a value would change congestion behaviour on the wire.
  const up = Number(config.extra?.['up']);
  const down = Number(config.extra?.['down']);
  if ((Number.isFinite(up) && up > 0) || (Number.isFinite(down) && down > 0)) {
    lines.push('bandwidth:');
    if (Number.isFinite(up) && up > 0) lines.push(`  up: ${yv(`${up} mbps`)}`);
    if (Number.isFinite(down) && down > 0) lines.push(`  down: ${yv(`${down} mbps`)}`);
  }

  lines.push('http:', `  listen: ${yv(`127.0.0.1:${httpPort}`)}`, 'fastOpen: true');
  return `${lines.join('\n')}\n`;
}

/* ============================ binary detection ============================ */

export interface ResolvedEngine {
  id: ProxyEngineId;
  bin: string;
  /** spawn args before the config file */
  args: string[];
}

/** Core → on-disk binary base name (the app's cores folder). */
const ENGINE_BINARY_BASE: Record<ProxyEngineId, string> = {
  xray: 'xray',
  'sing-box': 'sing-box',
  v2ray: 'v2ray',
  hysteria: 'hysteria',
};

/**
 * The order cores are tried in when no preference is set.
 *
 * xray stays first (best Reality/XTLS fidelity). Hysteria sits ahead of
 * sing-box because it only ever claims hysteria2 nodes — it cannot displace a
 * core for any other protocol — and for those nodes the protocol's own client
 * is the implementation to trust first, with sing-box as the fallback.
 */
export const PROXY_ENGINE_ORDER: readonly ProxyEngineId[] = ['xray', 'hysteria', 'sing-box', 'v2ray'];

/**
 * Spawn args a core expects BEFORE its config path (`-c <file>` is appended).
 *
 * xray/sing-box/v2ray take a `run` subcommand; the Hysteria client is invoked
 * with `-c` directly, since client mode is its default.
 */
export function engineArgs(id: ProxyEngineId): string[] {
  return id === 'hysteria' ? [] : ['run'];
}

/**
 * Find a core binary. Search order:
 *   1. NETPULSE_CORES_DIR (explicit override)
 *   2. <dataDir>/cores/ — the desktop app's per-user drop-in folder; users
 *      copy xray.exe / sing-box.exe there and the app finds them without
 *      touching PATH (existence check only — nothing is executed here)
 *   3. PATH
 */
export function findEngineBinary(id: ProxyEngineId): string | null {
  const base = ENGINE_BINARY_BASE[id];
  const names = process.platform === 'win32' ? [`${base}.exe`] : [base];
  if (id === 'hysteria') {
    // Hysteria's own release filenames the executable after the platform, so a
    // manually dropped official build is recognised too (no copy step needed).
    names.push('hysteria-windows-amd64.exe', 'hysteria-windows-arm64.exe');
  }
  const dirs: string[] = [];
  if (process.env['NETPULSE_CORES_DIR']) dirs.push(process.env['NETPULSE_CORES_DIR']);
  if (process.env['NETPULSE_DATA_DIR']) dirs.push(path.join(process.env['NETPULSE_DATA_DIR'], 'cores'));
  dirs.push(...(process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean));
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch { /* unreadable dir */ }
    }
  }
  return null;
}

/* ============================ spawn + readiness ============================
 * The process lifecycle itself (spawn, bounded output, readiness, cleanup)
 * belongs to ./coreProcess — one owner for every local core. What stays here is
 * what is genuinely node-specific: config generation, port reservation, the
 * failure classification callers read, and the retry policy.
 */

export interface CoreRun {
  child: CoreProcess['child'];
  inboundPort: number;
  /** kill the core + delete the temp config (idempotent) */
  cleanup: () => void;
  readonly stderrTail: string;
}

export type EngineStartFailure = 'engine_unavailable' | 'engine_start_failed';

export type CoreStartResult =
  | { ok: true; run: CoreRun }
  | { ok: false; failure: EngineStartFailure; error: string };


/* ================================ TUN mode ================================= */

/**
 * TUN GATEWAY (system-wide mode for every engine).
 *
 * The engine hops (xray / v2ray / hysteria / sing-box) expose local proxy
 * inbounds only — none of them can claim the OS default route on Windows
 * without a TUN device, and xray/v2ray/hysteria have no TUN inbound at all.
 * sing-box DOES (a native `tun` inbound), so TUN mode for EVERY engine is one
 * extra sing-box core whose outbound is a plain proxy pointed at the engine
 * hop's inbound:
 *
 *   OS traffic → sing-box TUN device → http/socks outbound → engine inbound
 *              → node → internet
 *
 * `upstream` names the protocol of the port being fronted: the local cores
 * expose a mixed/HTTP inbound, while Aether serves SOCKS5 — one gateway, both
 * shapes, so every engine gets the same system-wide mode.
 *
 * This is exactly the wiring Hiddify/NekoBox-class clients use: one core owns
 * the route capture, the protocol engines stay proxy-only. The gateway's own
 * HTTP inbound (below) gives the app a way to VERIFY the TUN path with real
 * traffic — a trace fetched through the gateway port only succeeds if the TUN
 * device, the route claim and the engine hop all relay.
 *
 * Windows requires administrator rights to create the TUN adapter (wintun),
 * so the START function refuses honestly when the sidecar is not elevated —
 * see `tunGatewayStartRefusal`.
 */

/**
 * sing-box config for the TUN gateway. `upstreamPort` is the engine hop's
 * HTTP/mixed inbound. The gateway also exposes its own mixed inbound so the
 * verification trace (and any caller that wants a plain proxy path) can go
 * through the gateway without the TUN device.
 */
/** Resolver every TUN gateway must own (see the DNS note in the builder). */
export const TUN_GATEWAY_RESOLVER: DnsThroughTunnel = { doh: 'https://1.1.1.1/dns-query', plainFallback: '1.1.1.1' };

export function buildTunGatewayConfig(
  upstreamPort: number,
  gatewayPort: number,
  opts?: { bypass?: BypassRuleSet | null; upstream?: 'http' | 'socks'; excludeAddresses?: string[]; resolver?: DnsThroughTunnel },
): Record<string, unknown> {
  // Addresses the TUN device must never capture. Without this the device claims
  // the default route and then swallows the engine hop's own dial to the node
  // (a public address, so the `ip_is_private` rule below does not cover it) —
  // the dial re-enters the gateway, the gateway forwards it back to the hop,
  // and no packet ever reaches the node: the tunnel relays nothing and the
  // machine loses DNS and connectivity while the app reports TUN as inactive.
  const excludeAddresses = [...new Set((opts?.excludeAddresses ?? []).filter((a) => a.length > 0))];
  const upstreamTag = 'engine-hop';
  const dnsTag = 'gw-dns';
  const outbounds: Record<string, unknown>[] = [
    {
      type: opts?.upstream === 'socks' ? 'socks' : 'http',
      tag: upstreamTag,
      server: '127.0.0.1',
      server_port: upstreamPort,
    },
    // 'direct' is ALWAYS defined. The private-address rule below points at this
    // tag, and with no bypass rules configured it used to point at nothing:
    // sing-box then logged `router: outbound not found: direct` for every such
    // packet and dropped it — including the device's own DNS traffic — so the
    // gateway came up, claimed the route, and relayed nothing.
    { type: 'direct', tag: 'direct' },
  ];
  const bypassRules = opts?.bypass && !bypassIsEmpty(opts.bypass) ? buildSingboxRouteRules(opts.bypass) : [];

  // The gateway must resolve names ITSELF, through the hop. auto_route hands it
  // the default route, so a system-resolver lookup is captured by the device it
  // just created; raw UDP:53 cannot be relayed by a TCP-only upstream (an
  // Aether SOCKS hop answers `request rejected`), which left the relay
  // verification with no working DNS. Both servers detour through the hop, and
  // there is deliberately NO `local` fallback: a local resolver would answer
  // outside the tunnel and its own packets would re-enter the device.
  const resolver = opts?.resolver ?? TUN_GATEWAY_RESOLVER;
  const dnsConfig = singletonResolverConfig(resolver, dnsTag, upstreamTag);
  const route: Record<string, unknown> = {
    auto_detect_interface: true,
    ...(dnsConfig ? { default_domain_resolver: { server: dnsTag } } : {}),
    rules: [
      // Sniff before the protocol rule: `protocol: dns` only matches once the
      // router knows what the packet is.
      { action: 'sniff' },
      // Queries the device receives are answered by the resolver above instead
      // of being forwarded as raw UDP:53 the hop cannot carry.
      ...(dnsConfig ? [{ protocol: 'dns', action: 'hijack-dns' }] : []),
      // The gateway's own dial to the engine hop must not loop back through the
      // TUN device: loopback traffic is excluded by rule, not by luck.
      { ip_is_private: true, outbound: 'direct' },
      ...bypassRules,
    ],
    // Everything else rides the hop. Set explicitly so the default outbound is
    // never decided by outbound ordering.
    final: upstreamTag,
  };
  return {
    log: { level: 'warn', timestamp: true },
    ...(dnsConfig ? { dns: dnsConfig } : {}),
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        address: ['172.19.0.1/30'],
        mtu: 1500,
        stack: 'system',
        auto_route: true,
        strict_route: false,
        ...(excludeAddresses.length > 0 ? { route_exclude_address: excludeAddresses } : {}),
      },
      {
        type: 'mixed',
        tag: 'gw-in',
        listen: '127.0.0.1',
        listen_port: gatewayPort,
      },
    ],
    outbounds,
    route,
  };
}

/**
 * The gateway's own resolver: DoH first, classic UDP second, both riding the
 * hop. Returns null for a malformed DoH URL rather than emitting a broken
 * resolver (the same refusal `singboxDnsConfig` makes for hop configs).
 */
function singletonResolverConfig(resolver: DnsThroughTunnel, dnsTag: string, detourTag: string): Record<string, unknown> | null {
  let dohHost: string;
  try {
    dohHost = new URL(resolver.doh).hostname;
  } catch {
    return null;
  }
  return {
    servers: [
      { type: 'https', tag: dnsTag, server: dohHost, detour: detourTag },
      { type: 'udp', tag: `${dnsTag}-plain`, server: resolver.plainFallback, detour: detourTag },
    ],
    final: dnsTag,
  };
}

/**
 * CIDRs a TUN gateway must NOT capture: the addresses of the hop it fronts.
 *
 * The gateway takes the default route, so anything the hop dials out from
 * would otherwise be captured by the device, handed back to the gateway, and
 * forwarded to the hop again — an endless loop that relays nothing (see the
 * `excludeAddresses` note in `buildTunGatewayConfig`). Hosts may be IPs or
 * domains; a domain that cannot be resolved contributes nothing rather than a
 * guessed address. Resolution failure NEVER fails the gateway — it only leaves
 * what we could not resolve unprotected.
 */
export async function tunRouteExclusions(
  hosts: Array<string | null | undefined>,
  resolve: (host: string) => Promise<string[]> = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((r) => r.address),
): Promise<string[]> {
  const out = new Set<string>();
  for (const host of hosts) {
    const clean = (host ?? '').trim();
    if (!clean) continue;
    const literal = net.isIP(clean.replace(/^\[|\]$/g, ''));
    if (literal) {
      out.add(`${clean.replace(/^\[|\]$/g, '')}/${literal === 6 ? 128 : 32}`);
      continue;
    }
    try {
      for (const ip of await resolve(clean)) {
        const family = net.isIP(ip);
        if (family) out.add(`${ip}/${family === 6 ? 128 : 32}`);
      }
    } catch {
      // Unresolvable host: leave it out. The gateway still starts; this is a
      // partial protection, not a claim that the host is excluded.
    }
  }
  return [...out];
}

/**
 * Why a TUN gateway start cannot even be attempted on this machine. Windows:
 * the wintun adapter creation needs administrator rights — a non-elevated
 * sing-box exits at startup with a device error, so refuse BEFORE spawning
 * with the real reason rather than letting the user read a cryptic one.
 */
export function tunGatewayStartRefusal(): string | null {
  // Explicit override for tests and for a deliberately elevated sidecar.
  if (process.env['NETPULSE_TUN_ALLOW_UNELEVATED']) return null;
  // Linux/macOS: TUN needs root too, but a privileged sidecar may legitimately
  // exist there, so do not invent a Windows-shaped refusal.
  if (process.platform !== 'win32') return null;
  // One owner for the privilege answer (`util/privileges`) — the admin status
  // route and this refusal must never disagree about whether we can create a
  // TUN adapter.
  if (isProcessElevated()) return null;
  return 'TUN mode needs administrator rights to create the TUN adapter (wintun). Restart the app with administrator rights, or use system-proxy mode.';
}

/** Reserve a port for the gateway's verification inbound and start the gateway. */
export async function startTunGateway(
  singboxBin: string,
  upstreamPort: number,
  bypass?: BypassRuleSet | null,
  readyTimeoutMs = 12_000,
  upstream: 'http' | 'socks' = 'http',
  excludeAddresses: string[] = [],
): Promise<{ ok: true; run: CoreRun; gatewayPort: number } | { ok: false; error: string }> {
  const gatewayPort = await reservePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-tun-gw-'));
  const cfgPath = path.join(tmpDir, 'gateway.json');
  fs.writeFileSync(cfgPath, JSON.stringify(buildTunGatewayConfig(upstreamPort, gatewayPort, { bypass, upstream, excludeAddresses })));

  // Readiness here proves the PROCESS is up (its mixed inbound answers TCP); it
  // does NOT prove the TUN device claimed the route — the tunnel service
  // verifies the TUN path with a real trace through the gateway after start.
  const started = await spawnCoreProcess({
    bin: singboxBin,
    args: ['run', '-c', cfgPath],
    readyPort: gatewayPort,
    readyTimeoutMs,
    tempDir: tmpDir,
    label: 'TUN gateway',
    // The device is the one thing this start can be blocked on that a plain
    // core start never is, so name it in the timeout text.
    timeoutMessage: (ms, output) =>
      startupReason(output, `TUN gateway did not become ready in ${ms}ms (device creation may be blocked)`),
  });
  if (!started.ok) return { ok: false, error: started.error };

  const { child, cleanup } = started.process;
  return {
    ok: true,
    run: {
      child,
      inboundPort: gatewayPort,
      cleanup,
      get stderrTail() {
        return started.process.output;
      },
    },
    gatewayPort,
  };
}

/**
 * Start a core with a generated config; resolves when its inbound accepts TCP
 * connections, or with an honest classified failure. `run.cleanup()` is always
 * safe to call, twice, or after a failed start.
 */
export async function startCore(
  engine: ResolvedEngine,
  config: ParsedNodeConfig,
  secret: string | null,
  readyTimeoutMs = 5_000,
  opts?: { bypass?: BypassRuleSet | null; dialThroughPort?: number | null; dns?: DnsThroughTunnel | null; _portRetried?: boolean },
): Promise<CoreStartResult> {
  const dialThroughPort = opts?.dialThroughPort ?? null;
  if (dialThroughPort != null) {
    // Refuse a wiring the engine provably ignores instead of shipping a
    // "chain" that is really a direct connection.
    const why = chainExitUnsupported(engine.id, config.protocol);
    if (why) return { ok: false, failure: 'engine_unavailable', error: why };
  }
  const inboundPort = await reservePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `netpulse-${engine.id}-`));
  const cfgPath = path.join(tmpDir, engine.id === 'hysteria' ? 'config.yaml' : 'core.json');
  const bypass = opts?.bypass ?? null;
  const dns = opts?.dns ?? null;

  if (engine.id === 'hysteria') {
    // The Hysteria2 client REQUIRES the node password — without it the server
    // rejects the session, so refuse here rather than blaming the node for a
    // missing local secret.
    if (!secret) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
      return {
        ok: false,
        failure: 'engine_unavailable',
        error: 'hysteria2 needs the node password and it is not in the vault — re-import this node to test it',
      };
    }
    fs.writeFileSync(cfgPath, buildHysteria2ClientConfig(config, secret, inboundPort));
  } else {
    const cfgJson = engine.id === 'sing-box'
      ? buildSingboxConfig(config, secret, inboundPort, bypass, dialThroughPort, dns)
      : buildXrayConfig(config, secret, inboundPort, bypass, dialThroughPort, dns); // xray + v2ray share the schema
    fs.writeFileSync(cfgPath, JSON.stringify(cfgJson));
  }

  const started = await spawnCoreProcess({
    bin: engine.bin,
    args: [...engine.args, '-c', cfgPath],
    readyPort: inboundPort,
    readyTimeoutMs,
    tempDir: tmpDir,
    label: 'core',
  });

  if (!started.ok) {
    // A port taken between the reservation above and the spawn is not the
    // node's or the core's fault: regenerate the config on a fresh port and
    // try ONCE more. (This rule used to be dead code: the handler that was
    // meant to catch it ran after the one that had already reported the
    // failure, so every clash was blamed on the config.)
    if (started.failure === 'port_clash' && !opts?._portRetried) {
      return startCore(engine, config, secret, readyTimeoutMs, { ...opts, _portRetried: true });
    }
    // A binary that could not be EXECUTED is a missing/blocked core, which is
    // the one failure the UI answers with an install offer — not a node result.
    const failure: EngineStartFailure =
      started.failure === 'spawn_error' || started.failure === 'port_clash'
        ? 'engine_unavailable'
        : 'engine_start_failed';
    return { ok: false, failure, error: started.error };
  }

  const { child, cleanup } = started.process;
  return {
    ok: true,
    run: {
      child,
      inboundPort,
      cleanup,
      get stderrTail() {
        return started.process.output;
      },
    },
  };
}

/**
 * Which engines can dial a protocol. Honest matrix: xray/v2ray have no
 * hysteria2/tuic outbounds; NO core supports shadowsocksr (it was removed
 * from sing-box and never existed in xray/v2ray) — advertising it made the
 * UI offer a test that can only fail.
 */
export function engineSupports(engine: ProxyEngineId, protocol: string): boolean {
  // The protocol's own client dials hysteria2 and nothing else.
  if (engine === 'hysteria') return protocol === 'hysteria2';
  if (engine === 'sing-box') return ['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic'].includes(protocol);
  return ['vless', 'vmess', 'trojan', 'shadowsocks'].includes(protocol); // xray, v2ray
}

/**
 * Shadowsocks ciphers that are AEAD (or none). The v2ray family dropped every
 * other method — measured on xray 26.3.27: `unknown cipher method: aes-256-cfb`
 * → the core exits during startup — while sing-box still carries them. Without
 * this check the engine picker hands such a node to xray and the only evidence
 * is a bare exit code.
 */
export function isAeadShadowsocksCipher(cipher: string): boolean {
  const c = cipher.trim().toLowerCase();
  return c === 'none' || c.includes('-gcm') || c.includes('poly1305') || c.startsWith('2022-blake3');
}

/**
 * Can this engine run THIS config? The checks a protocol name alone cannot make:
 * v2ray-core lacks Xray-only extensions (Reality, xhttp), and the v2ray family
 * cannot run non-AEAD shadowsocks ciphers at all.
 *
 * Refusing here means the picker chooses an engine that works (or reports an
 * honest, specific reason) instead of starting a core that dies with a cryptic
 * exit code.
 */
export function engineSupportsConfig(engine: ProxyEngineId, config: ParsedNodeConfig): { ok: true } | { ok: false; error: string } {
  if (engine === 'hysteria') {
    // Hysteria2 has exactly one obfuscation mode; anything else in the node's
    // params would be emitted as an invalid config the client exits on.
    const obfs = typeof config.extra?.['obfs'] === 'string' && config.extra['obfs'] ? config.extra['obfs'] : null;
    if (obfs && obfs !== 'salamander') {
      return { ok: false, error: `the Hysteria2 client only implements salamander obfuscation, not "${obfs}" (use sing-box for this node)` };
    }
  }
  if (engine !== 'sing-box' && config.protocol === 'shadowsocks') {
    const cipher = config.encryption ?? 'aes-256-gcm';
    if (!isAeadShadowsocksCipher(cipher)) {
      return { ok: false, error: `${engine}-core cannot run the shadowsocks cipher "${cipher}" (not AEAD — the v2ray family dropped those; use sing-box for this node)` };
    }
  }
  if (engine !== 'v2ray') return { ok: true };
  if (config.security === 'reality' || config.realityPublicKey) {
    return { ok: false, error: 'v2ray-core does not support Reality (use xray or sing-box for this node)' };
  }
  if (config.transport === 'xhttp') {
    return { ok: false, error: 'v2ray-core does not support the xhttp transport (use xray for this node)' };
  }
  return { ok: true };
}
