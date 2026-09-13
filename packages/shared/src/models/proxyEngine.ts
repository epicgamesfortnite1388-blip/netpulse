/**
 * Proxy-test core engines.
 *
 * Public node configs are V2Ray/Xray-flavored; two local cores can dial them:
 *   - sing-box: universal (vless/vmess/trojan/ss/ssr + hy2/tuic)
 *   - xray:     the reference V2Ray core (vless/vmess/trojan/ss, best Reality
 *               and XTLS support)
 * The engine used for a proxy test is recorded on the result so measurements
 * are attributable.
 */

export type ProxyEngineId = 'sing-box' | 'xray';

export const PROXY_ENGINES: ReadonlyArray<{
  id: ProxyEngineId;
  label: string;
  binaries: string[];
  protocols: string[];
}> = [
  {
    id: 'sing-box',
    label: 'sing-box',
    binaries: ['sing-box.exe', 'sing-box'],
    protocols: ['vless', 'vmess', 'trojan', 'shadowsocks', 'shadowsocksr', 'hysteria2', 'tuic'],
  },
  {
    id: 'xray',
    label: 'Xray-core',
    binaries: ['xray.exe', 'xray'],
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
