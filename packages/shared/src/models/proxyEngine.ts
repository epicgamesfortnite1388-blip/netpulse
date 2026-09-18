/**
 * Proxy-test core engines.
 *
 * Public node configs are mostly V2Ray/Xray-flavored; four local cores can dial
 * them:
 *   - xray:     the modern reference core (vless/vmess/trojan/ss, best Reality
 *               and XTLS support)
 *   - sing-box: universal (vless/vmess/trojan/ss + hy2/tuic)
 *   - v2ray:    the original V2Ray core (v2fly); some legacy vmess/vless
 *               configs only run on it
 *   - hysteria: the Hysteria2 client itself, dialling hysteria2 nodes natively
 *               (sing-box can also speak hysteria2; this one is the protocol's
 *               own implementation, so it is the independent check on it)
 * The engine used for a proxy test is recorded on the result so measurements
 * are attributable.
 */

export type ProxyEngineId = 'sing-box' | 'xray' | 'v2ray' | 'hysteria';

/**
 * Protocols a stored node can be promoted into a sing-box ENGINE PROFILE from.
 *
 * Deliberately narrower than what sing-box can *dial* (`PROXY_ENGINES.protocols`
 * includes hysteria2 and tuic): a profile is built by rebuilding the node's
 * share link and parsing it, and hysteria2/tuic have no share-link form this
 * importer accepts. Kept in shared so the UI can decline a node before offering
 * the action, instead of letting the server refuse it after a click.
 */
export const ENGINE_PROFILE_PROTOCOLS = ['vless', 'vmess', 'trojan', 'shadowsocks'] as const;

/** Can this node's protocol become a named engine profile at all? */
export function canBecomeEngineProfile(protocol: string): boolean {
  return (ENGINE_PROFILE_PROTOCOLS as readonly string[]).includes(protocol);
}

export const PROXY_ENGINES: ReadonlyArray<{
  id: ProxyEngineId;
  label: string;
  binaries: string[];
  protocols: string[];
}> = [
  {
    id: 'xray',
    label: 'Xray-core',
    binaries: ['xray.exe', 'xray'],
    protocols: ['vless', 'vmess', 'trojan', 'shadowsocks'],
  },
  {
    id: 'sing-box',
    label: 'sing-box',
    binaries: ['sing-box.exe', 'sing-box'],
    protocols: ['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic'],
  },
  {
    id: 'v2ray',
    label: 'V2Ray-core',
    binaries: ['v2ray.exe', 'v2ray'],
    protocols: ['vless', 'vmess', 'trojan', 'shadowsocks'],
  },
  {
    id: 'hysteria',
    label: 'Hysteria2',
    binaries: ['hysteria.exe', 'hysteria'],
    // The protocol's own client: it dials hysteria2 and nothing else, so it is
    // only ever selected for a hysteria2 node.
    protocols: ['hysteria2'],
  },
];

/** Live availability of the proxy cores on this machine. */
export interface ProxyEngineStatus {
  engines: Array<{
    id: ProxyEngineId;
    label: string;
    available: boolean;
    /** resolved binary path when available */
    path: string | null;
    /** `xray version` / `sing-box version` output line when cheaply available */
    version: string | null;
    protocols: string[];
  }>;
  /** which engine proxy tests will use (from settings preference + availability) */
  preferred: ProxyEngineId | 'auto';
  /** the engine that will actually be used next, or null if none installed */
  effective: ProxyEngineId | null;
}

/** Engine attribution on a proxy test result. */
export interface ProxyEngineUse {
  engine: ProxyEngineId;
}

/**
 * Latest published release of one core, as read from its official GitHub
 * releases (engine manager's "update available" check). `error` is set —
 * honestly, per engine — when the lookup itself could not be completed, so the
 * UI never presents a stale or invented "latest" version.
 */
export interface EngineLatestRelease {
  id: ProxyEngineId;
  /** release tag as published (e.g. "v1.14.0"), null when unavailable */
  latestTag: string | null;
  /** the release's own page, for a user who wants to read the notes */
  url: string | null;
  /** set when this engine's lookup failed (rate limit, offline, no release) */
  error: string | null;
}

/** Response of the engine manager's release check (cached server-side). */
export interface EngineReleaseCheck {
  releases: EngineLatestRelease[];
  checkedAt: number;
  /** true when this answer came from the server's cache, not a fresh lookup */
  cached: boolean;
}

/**
 * Is the installed core already at the latest published tag?
 *
 * Version strings differ per core ("Xray 26.3.27 (…)", "sing-box version
 * 1.14.0", "V2Ray 5.53.0 (…)", "Version: v2.12.3"), and release tags carry a
 * leading "v" — or, for projects that version per component, a prefix such as
 * Hysteria's "app/v2.12.3". Only a leading non-numeric prefix is stripped, so
 * the comparison looks for the release's actual version number. Deliberately
 * conservative: null (unknown) unless that number literally appears in the
 * installed version line — never a guess.
 */
export function engineVersionIsCurrent(installedLine: string | null, latestTag: string | null): boolean | null {
  if (!installedLine || !latestTag) return null;
  // "v1.14.0" → "1.14.0"; "app/v2.12.3" → "2.12.3"
  const want = latestTag.replace(/^[^0-9]*/i, '');
  if (want.length === 0) return null;
  return installedLine.includes(want);
}
