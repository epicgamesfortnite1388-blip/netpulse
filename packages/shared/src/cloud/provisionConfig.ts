/**
 * Provisioned cloud config → share link the app can actually dial.
 *
 * Lives in `shared` (not in the web app) for one reason: the conversion is the
 * only thing between "the Worker issued you a config" and "the app's Connect
 * button uses a config the server still accepts". It must be testable without a
 * browser, a sidecar, or a network — and a script must be able to run it against
 * real provisioned output to prove the two halves agree.
 *
 * A share link (not a sing-box profile) is the target because that is what the
 * app's tunnel engine consumes: `POST /api/v1/nodes/import` parses the link,
 * vaults the credential, and `POST /api/v1/vpn/tunnel/start` dials it with the
 * bundled xray core. That core is the one that actually completes REALITY
 * against the deployed server; sing-box 1.12/1.13 fails REALITY verification on
 * the same credential, so a sing-box profile would look healthy and never pass
 * traffic.
 *
 * Every link is emitted in the standard shapes the app's own parser reads
 * (`nodeParsers.ts`), and `scripts/proof-provision-import.ts` round-trips each
 * one through that parser before anything is imported.
 */

export const PROFILE_NAME_PREFIX = 'NetPulse · ';

export interface ProvisionedProfile {
  id: string;
  name: string;
  protocol: string;
  /** JSON string of the client config the Worker generated. */
  config: string;
}

export interface LinkImport {
  provider: 'nodes';
  name: string;
  link: string;
}

export type LinkConversion = { ok: true; request: LinkImport } | { ok: false; protocol: string; reason: string };

export interface ImportSummary {
  /** Links newly stored as nodes. */
  imported: number;
  /** Links that already existed (a refresh of the same entitlement). */
  present: number;
  skipped: Array<{ protocol: string; reason: string }>;
  failed: Array<{ protocol: string; reason: string }>;
}

type CloudConfig = Record<string, unknown>;

/** Plan protocols that can be expressed as a link the tunnel can dial. */
const LINKABLE_PROTOCOLS = new Set([
  'xray-vless-reality',
  'xray-vmess-ws',
  'xray-vless-ws-tls',
  'xray-trojan-tls',
]);

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function authorify(host: string, port: number): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]:${port}` : `${host}:${port}`;
}

function remark(name: string): string {
  return encodeURIComponent(`${PROFILE_NAME_PREFIX}${name}`);
}

/**
 * Cloud config → one share link.
 *
 * A missing credential or REALITY key is refused rather than emitted: a link
 * without them imports cleanly and then fails at connect time, which is the
 * exact "profile looks healthy, tunnel dies" failure this module exists to
 * remove.
 */
export function toShareLink(profile: ProvisionedProfile): LinkConversion {
  let config: CloudConfig;
  try {
    const parsed = JSON.parse(profile.config) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, protocol: profile.protocol, reason: 'config is not an object' };
    }
    config = parsed as CloudConfig;
  } catch {
    return { ok: false, protocol: profile.protocol, reason: 'config is not valid JSON' };
  }

  if (!LINKABLE_PROTOCOLS.has(profile.protocol)) {
    return {
      ok: false,
      protocol: profile.protocol,
      reason:
        profile.protocol === 'hysteria2'
          ? 'Hysteria 2 needs its obfuscation settings, which a node link cannot carry — copy this config into the Hysteria client instead'
          : `protocol "${profile.protocol}" cannot be expressed as a tunnel link`,
    };
  }

  const server = str(config.server);
  if (!server) return { ok: false, protocol: profile.protocol, reason: 'config has no server address' };
  const port = num(config.port, 443);
  const name = profile.name || profile.protocol;

  switch (profile.protocol) {
    case 'xray-vless-reality': {
      const uuid = str(config.id);
      if (!uuid) return { ok: false, protocol: profile.protocol, reason: 'config has no credential' };
      const sni = str(config.serverName);
      const publicKey = str(config.publicKey);
      if (!sni || !publicKey) return { ok: false, protocol: profile.protocol, reason: 'REALITY config has no server name or public key' };
      const params = new URLSearchParams({
        type: 'tcp',
        security: 'reality',
        sni,
        pbk: publicKey,
        sid: str(config.shortId),
        fp: str(config.fingerprint) || 'chrome',
      });
      const flow = str(config.flow);
      if (flow) params.set('flow', flow);
      return { ok: true, request: { provider: 'nodes', name, link: `vless://${uuid}@${authorify(server, port)}?${params.toString()}#${remark(name)}` } };
    }
    case 'xray-vmess-ws': {
      const uuid = str(config.id);
      if (!uuid) return { ok: false, protocol: profile.protocol, reason: 'config has no credential' };
      // vmess links are base64(JSON) in the v2rayN shape — the shape this
      // app's parser and every other client read.
      const payload = {
        v: '2',
        ps: `${PROFILE_NAME_PREFIX}${name}`,
        add: server,
        port,
        id: uuid,
        aid: num(config.alterId, 0),
        scy: 'auto',
        net: 'ws',
        type: 'none',
        host: '',
        path: str(config.path) || '/',
        tls: '',
        sni: '',
      };
      return { ok: true, request: { provider: 'nodes', name, link: `vmess://${base64(JSON.stringify(payload))}` } };
    }
    case 'xray-vless-ws-tls': {
      const uuid = str(config.id);
      if (!uuid) return { ok: false, protocol: profile.protocol, reason: 'config has no credential' };
      const sni = str(config.serverName) || server;
      const params = new URLSearchParams({
        type: 'ws',
        security: 'tls',
        sni,
        path: str(config.path) || '/',
        host: str(config.host) || sni,
        fp: 'chrome',
      });
      return { ok: true, request: { provider: 'nodes', name, link: `vless://${uuid}@${authorify(server, port)}?${params.toString()}#${remark(name)}` } };
    }
    case 'xray-trojan-tls': {
      const password = str(config.password);
      if (!password) return { ok: false, protocol: profile.protocol, reason: 'config has no credential' };
      const params = new URLSearchParams({ sni: str(config.serverName) || server, type: 'tcp' });
      return {
        ok: true,
        request: { provider: 'nodes', name, link: `trojan://${encodeURIComponent(password)}@${authorify(server, port)}?${params.toString()}#${remark(name)}` },
      };
    }
    default:
      return { ok: false, protocol: profile.protocol, reason: `protocol "${profile.protocol}" cannot be expressed as a tunnel link` };
  }
}

/** base64 of a UTF-8 string — `btoa` is unavailable outside a browser. */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  // `globalThis.btoa` exists in browsers and Node 16+; the fallback keeps this
  // usable from a plain test runner.
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(text, 'utf8').toString('base64');
}

/**
 * The sentence to show after an import, or null when it fully succeeded.
 *
 * Kept next to the import so the wording cannot drift from what actually
 * happened: a partial import must not read like success, and a protocol that
 * cannot be a node (Hysteria 2 is copy-only here) must be named as such rather
 * than counted as a failure.
 */
export function describeImport(summary: ImportSummary, total: number): string | null {
  if (summary.failed.length > 0) {
    return `Added ${summary.imported} of ${total} configs to the app — ${summary.failed.length} could not be imported.`;
  }
  if (summary.imported === 0) {
    return 'Your subscription returned configs, but none of them could be added to the app.';
  }
  if (summary.skipped.length > 0) {
    return `Added ${summary.imported} config(s) to the app. ${summary.skipped.length} protocol(s) can only be copied.`;
  }
  return null;
}
