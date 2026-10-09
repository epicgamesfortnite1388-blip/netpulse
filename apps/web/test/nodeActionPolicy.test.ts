import { describe, expect, it } from 'vitest';

import type { NodeTestResult } from '@netpulse/shared';

import * as policy from '../src/features/nodes/nodeActionPolicy';
import {
  engineInstallMessage,
  geoOutcomeMessage,
  promoteErrorMessage,
  promoteMessage,
  serverCheckMessage,
  testErrorMessage,
  testMessage,
  tunnelReconnectMessage,
  tunnelStartMessage,
} from '../src/features/nodes/nodeActionPolicy';

/**
 * One account of every node-action outcome.
 *
 * These functions are the only place the wording lives, so these tests are the
 * contract the explorer row and the node detail page both render. The rule they
 * hold: a refusal is reported as the server's reason, never as a generic
 * failure, and a copy that never reached the clipboard never reads as success.
 */
describe('geoOutcomeMessage', () => {
  it('reports a resolved lookup as success', () => {
    expect(geoOutcomeMessage({ outcome: 'resolved', reason: 'ok' }).tone).toBe('ok');
    expect(geoOutcomeMessage({ outcome: 'vouched', reason: 'user' }).body).toMatch(/attested/i);
  });

  it('explains anycast and edge-fabric refusals instead of calling them failures', () => {
    const anycast = geoOutcomeMessage({ outcome: 'refused', reason: 'anycast' });
    const edge = geoOutcomeMessage({ outcome: 'refused', reason: 'edge_fabric' });
    expect(anycast.tone).toBe('warn');
    expect(anycast.body).toMatch(/artifacts/);
    expect(edge.body).toMatch(/registry office/);
  });

  it('distinguishes a busy worker from a lookup failure', () => {
    expect(geoOutcomeMessage({ outcome: 'busy', reason: 'queued' }).title).toMatch(/busy/i);
    const failed = geoOutcomeMessage({ outcome: 'failed', reason: 'private_only' });
    expect(failed.tone).toBe('error');
    expect(failed.body).toMatch(/private addresses/);
  });
});

/**
 * The share-link and export wording is gone from this module on purpose, and
 * these assertions are the tripwire for someone re-adding it. A helper that
 * formats a credential for the screen is the first step back to a button that
 * copies one, and the routes behind it answer 410 — so re-adding any of these
 * names should fail here rather than ship.
 */
describe('the raw-config surface stays removed', () => {
  const RETIRED_EXPORTS = [
    'exportFileName',
    'exportMessage',
    'exportErrorMessage',
    'shareLinkRefusalMessage',
    'shareLinkCopiedMessage',
    'shareLinkClipboardFailureMessage',
    'shareLinkErrorMessage',
  ];

  it.each(RETIRED_EXPORTS)('exports no %s', (name) => {
    expect(Object.keys(policy)).not.toContain(name);
  });

  it('offers no export format list to render buttons from', () => {
    expect(Object.keys(policy)).not.toContain('EXPORT_FORMATS');
  });
});

describe('test messages', () => {
  const record = (over: Partial<Pick<NodeTestResult, 'type' | 'status' | 'latencyMs' | 'totalMs' | 'error'>> = {}) => ({
    type: 'tcp',
    status: 'done',
    latencyMs: null,
    totalMs: null,
    error: null,
    ...over,
  }) as Pick<NodeTestResult, 'type' | 'status' | 'latencyMs' | 'totalMs' | 'error'>;

  it('reports the measured value of a stored success', () => {
    expect(testMessage(record({ latencyMs: 7544.04 }))).toEqual({ tone: 'ok', title: 'Test tcp complete', body: '7544.0 ms' });
  });

  it('uses a proxy run\'s total time, labelled as such', () => {
    expect(testMessage(record({ type: 'proxy', totalMs: 2661.2 })).body).toBe('2661.2 ms total');
  });

  it('says no latency was recorded instead of leaving a blank body', () => {
    expect(testMessage(record()).body).toBe('No latency was recorded for this run');
  });

  /**
   * The regression this pass exists for: a DNS failure that took 85 ms was
   * stored with status `failed` and toasted as "Test tcp complete | 85.0 ms",
   * announcing a measurement that never reached the row (whose median stayed —).
   */
  it('reports a failed record as failed, with the record\'s own reason', () => {
    const failed = record({ status: 'failed', latencyMs: 85, error: 'getaddrinfo ENOTFOUND arch1.example.net' });
    expect(testMessage(failed)).toEqual({ tone: 'warn', title: 'Test tcp failed', body: 'getaddrinfo ENOTFOUND arch1.example.net' });
  });

  it('never surfaces the failed attempt\'s duration as a result', () => {
    const failed = record({ status: 'failed', latencyMs: 85 });
    expect(JSON.stringify(testMessage(failed))).not.toContain('85');
  });

  it('states that no reason was recorded rather than showing a blank', () => {
    const message = testMessage(record({ status: 'failed', error: null }));
    expect(message.tone).toBe('warn');
    expect(message.body).toBe('The backend recorded this run as failed without a reason.');
  });

  it("keeps a backend 'error' distinct from a failed probe", () => {
    expect(testMessage(record({ status: 'error', error: 'core crashed' })).tone).toBe('error');
  });

  it('names a run that did not complete instead of reporting a result', () => {
    const message = testMessage(record({ status: 'cancelled' }));
    expect(message.title).toBe('Test tcp did not complete');
    expect(message.body).toMatch(/cancelled/);
  });

  it('carries the request error text when the call itself fails', () => {
    expect(testErrorMessage('proxy', new Error('core exited during startup')).body).toBe('core exited during startup');
  });
});

