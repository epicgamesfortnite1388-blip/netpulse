import { describe, expect, it } from 'vitest';

import { coloInfo, coloLabel, COLO_NAMES } from '@netpulse/shared';

import {
  cfCleanVerdict,
  parseColoFromRay,
  parseTraceBody,
} from '../src/util/cfProbe';

describe('parseTraceBody / parseColoFromRay', () => {
  const body = [
    'fl=716l5',
    'h=www.cloudflare.com',
    'ip=185.220.101.4',
    'ts=1725480000.123',
    'visit_scheme=https',
    'uag=Mozilla/5.0',
    'colo=FRA',
    'sliver=none',
    'http=http/2',
    'loc=DE',
    'tls=TLSv1.3',
    'warp=off',
    'gateway=off',
    'rbi=off',
    'kex=X25519',
  ].join('\n');

  it('extracts colo and loc fields from a trace body', () => {
    const fields = parseTraceBody(body);
    expect(fields.get('colo')).toBe('FRA');
    expect(fields.get('loc')).toBe('DE');
    expect(fields.get('warp')).toBe('off');
    expect(fields.get('missing')).toBeUndefined();
  });

  it('handles CRLF and empty input', () => {
    expect(parseTraceBody('a=1\r\nb=2\r\n').get('b')).toBe('2');
    expect(parseTraceBody('').size).toBe(0);
  });

  it('parses the colo code from a CF-Ray header', () => {
    expect(parseColoFromRay('abc123def-FRA')).toBe('FRA');
    expect(parseColoFromRay('1a2b3c4d5e6f7g8h-IST')).toBe('IST');
    expect(parseColoFromRay('no-dash-here')).toBe(null);
    expect(parseColoFromRay(null)).toBe(null);
    expect(parseColoFromRay('x')).toBe(null);
  });
});

describe('colo dictionary', () => {
  it('maps known edge codes to city/country', () => {
    const fra = coloInfo('FRA');
    expect(fra?.city).toBe('Frankfurt');
    expect(fra?.countryCode).toBe('DE');
    expect(coloInfo('ist')?.code).toBe('IST'); // case-insensitive
    expect(coloLabel('DXB')).toContain('Dubai');
    expect(coloLabel('FRA')).toBe('FRA · Frankfurt, DE');
  });

  it('falls back to the bare code for unmapped edges without lying', () => {
    expect(coloInfo('XXX')).toBeNull();
    expect(coloLabel('XXX')).toBe('XXX');
    expect(coloLabel(null)).toBeNull();
  });

  it('keeps a meaningful curated set', () => {
    expect(Object.keys(COLO_NAMES).length).toBeGreaterThanOrEqual(20);
  });
});

describe('cfCleanVerdict (SenPaiScanner IsHealthy semantics)', () => {
  it('declares a genuinely healthy edge clean', () => {
    const v = cfCleanVerdict({
      tries: 3,
      successes: 3,
      avgMs: 12,
      colo: 'FRA',
      downloadAttempted: true,
      downloadMbps: 42.5,
    });
    expect(v.clean).toBe(true);
    expect(v.reasons.join(' ')).toContain('42.5 Mbps');
  });

  it('rejects high packet loss', () => {
    const v = cfCleanVerdict({
      tries: 3,
      successes: 1,
      avgMs: 10,
      colo: 'FRA',
      downloadAttempted: true,
      downloadMbps: 20,
    });
    expect(v.clean).toBe(false);
    expect(v.reasons[0]).toMatch(/1\/3/);
  });

  it('rejects endpoints that are not genuine Cloudflare edges', () => {
    const v = cfCleanVerdict({
      tries: 3,
      successes: 3,
      avgMs: 8,
      colo: null,
      downloadAttempted: true,
      downloadMbps: 55,
    });
    expect(v.clean).toBe(false);
    expect(v.reasons.join(' ')).toContain('not a Cloudflare edge');
  });

  it('rejects the filtered-network failure mode: trace ok, download stalled', () => {
    const v = cfCleanVerdict({
      tries: 3,
      successes: 3,
      avgMs: 15,
      colo: 'IST',
      downloadAttempted: true,
      downloadMbps: null, // handshake fine, zero bytes transferred
    });
    expect(v.clean).toBe(false);
    expect(v.reasons.join(' ')).toContain('carried no download data');
  });

  it('stays clean when no download was attempted (port 80 discovery)', () => {
    const v = cfCleanVerdict({
      tries: 3,
      successes: 3,
      avgMs: 20,
      colo: 'FRA',
      downloadAttempted: false,
      downloadMbps: null,
    });
    expect(v.clean).toBe(true);
  });
});
