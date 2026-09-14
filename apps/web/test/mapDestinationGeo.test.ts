import { describe, expect, it } from 'vitest';

import { destinationGeo } from '@/features/map/LiveMapPage';

import type { MapObservation } from '@netpulse/shared';

/**
 * The destination pin must come from the destination's own geo — the hop
 * matching the observation's resolvedIp — never from a transit router that
 * happens to be the last geo-tagged hop (the Cloudflare-in-the-wrong-place
 * class of lie). The destination panel's Location row follows the same rule.
 */
function obs(overrides: Partial<MapObservation> = {}): MapObservation {
  return {
    id: 'obs-1',
    target: { id: 't1', type: 'custom', name: 'test', host: 'example.com' },
    family: 4,
    resolvedIp: '9.9.9.9',
    protocol: 'tcp',
    port: 443,
    vpnActive: false,
    vpnLabel: null,
    createdAt: Date.now(),
    durationMs: 1000,
    hops: [],
    measurements: [],
    ...overrides,
  } as MapObservation;
}

const transitGeo = { lat: 50.1, lon: 8.7, city: 'Frankfurt', country: 'DE', countryCode: 'DE', confidence: { source: 'registry' as const, confidence: 'medium' as const, label: 'estimate' } };
const destGeo = { lat: 41.9, lon: 12.5, city: 'Rome', country: 'IT', countryCode: 'IT', confidence: { source: 'known-endpoint' as const, confidence: 'high' as const, label: 'measured' } };

describe('destinationGeo', () => {
  it('uses the geo of the hop matching resolvedIp', () => {
    const o = obs({
      hops: [
        { hop: 1, ip: '10.0.0.1', geo: transitGeo },
        { hop: 2, ip: '9.9.9.9', geo: destGeo },
      ],
    } as Partial<MapObservation>);
    expect(destinationGeo(o)).toEqual({ lat: 41.9, lon: 12.5, confidence: 'high' });
  });

  it('never falls back to the last geo-tagged transit hop', () => {
    // destination refused (no geo) while a transit router has geo —
    // this is exactly the 1.1.1.1 shape: honest answer is NO PIN.
    const o = obs({
      hops: [
        { hop: 1, ip: '10.0.0.1', geo: transitGeo },
        { hop: 2, ip: '9.9.9.9', geo: null },
      ],
    } as Partial<MapObservation>);
    expect(destinationGeo(o)).toBeNull();
  });

  it('returns null when the destination hop is missing entirely', () => {
    const o = obs({ hops: [{ hop: 1, ip: '10.0.0.1', geo: transitGeo }] } as Partial<MapObservation>);
    expect(destinationGeo(o)).toBeNull();
  });

  it('matches the resolved IP hop even when it appears before transit hops', () => {
    const o = obs({
      hops: [
        { hop: 1, ip: '9.9.9.9', geo: destGeo },
        { hop: 2, ip: '10.0.0.1', geo: transitGeo },
      ],
    } as Partial<MapObservation>);
    expect(destinationGeo(o)).toEqual({ lat: 41.9, lon: 12.5, confidence: 'high' });
  });
});
