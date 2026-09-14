/**
 * Proxy-test core engines.
 *
 * Public node configs are V2Ray/Xray-flavored; three local cores can dial them:
 *   - xray:     the modern reference core (vless/vmess/trojan/ss, best Reality
 *               and XTLS support)
 *   - sing-box: universal (vless/vmess/trojan/ss + hy2/tuic)
 *   - v2ray:    the original V2Ray core (v2fly); some legacy vmess/vless
 *               configs only run on it
 * The engine used for a proxy test is recorded on the result so measurements
 * are attributable.
 */

export type ProxyEngineId = 'sing-box' | 'xray' | 'v2ray';

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
