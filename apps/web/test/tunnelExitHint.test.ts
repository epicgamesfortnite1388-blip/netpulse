import { describe, expect, it } from 'vitest';

import { tunnelExitHint } from '../src/features/vpn/tunnelExitHint';

/**
 * The "Active tunnel" card pairs a value (which tunnel is up) with a hint (where
 * it exits). The hint used to fall back to "nothing is carrying traffic"
 * whenever no exit IP was known, so a live proxy tunnel with an unconfirmed exit
 * rendered as "proxy tunnel / nothing is carrying traffic" — the card
 * contradicted itself and told the user a working tunnel was dead.
 */
describe('tunnelExitHint', () => {
  it('prefers an externally verified exit', () => {
    expect(
      tunnelExitHint({ activeTunnel: 'wireguard', verifiedPublicIp: '203.0.113.7', exitIp: '10.0.0.1' }),
    ).toBe('exit 203.0.113.7');
  });

  it('falls back to the tunnel-reported exit', () => {
    expect(tunnelExitHint({ activeTunnel: 'proxy tunnel', exitIp: '198.51.100.4' })).toBe(
      'exit 198.51.100.4',
    );
  });

  it('says the exit is unverified, not that nothing flows, when a tunnel is up', () => {
    expect(tunnelExitHint({ activeTunnel: 'proxy tunnel' })).toBe('exit not verified');
  });

  it('claims no traffic only when there is genuinely no tunnel', () => {
    expect(tunnelExitHint({ activeTunnel: null })).toBe('nothing is carrying traffic');
  });

  it('treats empty-string IPs as absent rather than printing "exit "', () => {
    expect(tunnelExitHint({ activeTunnel: 'proxy tunnel', verifiedPublicIp: '', exitIp: '' })).toBe(
      'exit not verified',
    );
  });
});