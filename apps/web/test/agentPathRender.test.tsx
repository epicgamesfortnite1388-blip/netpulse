import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentPathTrace } from '../src/features/vpn/AgentPathTrace';
import { deriveAgentPath } from '../src/features/vpn/agentPath';

/**
 * Renders the real trace and asserts what a user would read.
 *
 * The state attribute is the honest part: `data-state` is what colours the hop,
 * so "the policy is armed" must not render as the same green a resolved
 * hostname does.
 */

const ARMED = deriveAgentPath(
  [
    { stage: 'attempt-start', engine: 'xray' },
    { stage: 'core-ready', engine: 'xray' },
    { stage: 'dns-policy-active', dnsPolicy: 'tunnel-configured' },
  ],
  true,
);

const RESOLVED = deriveAgentPath(
  [
    { stage: 'attempt-start', engine: 'xray' },
    { stage: 'core-ready', engine: 'xray' },
    { stage: 'dns-policy-active', dnsPolicy: 'tunnel-configured' },
    { stage: 'dns-response', exitIp: '198.51.100.7', dnsPolicy: 'tunnel-configured' },
  ],
  true,
);

function dnsChip(html: string): string {
  return html.split('<li').find((chunk) => chunk.includes('>DNS<')) ?? '';
}

describe('AgentPathTrace', () => {
  it('separates an armed DNS policy from an observed resolution', () => {
    expect(dnsChip(renderToStaticMarkup(<AgentPathTrace hops={ARMED} busy />))).toContain('data-state="active"');
    expect(dnsChip(renderToStaticMarkup(<AgentPathTrace hops={RESOLVED} busy />))).toContain('data-state="ok"');
  });

  it('says the resolver was not identified instead of claiming one', () => {
    const html = renderToStaticMarkup(<AgentPathTrace hops={RESOLVED} busy />);
    expect(html).toContain('resolved inside the tunneled request');
    expect(html).not.toContain('1.1.1.1');
  });

  it('gates every animation behind reduced-motion', () => {
    const html = renderToStaticMarkup(<AgentPathTrace hops={ARMED} busy />);
    expect(html).toContain('motion-safe:');
    expect(html).toContain('motion-reduce:animate-none');
  });
});
