import { describe, expect, it } from 'vitest';

import { diagnoseFailure } from '../src/lib/failureIntelligence';

/**
 * Failure-intelligence rules: cautious labels (Likely/Possible/No evidence/
 * Unable to determine), no invented certainty, ordered most-specific first.
 */
describe('diagnoseFailure', () => {
  it('classifies missing core as Likely with an action', () => {
    const d = diagnoseFailure('no proxy core installed — install xray or sing-box to test proxy latency');
    expect(d?.category).toBe('Engine unavailable');
    expect(d?.confidence).toBe('likely');
    expect(d?.action).toBeTruthy();
  });

  it('classifies DNS failure from ENOTFOUND', () => {
    const d = diagnoseFailure('getaddrinfo ENOTFOUND dead.example.com');
    expect(d?.category).toBe('DNS failure');
    expect(d?.confidence).toBe('likely');
  });

  it('classifies closed port from ECONNREFUSED', () => {
    const d = diagnoseFailure('connect ECONNREFUSED 1.2.3.4:443');
    expect(d?.category).toBe('Port closed');
    expect(d?.confidence).toBe('likely');
  });

  it('marks timeouts as Possible (cannot distinguish blocked vs dead)', () => {
    const d = diagnoseFailure('connection timed out after 5000ms');
    expect(d?.category).toBe('Timeout');
    expect(d?.confidence).toBe('possible');
  });

  it('classifies TLS failures as Possible with SNI action', () => {
    const d = diagnoseFailure('TLS handshake failed: certificate verify failed');
    expect(d?.category).toBe('TLS failure');
    expect(d?.confidence).toBe('possible');
    expect(d?.action).toContain('SNI');
  });

  it('classifies auth failures from HTTP 407', () => {
    const d = diagnoseFailure('proxy responded 407 Unauthorized');
    expect(d?.category).toBe('Authentication failure');
    expect(d?.confidence).toBe('likely');
  });

  it('blocks private-target probes honestly', () => {
    const d = diagnoseFailure('Node host "192.168.1.10" is a private IPv4 address');
    expect(d?.category).toBe('Blocked target');
    expect(d?.confidence).toBe('likely');
  });

  it('returns undetermined for unknown errors (never invents certainty)', () => {
    const d = diagnoseFailure('something completely unexpected happened');
    expect(d?.confidence).toBe('undetermined');
    expect(d?.summary).toMatch(/Unable to determine/i);
  });

  it('returns null for empty input', () => {
    expect(diagnoseFailure(null)).toBeNull();
    expect(diagnoseFailure('')).toBeNull();
    expect(diagnoseFailure('   ')).toBeNull();
  });
});
