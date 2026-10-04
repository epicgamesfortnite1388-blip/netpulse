import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MetricStrip } from '../src/components/ui/Surface';
import { healthMetricItems, nodeRates } from '../src/features/nodes/nodeHealthDisplay';

import type { NodeHealthSummary } from '../src/features/nodes/nodeHealthDisplay';

/**
 * The node page renders its rates from a stored row that seeds reliability and
 * loss at 0 whether or not anything ever probed the node. 0% loss is the
 * healthiest string this page can print, so a node nothing had been tested
 * against used to look flawless. This renders the actual strip — real
 * components, real formatting — and asserts what the user would read.
 *
 * No testing-library: `MetricStrip` is a pure function of its items, so
 * server-rendering it exercises the whole path that produces the text without a
 * DOM, a new dependency, or a jsdom environment.
 */

const UNPROBED_STORE = { testCount: 0, reliabilityPct: 0, recentLossPct: 0 };

function render(health: NodeHealthSummary | null, store = UNPROBED_STORE): string {
  const rates = nodeRates(health, store);
  return renderToStaticMarkup(<MetricStrip items={healthMetricItems(rates, health?.medianLatencyMs ?? null)} />);
}

/** The value tile for `label`, exactly as the user reads it. */
function tile(html: string, label: string): string {
  const m = new RegExp(`>${label}</p><p[^>]*>([^<]*)</p>`).exec(html);
  expect(m, `no tile labelled "${label}" in the rendered strip`).toBeTruthy();
  return m![1]!.trim();
}

describe('node health strip, nothing ever probed', () => {
  const html = render(null);

  it('reads as unavailable rather than as a healthy zero', () => {
    expect(tile(html, 'Packet loss')).toBe('—');
    expect(tile(html, 'Reliability')).toBe('—');
    expect(html).not.toContain('0.0%');
  });

  it('does not colour an unmeasured rate as healthy', () => {
    // The tone drives the class on the value element; 'ok' renders text-ok,
    // 'faint' renders text-faint. Green on a number nobody measured is the
    // defect, so the strip must not contain it.
    expect(html).not.toContain('text-ok');
  });

  it('still reports the probe count, which is a real measurement of zero', () => {
    expect(tile(html, 'Probes')).toBe('0');
  });
});

describe('node health strip, probes ran and measured zero loss', () => {
  const html = render({
    testCount: 4,
    successCount: 4,
    failureCount: 0,
    reliabilityPct: 100,
    medianLatencyMs: 88,
    lossPct: 0,
    consecutiveFailures: 0,
    lastSuccessAt: 1,
    lastFailureAt: null,
  });

  it('shows the measured zero, because that one is real', () => {
    expect(tile(html, 'Packet loss')).toBe('0.0%');
    expect(tile(html, 'Reliability')).toBe('100.0%');
    expect(tile(html, 'Probes')).toBe('4');
  });
});

describe('node health strip, probes ran and measured loss', () => {
  it('reports the real figure and does not soften it', () => {
    const html = render({
      testCount: 3,
      successCount: 2,
      failureCount: 1,
      reliabilityPct: 66.7,
      medianLatencyMs: 88,
      lossPct: 33.3,
      consecutiveFailures: 1,
      lastSuccessAt: 1,
      lastFailureAt: 2,
    });
    expect(tile(html, 'Packet loss')).toBe('33.3%');
  });
});