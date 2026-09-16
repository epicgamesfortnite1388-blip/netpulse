import { describe, expect, it } from 'vitest';

import { normalizeBypass, normalizeIpRule, bypassIsEmpty, bypassSummary } from '../src/models/vpnBypass';
import {
  applyGatewayFailure,
  applyGatewaySuccess,
  gatewayScore,
  parseGatewayMemory,
  rankGatewaysForConnect,
  GATEWAY_MEMORY_MAX,
} from '../src/models/vpnGateway';

import type { GatewayMemoryEntry } from '../src/models/vpnGateway';

/**
 * Split-tunnel rule normalization: user input is messy (URLs, wildcards,
 * pasted paths) and the contract is that we reduce what we can and REFUSE
 * what we cannot parse — never reinterpret an entry as some other host.
 */
describe('normalizeBypass', () => {
  it('reduces pasted URLs and wildcards to bare suffixes', () => {
    const rs = normalizeBypass({
      enabled: true,
      domains: ['https://Bank.Example.com/login?x=1', '*.cdn.example.net', '.local.test', 'plain.example'],
      ips: ['10.0.0.0/8', ' 192.168.1.5 ', '2001:db8::/32'],
      ports: [443, 80, 443],
      lan: true,
    });
    expect(rs.domains).toEqual(['bank.example.com', 'cdn.example.net', 'local.test', 'plain.example']);
    expect(rs.ips).toEqual(['10.0.0.0/8', '192.168.1.5', '2001:db8::/32']);
    expect(rs.ports).toEqual([80, 443]);
  });

  it('drops entries that are not plausible hosts or addresses', () => {
    const rs = normalizeBypass({
      enabled: true,
      domains: ['has space', 'http://', '-leading.example', '', 'ok.example'],
      ips: ['999.1.1.1', '10.0.0.0/99', 'not-an-ip', '10.1.1.1'],
      ports: [0, 70_000, 22],
      lan: false,
    });
    expect(rs.domains).toEqual(['ok.example']);
    expect(rs.ips).toEqual(['10.1.1.1']);
    expect(rs.ports).toEqual([22]);
  });

  it('bounds each list so a hostile payload cannot bloat a core config', () => {
    const many = Array.from({ length: 500 }, (_, i) => `h${i}.example`);
    const rs = normalizeBypass({ enabled: true, domains: many, ips: [], ports: [], lan: false });
    expect(rs.domains.length).toBe(200);
  });

  it('is inert when nothing is configured', () => {
    const rs = normalizeBypass({ enabled: true, domains: [], ips: [], ports: [], lan: false });
    expect(bypassIsEmpty(rs)).toBe(true);
    expect(bypassSummary(rs)).toBeNull();
  });

  it('LAN-bypass alone is not inert — it changes routing', () => {
    const rs = normalizeBypass({ enabled: true, domains: [], ips: [], ports: [], lan: true });
    expect(bypassIsEmpty(rs)).toBe(false);
    expect(bypassSummary(rs)).toBe('LAN');
  });

  it('treats a null input as no rules but keeps LAN bypass on', () => {
    expect(normalizeBypass(null)).toEqual({ domains: [], ips: [], ports: [], lan: true });
  });

  it('accepts a bare address and rejects a bad CIDR prefix', () => {
    expect(normalizeIpRule('8.8.8.8')).toBe('8.8.8.8');
    expect(normalizeIpRule('8.8.8.8/24')).toBe('8.8.8.8/24');
    expect(normalizeIpRule('8.8.8.8/33')).toBeNull();
  });
});

/**
 * Gateway memory ordering — the "quick reconnect" decision. These tests fix
 * the policy: proven-last gates stay ahead of failed-last ones, freshness
 * beats a long-past streak, and a smoothed ratio stops one lucky success from
 * outranking a long track record.
 */
