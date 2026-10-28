import { describe, expect, it } from 'vitest';

import {
  WhitednsTunnelTestRequestSchema,
  WhitednsErrorCode,
} from '../src/schemas/whitedns';

describe('WhitednsTunnelTestRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = WhitednsTunnelTestRequestSchema.safeParse({
      zone: 'gb6ysaxnm3z4r7ffwzbn5.soar.abystral.dpdns.org',
      server: '206.1.96.89',
      pubkey: 'HRLjqBdOuVIByX8E95m+cd2Ah7weaD2azWHu2d24WMU=',
      url: 'https://example.com/',
      timeoutMs: 60000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty zone', () => {
    const result = WhitednsTunnelTestRequestSchema.safeParse({
      zone: '',
      server: '206.1.96.89',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('zone'))).toBe(true);
    }
  });

  it('rejects a zone that is not a domain name', () => {
    const result = WhitednsTunnelTestRequestSchema.safeParse({
      zone: 'not a domain',
      server: '206.1.96.89',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an oversized zone', () => {
    const result = WhitednsTunnelTestRequestSchema.safeParse({
      zone: 'a'.repeat(300),
      server: '206.1.96.89',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a server that is not an IPv4 address', () => {
    const result = WhitednsTunnelTestRequestSchema.safeParse({
      zone: 'test.soar.abystral.dpdns.org',
      server: 'not-an-ip',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('server'))).toBe(true);
    }
  });

  it('rejects a pubkey that is not base64', () => {
    const result = WhitednsTunnelTestRequestSchema.safeParse({
      zone: 'test.soar.abystral.dpdns.org',
      server: '206.1.96.89',
      pubkey: 'not-base64!!!',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a request without a pubkey', () => {
    const result = WhitednsTunnelTestRequestSchema.safeParse({
      zone: 'test.soar.abystral.dpdns.org',
      server: '206.1.96.89',
    });
    expect(result.success).toBe(true);
  });
});

describe('WhitednsErrorCode', () => {
  it('defines the expected error classifications', () => {
    expect(WhitednsErrorCode.INVALID_INPUT).toBe('whitedns_invalid_input');
    expect(WhitednsErrorCode.DNS_DELEGATION_FAILED).toBe('whitedns_dns_delegation_failed');
    expect(WhitednsErrorCode.UNREACHABLE).toBe('whitedns_unreachable');
    expect(WhitednsErrorCode.TUNNEL_NEGOTIATION_FAILED).toBe('whitedns_tunnel_negotiation_failed');
    expect(WhitednsErrorCode.UPSTREAM_FAILURE).toBe('whitedns_upstream_failure');
    expect(WhitednsErrorCode.INTERNAL).toBe('whitedns_internal');
  });
});
