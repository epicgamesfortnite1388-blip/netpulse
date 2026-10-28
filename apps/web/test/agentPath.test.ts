import { describe, expect, it } from 'vitest';

import { activeHop, currentAttempt, deriveAgentPath, type AgentPathEvent } from '../src/features/vpn/agentPath';

/**
 * The path visualization is only worth having if it cannot lie.
 *
 * These tests pin the two rules that would otherwise drift: a DNS *policy*
 * being armed never completes the DNS hop, and a new attempt clears the
 * previous attempt's failure so the path always describes the run in flight.
 */

const byId = (events: AgentPathEvent[], busy = true) =>
  Object.fromEntries(deriveAgentPath(events, busy).map((hop) => [hop.id, hop]));

describe('deriveAgentPath', () => {
  it('keeps every hop pending for a finished run with no events', () => {
    for (const hop of deriveAgentPath([], false)) {
      expect(hop.state).toBe('pending');
    }
    expect(activeHop(deriveAgentPath([], false))).toBeNull();
  });

  it('marks request and policy from planning events, before any core is dialed', () => {
    const hops = byId([
      { stage: 'preparing', message: 'Preparing adaptive route checks' },
      { stage: 'adaptive-plan', message: 'Learned order from 12 observations' },
      { stage: 'adaptive-choice', message: 'Adaptive agent selected sing-box', engine: 'sing-box' },
    ]);
    expect(hops.request?.state).toBe('ok');
    expect(hops.policy?.state).toBe('ok');
    expect(hops.policy?.detail).toBe('sing-box chosen');
    expect(hops.core?.state).toBe('pending');
  });

  it('does not complete the DNS hop from a configured policy alone', () => {
    const hops = byId([
      { stage: 'attempt-start', engine: 'xray', node: 'candidate-a' },
      { stage: 'core-start', engine: 'xray' },
      { stage: 'core-ready', engine: 'xray' },
      { stage: 'dns-policy-active', engine: 'xray', dnsPolicy: 'tunnel-configured' },
    ]);
    expect(hops.core?.state).toBe('ok');
    expect(hops.dns?.state).toBe('active');
    expect(hops.dns?.detail).toContain('not yet observed');
    expect(hops.trace?.state).toBe('pending');
    expect(hops.egress?.state).toBe('pending');
    expect(activeHop(deriveAgentPath([{ stage: 'dns-policy-active', dnsPolicy: 'tunnel-configured' }], true))?.id).toBe('dns');
  });

  it('completes DNS and the TLS trace only after the tunneled response, and waits on egress', () => {
    const hops = byId([
      { stage: 'attempt-start', engine: 'xray' },
      { stage: 'core-ready', engine: 'xray' },
      { stage: 'dns-policy-active', dnsPolicy: 'tunnel-configured' },
      { stage: 'relay-check' },
      { stage: 'dns-response', exitIp: '198.51.100.7', dnsPolicy: 'tunnel-configured' },
    ]);
    expect(hops.dns?.state).toBe('ok');
    expect(hops.trace?.state).toBe('ok');
    expect(hops.egress?.state).toBe('active');
    expect(hops.egress?.detail).not.toContain('198.51.100.7');
  });

  it('reports the exit address only once the route is verified', () => {
    const hops = byId([
      { stage: 'attempt-start', engine: 'xray' },
      { stage: 'dns-response', exitIp: '198.51.100.7' },
      { stage: 'route-active', exitIp: '198.51.100.7' },
    ]);
    expect(hops.egress?.state).toBe('ok');
    expect(hops.egress?.detail).toBe('Exit 198.51.100.7');
  });

  it('fails the core hop but resets it when the next attempt starts', () => {
    const failed = byId([
      { stage: 'attempt-start', engine: 'xray' },
      { stage: 'core-failed', engine: 'xray', message: 'xray: exec format error' },
    ]);
    expect(failed.core?.state).toBe('failed');

    const retried = byId([
      { stage: 'attempt-start', engine: 'xray' },
      { stage: 'core-failed', engine: 'xray', message: 'xray: exec format error' },
      { stage: 'attempt-start', engine: 'sing-box' },
      { stage: 'core-start', engine: 'sing-box' },
    ]);
    expect(retried.core?.state).toBe('active');
    expect(retried.core?.detail).toBe('Starting sing-box');
    expect(retried.dns?.state).toBe('pending');
    expect(currentAttempt([{ stage: 'attempt-start' }, { stage: 'core-failed' }, { stage: 'attempt-start' }])).toHaveLength(1);
  });

  it('marks the DNS hop failed when verification fails after the policy was armed', () => {
    const hops = byId([
      { stage: 'attempt-start', engine: 'xray' },
      { stage: 'dns-policy-active', dnsPolicy: 'tunnel-configured' },
      { stage: 'verification-failed', message: 'getaddrinfo ENOTFOUND trace.example' },
    ]);
    expect(hops.dns?.state).toBe('failed');
    expect(hops.trace?.state).toBe('failed');
    expect(hops.egress?.state).toBe('pending');
  });
});
