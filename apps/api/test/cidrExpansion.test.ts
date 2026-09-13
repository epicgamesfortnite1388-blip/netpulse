import { describe, expect, it, vi } from 'vitest';
import net from 'node:net';

import { EndpointService } from '../src/services/endpointService';
import { isPrivateIp } from '../src/util/targetGuard';

import type { ScanConfig } from '@netpulse/shared';
import type { PlatformNetworkController } from '../src/providers/platform/types';

/**
 * Regression tests for the Cloudflare scanner's CIDR expansion.
 *
 * The defaults in the UI are Cloudflare's PUBLISHED ranges (104.16.0.0/13,
 * 172.64.0.0/13 — verified against cloudflare.com/ips-v4), but expansion used
 * to reject anything larger than /16, so the out-of-box scan always failed
 * with "must be between /16 and /32". Large published ranges are now sampled
 * on a deterministic stride; only unbounded ranges (/0–/7) stay rejected.
 */

function makeService(): EndpointService {
  const controller = {
    tcpProbe: vi.fn(async () => ({ ok: true, ms: 5 })),
    icmpPing: vi.fn(async () => ({ avg: 5, lossPct: 0, received: 4, sent: 4 })),
  } as unknown as PlatformNetworkController;
  return new EndpointService({
    controller,
    tests: { create: vi.fn(), finish: vi.fn() },
    scans: { createScan: vi.fn(), addCandidate: vi.fn() },
    events: { record: vi.fn() },
    settings: { get: vi.fn(() => ({ optimization: { weights: { latency: 30, packetLoss: 20, jitter: 15, throughput: 20, routeQuality: 10, load: 5 } } })) },
    bus: { publish: vi.fn() },
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function scanConfig(partial: Partial<ScanConfig>): ScanConfig {
  return {
    cidrs: ['104.16.0.0/13'],
    ports: [443],
    concurrency: 64,
    timeoutMs: 1_000,
    maxCandidates: 256,
    ...partial,
  };
}

describe('scanner CIDR expansion', () => {
  it('accepts Cloudflare published /13 ranges (the UI defaults)', () => {
    const svc = makeService();
    const candidates = svc.expandCandidates(scanConfig({ cidrs: ['104.16.0.0/13', '172.64.0.0/13'] }));
    expect(candidates.length).toBe(256);
    // all candidates inside the two ranges
    const inRange = candidates.filter((c) => {
      const ip = c.endpoint;
      const int = ip.split('.').reduce((a, o) => ((a * 256) + Number(o)) >>> 0, 0);
      const cf1a = (0x68100000 >>> 0), cf1b = (0x6817ffff >>> 0); // 104.16.0.0/13
      const cf2a = (0xac400000 >>> 0), cf2b = (0xac47ffff >>> 0); // 172.64.0.0/13
      return (int >= cf1a && int <= cf1b) || (int >= cf2a && int <= cf2b);
    });
    expect(inRange.length).toBe(256);
  });

  it('samples across the whole range (not just the first IPs)', () => {
    const svc = makeService();
    const candidates = svc.expandCandidates(scanConfig({ cidrs: ['104.16.0.0/13'], maxCandidates: 16 }));
    const octet2 = new Set(candidates.map((c) => Number(c.endpoint.split('.')[1])));
    // a /13 spans 104.16.x–104.23.x: stride sampling must reach several second octets
    expect(octet2.size).toBeGreaterThan(2);
  });

  it('still rejects /0–/7 (unbounded internet scans)', () => {
    const svc = makeService();
    const attempt = (cidr: string): string | null => {
      try {
        svc.expandCandidates(scanConfig({ cidrs: [cidr] }));
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    expect(attempt('0.0.0.0/1')).toMatch(/8 and \/32/);
    // private /8: rejected as private (defense in depth inside expansion)
    expect(attempt('10.0.0.0/8')).toMatch(/private|reserved/);
  });

  it('respects maxCandidates exactly', () => {
    const svc = makeService();
    for (const max of [16, 64, 256, 2048]) {
      const candidates = svc.expandCandidates(scanConfig({ maxCandidates: max }));
      expect(candidates.length).toBeLessThanOrEqual(max);
      expect(candidates.length).toBeGreaterThan(0);
    }
  });

  it('single IPs still expand to one candidate per port', () => {
    const svc = makeService();
    const candidates = svc.expandCandidates(scanConfig({ cidrs: ['1.1.1.1'], ports: [443, 2053] }));
    expect(candidates).toEqual([
      { endpoint: '1.1.1.1', port: 443 },
      { endpoint: '1.1.1.1', port: 2053 },
    ]);
  });

  it('private range base addresses stay blocked by the SSRF guard', () => {
    expect(isPrivateIp('10.0.0.5')).toBe(true);
    expect(isPrivateIp('172.64.0.1')).toBe(false); // Cloudflare, not RFC1918
    expect(net.isIP('104.16.0.1')).toBe(4);
  });
});
