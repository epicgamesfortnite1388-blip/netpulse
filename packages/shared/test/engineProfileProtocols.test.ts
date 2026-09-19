import { describe, expect, it } from 'vitest';

import { canBecomeEngineProfile, ENGINE_PROFILE_PROTOCOLS } from '../src/models/proxyEngine';

/**
 * The rule the node explorer's "add to an engine" action obeys.
 *
 * A profile is built by rebuilding a stored node's share link and parsing it
 * with the sing-box profile importer, so the promotable set is NARROWER than
 * what sing-box can dial. Getting this wrong produces a button that can never
 * work, which is exactly what the row action must not be.
 */
describe('canBecomeEngineProfile', () => {
  it('accepts exactly the protocols the profile importer can rebuild', () => {
    for (const p of ENGINE_PROFILE_PROTOCOLS) expect(canBecomeEngineProfile(p)).toBe(true);
    expect([...ENGINE_PROFILE_PROTOCOLS]).toEqual(['vless', 'vmess', 'trojan', 'shadowsocks']);
  });

  it('declines protocols sing-box can dial but cannot import as a profile', () => {
    // Dialable by the sing-box core, yet with no share-link form this importer
    // accepts — these are the nodes whose row button must stay disabled.
    expect(canBecomeEngineProfile('hysteria2')).toBe(false);
    expect(canBecomeEngineProfile('tuic')).toBe(false);
  });

  it('declines protocols that have no share link at all', () => {
    expect(canBecomeEngineProfile('shadowsocksr')).toBe(false);
    expect(canBecomeEngineProfile('wireguard')).toBe(false);
    expect(canBecomeEngineProfile('unknown')).toBe(false);
    expect(canBecomeEngineProfile('')).toBe(false);
  });
});
