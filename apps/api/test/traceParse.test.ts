import { describe, expect, it } from 'vitest';

import { parseCymruOrigin } from '../src/util/traceParse';

describe('parseCymruOrigin', () => {
  it('parses the modern no-AS-prefix, no-org record shape (as served live)', () => {
    const r = parseCymruOrigin('13335 | 104.18.41.0/24 | US | arin | 2014-03-28');
    expect(r).toEqual({ asn: 13335, org: null, country: 'US' });
  });

  it('parses the documented AS-prefixed shape with org', () => {
    const r = parseCymruOrigin('AS15169 | 8.8.8.0/24 | US | arin | 2005-03-30 | GOOGLE, US');
    expect(r).toEqual({ asn: 15169, org: 'GOOGLE, US', country: 'US' });
  });

  it('parses the AS-prefixed shape without org', () => {
    const r = parseCymruOrigin('AS51167 | 2.178.0.0/16 | IR | ripencc | 2010-05-20');
    expect(r).toEqual({ asn: 51167, org: null, country: 'IR' });
  });

  it('handles whitespace variance', () => {
    const r = parseCymruOrigin('  21280 | 5.202.0.0/16 | IR | ripencc | 2006-03-14 ');
    expect(r?.asn).toBe(21280);
    expect(r?.country).toBe('IR');
  });

  it('returns null for garbage', () => {
    expect(parseCymruOrigin('not a cymru record')).toBeNull();
    expect(parseCymruOrigin('')).toBeNull();
  });
});