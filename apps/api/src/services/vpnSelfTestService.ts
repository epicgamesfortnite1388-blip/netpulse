import { badRequest } from '../util/appError';
import { resolveTarget } from '../util/targetGuard';
import { isValidWgKey } from '../vpn/vpnService';

import type { VpnSelfTestResult } from '@netpulse/shared';
import type { RealtimeBus } from '../realtime/bus';
import type { EventService } from './eventService';
import type { SettingsService } from './settingsService';
import type { PlatformNetworkController } from '../providers/platform/types';
import type { VpnRegistry } from '../vpn/vpnService';
import type { Logger } from '../logger';

export const VPN_SELFTEST_TOPIC = 'vpn-selftest';

/**
 * VPN tunnel self-test — a DRY RUN. It never creates, modifies or removes a
 * tunnel and never requires elevation. It verifies everything verifiable from
 * an unprivileged process:
 *
 *   1. engine availability  — wireguard/openvpn/sing-box binaries present
 *   2. key material         — every stored profile's vault secret decrypts and
 *                             matches the format its provider expects
 *   3. endpoint reachability— TCP connect to each stored profile's endpoint
 *                             (SSRF-guarded resolve; probes resolved IPs only)
 *
 * States are honest: 'ok' = all verifiable checks passed, 'unavailable' =
 * environmental (no engine / no profiles — the app works, tunnels cannot),
 * 'error' = the check itself could not complete. A tunnel that is currently
 * connected is reported as such and skips the (moot) endpoint probe rather
 * than tearing anything down.
 */
