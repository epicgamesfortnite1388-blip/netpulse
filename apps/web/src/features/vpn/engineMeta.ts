import { PROXY_ENGINES } from '@netpulse/shared';

import type { ProxyEngineId } from '@netpulse/shared';

/**
 * Presentation + documented-fact metadata for the VPN surfaces.
 *
 * Everything here is either display metadata (label, accent, description) or a
 * DOCUMENTED capability of the engine — never a measurement. Measurements are
 * always read from the backend. Capability facts mirror the guards in
 * `apps/api/src/services/proxyCores.ts` (`engineSupports`, `engineSupportsConfig`,
 * `chainExitUnsupported`) so the UI cannot advertise a run that the core would
 * only fail at startup.
 */

/** One tab in the VPN section. */
export type VpnSurfaceId =
  | 'overview'
  | 'aether'
  | 'tunnel'
  | 'xray'
  | 'sing-box'
  | 'v2ray'
  | 'hysteria'
  | 'wireguard'
  | 'openvpn'
  | 'whitedns';

export interface VpnSurfaceMeta {
  id: VpnSurfaceId;
  label: string;
  /** One-line purpose, used in the tab tooltip. */
  blurb: string;
}

export const VPN_SURFACES: readonly VpnSurfaceMeta[] = [
  { id: 'overview', label: 'Overview', blurb: 'Live state of every engine in one grid' },
  { id: 'aether', label: 'Aether', blurb: 'Censorship-circumvention tunnel (MASQUE / WARP family)' },
  { id: 'tunnel', label: 'Proxy Tunnel', blurb: 'Route this machine through public nodes via local cores' },
  { id: 'xray', label: 'Xray', blurb: 'Reference core — best Reality / XTLS fidelity' },
  { id: 'sing-box', label: 'sing-box', blurb: 'Universal core — widest protocol coverage' },
  { id: 'v2ray', label: 'V2Ray', blurb: 'Original V2Ray core — legacy vmess / vless configs' },
  { id: 'hysteria', label: 'Hysteria2', blurb: "Hysteria2's own client — dials hysteria2 nodes natively" },
  { id: 'wireguard', label: 'WireGuard', blurb: 'Native WireGuard tunnel (elevated on Windows)' },
  { id: 'openvpn', label: 'OpenVPN', blurb: 'Native OpenVPN tunnel' },
  { id: 'whitedns', label: 'WhiteDNS Soar', blurb: 'DNS tunnel data-plane verification' },
] as const;

export interface ProxyCoreMeta {
  id: ProxyEngineId;
  label: string;
  /** Compact form for tab strips, where the full label would crowd the row. */
  shortLabel: string;
  tagline: string;
  description: string;
  /** Tailwind gradient for the engine glyph. */
  glyph: string;
  /** Solid colour for canvas / accent fills. */
  color: string;
  protocols: string[];
  strengths: string[];
  /** Documented limits — each maps to a real guard in proxyCores.ts. */
  limits: string[];
  /** Can this core dial through another core (nested-mode exit hop)? */
  chainExit: boolean;
  /** Official upstream, shown so the provenance of the binary is explicit. */
  repo: string;
}

/** Protocols from the shared catalog, so there is one source of truth. */
function sharedProtocols(id: ProxyEngineId): string[] {
  return PROXY_ENGINES.find((e) => e.id === id)?.protocols ?? [];
}

/**
 * The proxy cores, in the catalog's own order.
 *
 * Derived rather than hand-listed: every surface that enumerates cores reads
 * this, so adding a core to the shared catalog cannot leave a page behind.
 */
export const PROXY_CORE_IDS: readonly ProxyEngineId[] = PROXY_ENGINES.map((e) => e.id);