describe('gateway memory', () => {
  const now = 1_000_000_000_000;

  const entry = (over: Partial<GatewayMemoryEntry>): GatewayMemoryEntry => ({
    nodeId: 'n1',
    name: 'node',
    host: '1.2.3.4',
    port: 443,
    protocol: 'vless',
    engine: 'xray',
    exitIp: '5.6.7.8',
    exitCountry: 'DE',
    verifyMs: 100,
    successStreak: 1,
    successCount: 1,
    failCount: 0,
    firstSeenAt: now,
    lastSuccessAt: now,
    lastAttemptAt: now,
    ...over,
  });

  it('ranks a proven gateway above one that failed last time', () => {
    const proven = entry({ nodeId: 'proven', successStreak: 1 });
    const failed = entry({ nodeId: 'failed', successStreak: 0, failCount: 3 });
    const ranked = rankGatewaysForConnect([failed, proven], now);
    expect(ranked.map((e) => e.nodeId)).toEqual(['proven', 'failed']);
  });

  it('prefers the fresher success when both are proven', () => {
    const fresh = entry({ nodeId: 'fresh', lastSuccessAt: now - 60_000 });
    const old = entry({ nodeId: 'old', lastSuccessAt: now - 48 * 3_600_000 });
    expect(rankGatewaysForConnect([old, fresh], now)[0]!.nodeId).toBe('fresh');
    expect(gatewayScore(fresh, now)).toBeGreaterThan(gatewayScore(old, now));
  });

  it('does not let a 1-of-1 track record outrank a long reliable one', () => {
    const lucky = entry({ nodeId: 'lucky', successCount: 1, failCount: 0 });
    const veteran = entry({ nodeId: 'veteran', successCount: 40, failCount: 1 });
    expect(gatewayScore(veteran, now)).toBeGreaterThan(gatewayScore(lucky, now));
  });

  it('records a success as a streak and a failure as a demotion', () => {
    let entries = applyGatewaySuccess([], {
      nodeId: 'a', name: 'A', host: '1.1.1.1', port: 443, protocol: 'vless',
      engine: 'xray', exitIp: '9.9.9.9', exitCountry: 'NL', verifyMs: 55,
    }, now);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.successStreak).toBe(1);
    expect(entries[0]!.firstSeenAt).toBe(now);

    entries = applyGatewaySuccess(entries, {
      nodeId: 'a', name: 'A', host: '1.1.1.1', port: 443, protocol: 'vless',
      engine: 'xray', exitIp: '9.9.9.9', exitCountry: 'NL', verifyMs: 40,
    }, now + 1000);
    expect(entries[0]!.successStreak).toBe(2);
    expect(entries[0]!.successCount).toBe(2);

    entries = applyGatewayFailure(entries, 'a', now + 2000);
    expect(entries[0]!.successStreak).toBe(0);
    expect(entries[0]!.failCount).toBe(1);
    expect(entries[0]!.successCount).toBe(2); // history is kept, not rewritten
  });

  it('keeps the list bounded, dropping the least valuable entry', () => {
    let entries: GatewayMemoryEntry[] = [];
    for (let i = 0; i < GATEWAY_MEMORY_MAX + 3; i += 1) {
      entries = applyGatewaySuccess(entries, {
        nodeId: `n${i}`, name: null, host: `1.1.1.${i}`, port: 443, protocol: 'vmess',
        engine: 'sing-box', exitIp: null, exitCountry: null, verifyMs: null,
      }, now + i);
    }
    expect(entries).toHaveLength(GATEWAY_MEMORY_MAX);
    // the most recently proven are the ones kept
    expect(entries.some((e) => e.nodeId === `n${GATEWAY_MEMORY_MAX + 2}`)).toBe(true);
  });

  it('parses nothing out of a corrupt blob instead of throwing', () => {
    expect(parseGatewayMemory(null).entries).toEqual([]);
    expect(parseGatewayMemory({ entries: 'nope' }).entries).toEqual([]);
    expect(parseGatewayMemory({ entries: [{ nodeId: 'x' }, { nodeId: 'y', host: 'h', port: 443, engine: 'xray' }] }).entries)
      .toHaveLength(1);
  });
});
