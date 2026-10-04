import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Writing the system proxy must invalidate the cached outbound decision.
 *
 * This is a source assertion rather than a behavioural one on purpose. The
 * behaviour (a notification clears the cache) is pinned in
 * egressThroughProxy.test.ts; what that cannot see is whether `setSystemProxy`
 * actually fires it. Testing that directly would mean writing HKCU from the
 * test suite, which would silently disable a proxy the developer has running.
 *
 * The regression it guards is concrete: a user switches the tunnel on and then
 * signs in. If the write did not invalidate, the first sign-in reuses the
 * cached "no proxy" answer, goes direct, and fails — the original report.
 */
describe('setSystemProxy invalidates the cached egress decision', () => {
  const src = readFileSync(join(__dirname, '../src/services/systemProxy.ts'), 'utf8');

  it('calls notifySystemProxyChanged() after a successful registry write', () => {
    const fn = src.slice(src.indexOf('export async function setSystemProxy'));
    const notify = fn.indexOf('notifySystemProxyChanged()');
    const refresh = fn.indexOf('refreshWinInet()');
    expect(notify, 'setSystemProxy must notify proxy listeners').toBeGreaterThan(-1);
    // After the ProxyEnable/ProxyServer writes, not before: notifying early
    // would let a listener re-read the value we are still writing.
    expect(notify).toBeGreaterThan(fn.indexOf("regPut('ProxyEnable'"));
    expect(notify).toBeLessThan(refresh);
  });

  it('notifies on both the enable and the disable path', () => {
    const fn = src.slice(src.indexOf('export async function setSystemProxy'));
    // One call, after the if/else that handles both — so turning the proxy OFF
    // also invalidates, which matters just as much.
    expect(fn.match(/notifySystemProxyChanged\(\)/g) ?? []).toHaveLength(1);
  });
});