export const PROXY_CORE_META: Record<ProxyEngineId, ProxyCoreMeta> = {
  xray: {
    id: 'xray',
    label: 'Xray-core',
    shortLabel: 'Xray',
    tagline: 'Reference V2Ray core',
    description:
      'The modern reference core. Best fidelity for Reality and XTLS, and the default choice when no engine preference is set.',
    glyph: 'from-sky-500/25 to-cyan-400/10 text-sky-300',
    color: '#38bdf8',
    protocols: sharedProtocols('xray'),
    strengths: ['Reality & XTLS', 'xhttp transport', 'Can be a chain exit hop'],
    limits: ['No hysteria2 / tuic (UDP protocols)', 'Legacy Shadowsocks ciphers are refused'],
    chainExit: true,
    repo: 'github.com/XTLS/Xray-core',
  },
  'sing-box': {
    id: 'sing-box',
    label: 'sing-box',
    shortLabel: 'sing-box',
    tagline: 'Universal protocol core',
    description:
      'The widest protocol coverage of the three cores, and the only one that can dial UDP-based protocols (hysteria2, tuic) or run legacy Shadowsocks ciphers.',
    glyph: 'from-fuchsia-500/25 to-pink-400/10 text-fuchsia-300',
    color: '#e879f9',
    protocols: sharedProtocols('sing-box'),
    strengths: ['hysteria2 & tuic (UDP)', 'Every Shadowsocks cipher', 'Can be a chain exit hop'],
    limits: ['Only core that can dial hysteria2 / tuic nodes', 'No Xray-only extensions (xhttp) in the managed provider'],
    chainExit: true,
    repo: 'github.com/SagerNet/sing-box',
  },
  v2ray: {
    id: 'v2ray',
    label: 'V2Ray-core',
    shortLabel: 'V2Ray',
    tagline: 'Original V2Ray (v2fly)',
    description:
      'The original V2Ray core. Some legacy vmess / vless configurations only run here, so it is kept as a third option rather than dropped.',
    glyph: 'from-emerald-500/25 to-teal-400/10 text-emerald-300',
    color: '#34d399',
    protocols: sharedProtocols('v2ray'),
    strengths: ['Legacy vmess / vless compatibility', 'Independent implementation of the same schema'],
    limits: [
      'No Reality support',
      'No xhttp transport',
      'Cannot chain: it ignores the dial-through wiring, so it can never be a nested-mode exit hop',
      'AEAD Shadowsocks ciphers only',
    ],
    chainExit: false,
    repo: 'github.com/v2fly/v2ray-core',
  },
  hysteria: {
    id: 'hysteria',
    label: 'Hysteria2',
    shortLabel: 'Hysteria2',
    tagline: "Hysteria2's own client",
    description:
      'The hysteria2 project\u2019s own client binary, so a hysteria2 node can be reached without sing-box installed \u2014 and a hysteria2 measurement can be checked against an independent implementation. It dials hysteria2 and nothing else.',
    glyph: 'from-violet-500/25 to-indigo-400/10 text-violet-300',
    color: '#a78bfa',
    protocols: sharedProtocols('hysteria'),
    strengths: ['The protocol\u2019s own implementation', 'Brutal congestion control from the node\u2019s own bandwidth hints', 'Salamander obfuscation'],
    limits: [
      'hysteria2 only \u2014 it is never chosen for any other protocol',
      'No local UDP relay: its inbound here is HTTP (this app probes and hands the OS proxy over HTTP CONNECT)',
      'No split-tunnel bypass rules and no DNS block, so it is skipped while either is on',
      'Cannot join a chain: the client has no dial-through option',
    ],
    chainExit: false,
    repo: 'github.com/apernet/hysteria',
  },
};

export type ManagedProviderId = 'wireguard' | 'openvpn' | 'singbox' | 'aether';

export interface ManagedProviderMeta {
  id: ManagedProviderId;
  label: string;
  tagline: string;
  /** Linear gradient + text colour for the glyph. */
  glyph: string;
  color: string;
  /** How this provider gets its binary — it is never bundled with the app. */
  binaryNote: string;
  /** Short capability facts shown in the matrix (documented, not measured). */
  facts: string[];
}

export const MANAGED_PROVIDER_META: Record<ManagedProviderId, ManagedProviderMeta> = {
  wireguard: {
    id: 'wireguard',
    label: 'WireGuard',
    tagline: 'Native WireGuard tunnel',
    glyph: 'from-rose-500/25 to-orange-400/10 text-rose-300',
    color: '#fb7185',
    binaryNote:
      'Driven by the WireGuard for Windows client installed on this machine. On Windows the tunnel is installed through a single per-action UAC prompt — the app never runs anything elevated on its own.',
    facts: ['Import [Interface]/[Peer] .conf text', 'Elevated install via the Rust bridge (one prompt)', 'Live handshake age and endpoint latency'],
  },
  openvpn: {
    id: 'openvpn',
    label: 'OpenVPN',
    tagline: 'Native OpenVPN tunnel',
    glyph: 'from-amber-500/25 to-yellow-400/10 text-amber-300',
    color: '#fbbf24',
    binaryNote:
      'Driven by the OpenVPN client installed on this machine. The .ovpn text is parsed and the secrets moved into the encrypted vault before launch.',
    facts: ['Import .ovpn text (remote + <ca>)', 'Runs as an unprivileged child process', 'Secrets stay in the encrypted vault'],
  },
  singbox: {
    id: 'singbox',
    label: 'sing-box (managed tunnel)',
    tagline: 'Share-link tunnel in proxy mode',
    glyph: 'from-fuchsia-500/25 to-violet-400/10 text-fuchsia-300',
    color: '#e879f9',
    binaryNote:
      'Uses the app-managed sing-box core installed on this tab — installing the core is what makes this provider available.',
    facts: ['Import vless / vmess / trojan / ss share links', 'Unprivileged proxy mode on 127.0.0.1:2080', 'No elevation, no system routes'],
  },
  aether: {
    id: 'aether',
    label: 'Aether',
    tagline: 'Censorship-circumvention tunnel',
    glyph: 'from-violet-500/30 to-cyan-400/10 text-violet-300',
    color: '#a855f7',
    binaryNote:
      'Installed from the official CluvexStudio/Aether GitHub releases with SHA256 verification against the published digest, then self-checked with `-v` before use.',
    facts: ['MASQUE / WARP-family protocols', 'Serves a local SOCKS5 proxy (127.0.0.1:1819)', 'Scans for a working route out of a filtered network'],
  },
};

/**
 * Human label for any provider id the backend may report, including ids this
 * UI does not have a surface for ('custom' is status-only in the registry).
 */
export const PROVIDER_LABEL: Record<string, string> = {
  wireguard: 'WireGuard',
  openvpn: 'OpenVPN',
  singbox: 'sing-box',
  aether: 'Aether',
  custom: 'Custom engine',
};
