import { describe, expect, it } from 'vitest';

import { redactSecrets } from '../src/util/redact';

/**
 * Error strings from proxy cores reach the DB, events, and the UI. Any
 * credential material the core echoed into stderr must be scrubbed first.
 */
describe('redactSecrets', () => {
  it('redacts UUIDs (vmess/vless ids)', () => {
    const out = redactSecrets('user f81d4fae-7dec-11d0-a765-00a0c91e6bf6 not accepted');
    expect(out).not.toContain('f81d4fae');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts key=value secret shapes', () => {
    const out = redactSecrets('auth failed for password=supersecret99 at line 3');
    expect(out).not.toContain('supersecret99');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts long base64 key material', () => {
    const out = redactSecrets(' Reality handshake with public key Wm9uYWxpbmthdGFzZWNyZXRrZXltYXRlcmlhbDEyMzQ1 failed');
    expect(out).not.toContain('Wm9uYWxpbmthdGFzZWNyZXRrZXltYXRlcmlhbDEyMzQ1');
  });

  it('keeps ordinary error text intact', () => {
    const msg = 'core exited during startup (code 23): unsupported cipher chacha20-poly1305';
    expect(redactSecrets(msg)).toBe(msg);
  });

  it('bounds output length', () => {
    const out = redactSecrets('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(512);
  });
});
