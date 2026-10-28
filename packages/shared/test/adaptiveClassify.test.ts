import { describe, expect, it } from 'vitest';

import { censorshipHintOf, classifyConnectFailure, type AdaptiveObservation } from '../src/adaptive';

/**
 * Failure classification: the guard against concluding "censorship" from a
 * connection that simply did not work.
 */

describe('one failed attempt is never attributed to censorship', () => {
  it('never sets dpiInferred, whatever the message says', () => {
    const messages = [
      'connection reset by peer',
      'i/o timeout',
      'tls: handshake failure',
      'xray exited during startup (code 23)',
      'getaddrinfo ENOTFOUND example.invalid',
      '403 Forbidden',
      '',
      'weird thing nobody has seen',
    ];
    for (const message of messages) {
      const verdict = classifyConnectFailure({ stage: 'tls', message });
      expect(verdict.dpiInferred).toBe(false);
      expect(verdict.reasonCode.length).toBeGreaterThan(0);
      expect(verdict.explanation.length).toBeGreaterThan(0);
    }
  });

  it('calls an unavailable core a configuration problem — nothing was attempted', () => {
    const verdict = classifyConnectFailure({ stage: 'core-start', engineUnavailable: true, message: 'xray binary not found' });
    expect(verdict.kind).toBe('configuration');
    expect(verdict.reasonCode).toBe('engine-unavailable');
    expect(verdict.explanation).toMatch(/not installed/);
  });

  it('reports a local network problem as local, before blaming the server', () => {
    const verdict = classifyConnectFailure({ stage: 'tcp', message: 'connect EHOSTUNREACH 1.2.3.4:443' });
    expect(verdict.kind).toBe('local-network');
    expect(verdict.explanation).toMatch(/This machine/);
  });

  it('classifies a rejected credential as authentication, not as a blocked transport', () => {
    const verdict = classifyConnectFailure({ stage: 'verify', message: '403 Forbidden: invalid user' });
    expect(verdict.kind).toBe('authentication');
    expect(verdict.explanation).toMatch(/rotated or expired/);
  });

  it('classifies name resolution failure as DNS', () => {
    const verdict = classifyConnectFailure({ stage: 'resolve', message: 'getaddrinfo ENOTFOUND node.example.com' });
    expect(verdict.kind).toBe('dns');
    expect(verdict.reasonCode).toBe('dns-resolution-failed');
  });

  it('separates a started core from a tunnel that carries traffic', () => {
    const verdict = classifyConnectFailure({ stage: 'verify', message: 'exit IP could not be read through the tunnel' });
    expect(verdict.kind).toBe('not-verified');
    expect(verdict.reasonCode).toBe('traffic-not-verified');
    expect(verdict.explanation).toMatch(/started process is not a working tunnel/);
  });

  it('classifies TCP-then-TLS failure as a transport failure', () => {
    const verdict = classifyConnectFailure({ stage: 'tls', tcpReached: true, tlsCompleted: false, message: 'tls: first record does not look like a TLS handshake' });
    expect(verdict.kind).toBe('transport');
    expect(verdict.reasonCode).toBe('tls-handshake-failed');
  });

  it('treats an outright refusal as a server-side outage', () => {
    const verdict = classifyConnectFailure({ stage: 'tcp', message: 'connect ECONNREFUSED 198.51.100.7:443' });
    expect(verdict.kind).toBe('server-outage');
    expect(verdict.reasonCode).toBe('connection-refused');
  });

  it('falls back to what was measured when the message says nothing useful', () => {
    // The stage is a measurement, so an unrecognised message at the TLS stage is
    // still honestly "the transport did not complete".
    const verdict = classifyConnectFailure({ stage: 'tls', message: 'something unexpected' });
    expect(verdict.kind).toBe('transport');
    expect(verdict.reasonCode).toBe('transport-failed-after-tcp');
    expect(verdict.dpiInferred).toBe(false);
  });

  it('keeps a failure it cannot place unclassified and says so', () => {
    const verdict = classifyConnectFailure({ stage: 'core-start', message: 'something unexpected', engineUnavailable: false });
    expect(verdict.kind).toBe('configuration');
    expect(verdict.explanation).toMatch(/exited instead of starting/);
  });

  it('notes when a connection that used to work stopped working', () => {
    const verdict = classifyConnectFailure({ stage: 'tls', message: 'socket hang up', previouslyWorked: true });
    expect(verdict.explanation).toMatch(/worked before/);
  });
});

describe('censorship is a pattern, never a single failure', () => {
  const now = 1_000_000;

  const observation = (over: Partial<AdaptiveObservation>): AdaptiveObservation => ({
    at: now - 1_000,
    context: 'ctx',
    strategyId: 'xray',
    ok: false,
    timeToWorkingMs: null,
    failureKind: 'transport',
    reasonCode: 'tls-handshake-failed',
    ...over,
  });

  it('stays silent for a single failure', () => {
    const hint = censorshipHintOf([observation({})], now);
    expect(hint.likely).toBe(false);
    expect(hint.reason).toMatch(/1 strategy\(ies\)|No failures/);
  });

  it('does not call it a pattern when one strategy keeps failing', () => {
    const hint = censorshipHintOf(
      [1, 2, 3, 4].map((i) => observation({ at: now - i * 1_000, strategyId: 'xray' })),
      now,
    );
    expect(hint.likely).toBe(false);
    expect(hint.distinctStrategies).toBe(1);
  });

  it('raises a hint only when different strategies fail the same way together', () => {
    const hint = censorshipHintOf(
      ['xray', 'sing-box', 'v2ray'].map((id) => observation({ strategyId: id })),
      now,
    );
    expect(hint.likely).toBe(true);
    expect(hint.distinctStrategies).toBe(3);
    expect(hint.kind).toBe('transport');
    expect(hint.reason).toMatch(/pattern, not a diagnosis/);
  });

  it('ignores failures outside the window', () => {
    const hint = censorshipHintOf(
      ['xray', 'sing-box', 'v2ray'].map((id) => observation({ strategyId: id, at: now - 60 * 60 * 1000 })),
      now,
      { windowMs: 15 * 60 * 1000 },
    );
    expect(hint.likely).toBe(false);
  });

  it('does not mix unrelated failure kinds into one pattern', () => {
    const hint = censorshipHintOf(
      [
        observation({ strategyId: 'xray', failureKind: 'dns' }),
        observation({ strategyId: 'sing-box', failureKind: 'authentication' }),
        observation({ strategyId: 'v2ray', failureKind: 'configuration' }),
      ],
      now,
    );
    expect(hint.likely).toBe(false);
  });
});
