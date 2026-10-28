/**
 * VPN client-config generation.
 *
 * Builds an importable client config for each protocol key a plan can entitle.
 * Values below mirror the live NetPulse infrastructure (see
 * /opt/netpulse-xray/config.json, /opt/netpulse-hysteria/config.yaml and the
 * microsocks unit on 206.1.96.89). Every credential-carrying profile takes a
 * `credential` that belongs to ONE account (see vpn-users.ts) — there is no
 * fallback to a shared server secret, because a profile carrying one could not
 * be revoked. The only shared value left is Hysteria's salamander obfs
 * password, which is an obfuscation layer, not an identity.
 *
 * This lives outside `index.ts` because it has two callers that must agree
 * byte-for-byte: provisioning mints the first config, and rotating a leaked
 * credential rebuilds the SAME config with the new secret. Two copies of the
 * protocol switch would drift, and the drift would only show up as a client
 * that cannot connect after a rotation.
 */

import type { Env } from './auth';

export type VpnConfigGen = { ok: boolean; name?: string; endpoint?: string | null; config: Record<string, unknown>; reason?: string };

export function generateVpnConfig(protocol: string, env: Env, credential: string): VpnConfigGen {
  const server = '206.1.96.89';
  const missing = (what: string): VpnConfigGen => ({ ok: false, reason: `${what} is not configured on this deployment`, config: {} });

  const realityBase = {
    protocol: 'vless',
    server,
    port: 443,
    security: 'reality',
    network: 'tcp',
    flow: 'xtls-rprx-vision',
    serverName: 'www.microsoft.com',
    fingerprint: 'chrome',
    // Derived from the live server private key with `xray x25519 -i`; a stale
    // value here makes every Reality profile fail its handshake.
    publicKey: 'CAS1AR2c9NrFKDMP1JVMIHx1y4_nxY8HqlemAGclsgU',
    shortId: '674622f7',
    spiderX: '/',
  } as Record<string, unknown>;

  switch (protocol) {
    case 'xray-vless-reality': {
      // `credential` is this user's own UUID, registered in vpn_credentials and
      // written into the inbound by the VPS reconciler.
      return {
        ok: true,
        name: 'Xray VLESS Reality',
        endpoint: `${server}:443`,
        config: { ...realityBase, id: credential, encryption: 'none' },
      };
    }
    case 'xray-vmess-ws': {
      return {
        ok: true,
        name: 'Xray VMess WS',
        endpoint: `${server}:8443`,
        config: {
          protocol: 'vmess',
          server,
          port: 8443,
          id: credential,
          alterId: 0,
          security: 'none',
          network: 'ws',
          path: '/np-vmess',
        },
      };
    }
    case 'xray-vless-ws-tls': {
      return {
        ok: true,
        name: 'Xray VLESS WS+TLS',
        endpoint: `${server}:2053`,
        config: {
          protocol: 'vless',
          server,
          port: 2053,
          id: credential,
          encryption: 'none',
          network: 'ws',
          security: 'tls',
          serverName: '206-1-96-89.sslip.io',
          path: '/np-vless',
          host: '206-1-96-89.sslip.io',
        },
      };
    }
    case 'xray-trojan-tls': {
      return {
        ok: true,
        name: 'Xray Trojan TLS',
        endpoint: `${server}:2087`,
        config: { protocol: 'trojan', server, port: 2087, password: credential, security: 'tls', serverName: '206-1-96-89.sslip.io' },
      };
    }
    case 'hysteria2': {
      if (!env.VPN_HYSTERIA_OBFS_PASSWORD) return missing('VPN_HYSTERIA_OBFS_PASSWORD');
      return {
        ok: true,
        name: 'Hysteria 2',
        endpoint: `${server}:8443`,
        config: {
          protocol: 'hysteria2',
          server,
          port: 8443,
          password: credential,
          obfs: { type: 'salamander', salamander: { password: env.VPN_HYSTERIA_OBFS_PASSWORD } },
          // The server certificate is issued for this name; a mismatched SNI
          // with skip-verify does not complete the QUIC handshake (verified
          // against hysteria 2.6.x), so pin the real hostname instead.
          tls: { serverName: '206-1-96-89.sslip.io' },
        },
      };
    }
    case 'whitedns-soar': {
      // NOT reachable from provisioning: `whitedns-soar` is not a per-user
      // protocol, so `/provision` stops before generating a config and reports
      // `no_per_user_identity` (pinned by a test in provision.test.ts). The
      // zone and key below are ONE shared tunnel identity, so an account that
      // lapsed would keep resolving through it forever — do not route a plan
      // around the skip to "enable" this profile. It becomes a real
      // entitlement only when the panel issues per-user zones and revokes
      // them, at which point this block must take that identity as input.
      return {
        ok: true,
        name: 'WhiteDNS Soar',
        endpoint: `${server}:53`,
        config: {
          protocol: 'whitedns',
          zone: 'gb6ysaxnm3z4r7ffwzbn5.soar.abystral.dpdns.org',
          server,
          pubkey: 'HRLjqBdOuVIByX8E95m+cd2Ah7weaD2azWHu2d24WMU=',
        },
      };
    }
    default: {
      return { ok: false, reason: `unsupported protocol: ${protocol}`, config: {} };
    }
  }
}