/* ----------------------- request-vs-stored-record pass -------------------- */

describe('serverCheckMessage', () => {
  it('never reads a null sample as success', () => {
    const m = serverCheckMessage('alpha', null);
    expect(m.tone).not.toBe('ok');
    expect(m.title).toMatch(/no health sample/i);
  });

  it('reports the stored status, not the completed request', () => {
    expect(serverCheckMessage('alpha', { status: 'offline', pingMs: null }).tone).toBe('error');
    expect(serverCheckMessage('alpha', { status: 'degraded', pingMs: 40 }).tone).toBe('warn');
    const ok = serverCheckMessage('alpha', { status: 'online', pingMs: 12.4 });
    expect(ok.tone).toBe('ok');
    expect(ok.body).toContain('12.4 ms');
  });
});

describe('engineInstallMessage', () => {
  const base = { engine: 'xray', status: 'installed', version: '1.8.0', checksumVerified: true, versionOutput: 'Xray 1.8.0', error: null };

  it('reports a failed install with the manager reason, not as success', () => {
    const m = engineInstallMessage({ ...base, status: 'failed', error: 'checksum mismatch' });
    expect(m.tone).toBe('error');
    expect(m.body).toBe('checksum mismatch');
  });

  it('says already-current instead of pretending to install', () => {
    expect(engineInstallMessage({ ...base, status: 'already_current' }).title).toContain('current');
  });

  it('mentions checksum verification only when true', () => {
    expect(engineInstallMessage(base).body).toContain('checksum verified');
    expect(engineInstallMessage({ ...base, checksumVerified: false }).body).not.toContain('checksum');
  });
});

describe('tunnelStartMessage / tunnelReconnectMessage', () => {
  it('refuses to call an unverified exit "verified"', () => {
    const m = tunnelStartMessage({ state: 'active', exitIp: null, exitCountry: null, engine: 'xray', error: null, chain: null });
    expect(m.tone).toBe('warn');
    expect(m.title).toMatch(/unverified/i);
  });

  it('reports a failed tunnel with the stored error', () => {
    const m = tunnelStartMessage({ state: 'failed', exitIp: null, exitCountry: null, engine: null, error: 'core exited during startup', chain: null });
    expect(m.tone).toBe('error');
    expect(m.body).toBe('core exited during startup');
  });

  it('verifies a chain only when the exit IP was observed', () => {
    const good = tunnelStartMessage({ state: 'active', exitIp: '1.2.3.4', exitCountry: null, engine: null, error: null, chain: { entryExitIp: '5.6.7.8', exitIp: '1.2.3.4', exitDiffers: true } });
    expect(good.tone).toBe('ok');
    const bad = tunnelStartMessage({ state: 'active', exitIp: null, exitCountry: null, engine: null, error: null, chain: { entryExitIp: '5.6.7.8', exitIp: null, exitDiffers: false } });
    expect(bad.tone).toBe('warn');
  });

  it('reconnect: active-but-unverified is a warn with a reason, not "Exit ?"', () => {
    const m = tunnelReconnectMessage({ state: 'active', exitIp: null, exitCountry: null, engine: null, error: null, chain: null });
    expect(m.tone).toBe('warn');
    expect(m.body).not.toContain('?');
  });
});

describe('promoteMessage / promoteErrorMessage', () => {
  it('names the engine from the server response and the profile the user will see', () => {
    const m = promoteMessage({ id: 'p1', name: 'node-nl-01', providerId: 'singbox' });
    expect(m.tone).toBe('ok');
    expect(m.title).toContain('singbox');
    expect(m.body).toContain('node-nl-01');
  });

  it('surfaces the server’s own refusal reason for a node that cannot be promoted', () => {
    const m = promoteErrorMessage(new Error('ShadowsocksR has no standard share link'));
    expect(m.tone).toBe('error');
    expect(m.body).toContain('ShadowsocksR');
  });

  it('never invents a reason when the error carries none — the title still says what failed', () => {
    const m = promoteErrorMessage(undefined);
    expect(m.title).toMatch(/could not add this node to an engine/i);
    expect(m.body).toBeUndefined();
  });
});