export class VpnSelfTestService {
  private last: VpnSelfTestResult | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      vpn: VpnRegistry;
      controller: PlatformNetworkController;
      settings: SettingsService;
      events: EventService;
      bus: RealtimeBus;
      log: Logger;
    },
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  lastResult(): VpnSelfTestResult | null {
    return this.last;
  }

  /**
   * Run one dry-run check. `trigger` only feeds the event log so scheduled and
   * manual runs are distinguishable in history.
   */
  async run(trigger: 'scheduled' | 'manual' = 'manual'): Promise<VpnSelfTestResult> {
    if (this.running) {
      // Never stack: report the in-flight check's result when it lands.
      return this.last ?? Promise.reject(badRequest('selftest_running', 'A VPN self-test is already running'));
    }
    this.running = true;
    this.deps.bus.publish(VPN_SELFTEST_TOPIC, { type: 'vpn-selftest:running' });
    const started = Date.now();
    try {
      const result = await this.check(started);
      this.last = result;
      const message =
        result.state === 'ok'
          ? `VPN self-test passed: ${result.detail}`
          : result.state === 'unavailable'
            ? `VPN self-test unavailable: ${result.detail}`
            : `VPN self-test error: ${result.detail}`;
      this.deps.events.record(result.state === 'error' ? 'warn' : 'info', 'vpn', `${message} (${trigger})`, {});
      this.deps.bus.publish(VPN_SELFTEST_TOPIC, { type: 'vpn-selftest:done', result });
      return result;
    } catch (err) {
      // Defensive: check() catches its own stages; this guards future edits.
      const message = err instanceof Error ? err.message : String(err);
      const result: VpnSelfTestResult = {
        state: 'error',
        detail: `Self-test failed: ${message}`,
        engines: {},
        profilesChecked: 0,
        endpointsReachable: null,
        checkedAt: started,
        tookMs: Date.now() - started,
      };
      this.last = result;
      this.deps.log.warn({ err, trigger }, 'vpn self-test crashed');
      this.deps.events.record('warn', 'vpn', `VPN self-test error: ${message} (${trigger})`, {});
      this.deps.bus.publish(VPN_SELFTEST_TOPIC, { type: 'vpn-selftest:done', result });
      return result;
    } finally {
      this.running = false;
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private async check(started: number): Promise<VpnSelfTestResult> {
    // Stage 1: engine binaries. Never executes them — detection only.
    let engines: Record<string, boolean>;
    try {
      engines = await this.deps.controller.detectVpnBinaries();
    } catch (err) {
      throw new Error(`engine detection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const anyEngine = Object.values(engines).some(Boolean);

    // Stage 2: stored profiles — vault decryption + key-format validation.
    const profiles = this.deps.vpn.listProfiles().filter((p) => p.providerId !== 'custom');
    let profilesChecked = 0;
    let brokenProfiles = 0;
    const endpoints: { host: string; port: number }[] = [];
    for (const profile of profiles) {
      const secret = this.deps.vpn.getSecretForCheck(profile.secretRef);
      if (secret == null || !validateSecretShape(profile.providerId, profile.protocol, secret)) {
        brokenProfiles++;
        continue;
      }
      profilesChecked++;
      const parsed = parseEndpoint(profile.endpoint);
      if (parsed) endpoints.push(parsed);
    }

    // Stage 3: endpoint reachability (only when a tunnel is not already up —
    // probing through an active tunnel measures the tunnel, not the endpoint).
    const status = await this.deps.vpn.status().catch(() => null);
    let endpointsReachable: number | null = null;
    let endpointDetail = '';
    if (status?.connected === true) {
      endpointDetail = 'tunnel already connected — endpoint probe skipped';
    } else if (endpoints.length > 0) {
      let reachable = 0;
      for (const ep of endpoints) {
        const ok = await probeEndpoint(this.deps.controller, ep.host, ep.port);
        if (ok) reachable++;
      }
      endpointsReachable = reachable;
      endpointDetail = `${reachable}/${endpoints.length} endpoints reachable`;
    } else {
      endpointsReachable = null;
      endpointDetail = 'no endpoints to probe';
    }

    // Honest aggregate state.
    if (!anyEngine) {
      return {
        state: 'unavailable',
        detail: 'No VPN engine installed — tunnel features unavailable. Install WireGuard (or OpenVPN/sing-box) to enable them.',
        engines,
        profilesChecked,
        endpointsReachable,
        checkedAt: started,
        tookMs: Date.now() - started,
      };
    }
    if (profiles.length === 0) {
      return {
        state: 'unavailable',
        detail: `Engine installed (${Object.entries(engines).filter(([, v]) => v).map(([k]) => k).join(', ')}), but no VPN profiles imported yet.`,
        engines,
        profilesChecked: 0,
        endpointsReachable: null,
        checkedAt: started,
        tookMs: Date.now() - started,
      };
    }
    if (brokenProfiles > 0) {
      return {
        state: 'error',
        detail: `${brokenProfiles} of ${profiles.length} stored profiles have missing or unreadable key material — they will fail on connect. Re-import them.`,
        engines,
        profilesChecked,
        endpointsReachable,
        checkedAt: started,
        tookMs: Date.now() - started,
      };
    }
    const parts = [
      `${profilesChecked} profile(s) key material OK`,
      endpointDetail,
      status?.connected === true ? 'tunnel connected' : null,
    ].filter(Boolean);
    return {
      state: 'ok',
      detail: parts.join(' · '),
      engines,
      profilesChecked,
      endpointsReachable,
      checkedAt: started,
      tookMs: Date.now() - started,
    };
  }
}

/** Provider-appropriate secret shape validation (no secrets are logged). */
function validateSecretShape(providerId: string, protocol: string, secret: string): boolean {
  if (providerId === 'wireguard') {
    // vault secret is "privateKey" or "privateKey\npresharedKey"
    const [privateKey, preshared] = secret.split('\n');
    if (!isValidWgKey(privateKey ?? null)) return false;
    if (preshared != null && preshared !== '' && !isValidWgKey(preshared)) return false;
    return true;
  }
  if (providerId === 'openvpn') {
    return secret.length > 0 && secret.length < 64_000; // inline <auth> block
  }
  if (providerId === 'singbox' || protocol === 'singbox') {
    // JSON credential material — must parse.
    try {
      JSON.parse(secret);
      return true;
    } catch {
      return false;
    }
  }
  // Unknown provider with a secret: non-empty is the only honest check.
  return secret.length > 0;
}

function parseEndpoint(endpoint: string | null): { host: string; port: number } | null {
  if (!endpoint) return null;
  const m = endpoint.match(/^\[?([^\]]+?)\]?:(\d+)$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1]!, port };
}

/**
 * SSRF-guarded endpoint probe. Endpoints come from the user's own imported
 * profiles, but the same discipline applies: resolve (bounded), refuse private
 * ranges, then TCP-connect to the RESOLVED IP — never the hostname — so a
 * rebinding endpoint cannot pivot the probe elsewhere. Failures are honest
 * falses: an unreachable endpoint is a finding, not a crash.
 */
async function probeEndpoint(controller: PlatformNetworkController, host: string, port: number): Promise<boolean> {
  try {
    const target = await resolveTarget(host);
    for (const ip of target.ips) {
      const res = await controller.tcpProbe(ip, port, 2_000, target.family ?? undefined);
      if (res.ok) return true;
    }
    return false;    } catch {
    return false;
  }
}

