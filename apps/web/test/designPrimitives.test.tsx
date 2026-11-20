import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Field, Input } from '../src/components/ui/Field';
import { Metric } from '../src/components/ui/Metric';
import { Segmented } from '../src/components/ui/Segmented';
import { EmptyState } from '../src/components/ui/States';
import { EngineHero } from '../src/components/ui/Surface';
import { TabPanel, Tabs } from '../src/components/ui/Tabs';

/**
 * Pins the four design-system decisions this pass changed, at the level a user
 * meets them. Each of these regressed silently before because nothing asserted
 * the rendered shape — only the CSS contract did, and the CSS cannot see order,
 * roles or which element carries which class.
 */

describe('tab language', () => {
  const items = [
    { value: 'a', label: 'Overview', icon: <span data-testid="icon-a" /> },
    { value: 'b', label: 'Evidence' },
  ];

  it('renders one tablist, one tab per item, and marks only the active one', () => {
    const html = renderToStaticMarkup(
      <Tabs items={items} defaultValue="a" ariaLabel="Sections">
        <TabPanel value="a">A</TabPanel>
        <TabPanel value="b">B</TabPanel>
      </Tabs>,
    );
    expect(html.match(/role="tablist"/g)).toHaveLength(1);
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Sections"');
    // Exactly one tab is selected, and it is the first.
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.indexOf('Overview')).toBeLessThan(html.indexOf('Evidence'));
  });

  it('carries the item icon through to the trigger', () => {
    const html = renderToStaticMarkup(
      <Tabs items={items} defaultValue="a">
        <TabPanel value="a">A</TabPanel>
        <TabPanel value="b">B</TabPanel>
      </Tabs>,
    );
    expect(html).toContain('data-testid="icon-a"');
  });

  it('uses the same track chrome for the filter counterpart', () => {
    // `Segmented` and `Tabs` are different ARIA roles but must be the same
    // object on screen; they drifted once (rounded-xl vs rounded-lg).
    const tabs = renderToStaticMarkup(
      <Tabs items={items} defaultValue="a">
        <TabPanel value="a">A</TabPanel>
      </Tabs>,
    );
    const segmented = renderToStaticMarkup(
      <Segmented value="a" onChange={() => {}} ariaLabel="Filter" items={[{ value: 'a', label: 'A' }]} />,
    );
    const track = /rounded-\[var\(--np-r-3\)\][^"]*bg-surface-2\/50/;
    expect(track.test(tabs)).toBe(true);
    expect(track.test(segmented)).toBe(true);
    expect(segmented).toContain('role="radiogroup"');
    expect(segmented).toContain('aria-checked="true"');
  });
});

describe('empty state', () => {
  it('draws no second border inside the card that holds it', () => {
    const html = renderToStaticMarkup(<EmptyState title="No hypotheses yet" message="They appear on a diagnosis." />);
    // A bordered block inside a bordered card reads as a box that failed to
    // load. The empty state separates itself with tone instead.
    expect(html).not.toMatch(/rounded-\[var\(--np-r-3\)\][^"]*border /);
    expect(html).toContain('bg-surface-2/40');
  });
});

describe('field anatomy', () => {
  it('places help text after the control so paired fields share a baseline', () => {
    const html = renderToStaticMarkup(
      <Field label="Text size" hint="Scales every text size in the app at once.">
        <Input defaultValue="default" />
      </Field>,
    );
    const label = html.indexOf('Text size');
    const control = html.indexOf('<input');
    const hint = html.indexOf('Scales every text size');
    expect(label).toBeGreaterThanOrEqual(0);
    expect(control).toBeGreaterThan(label);
    expect(hint).toBeGreaterThan(control);
  });

  it('replaces the hint with the error rather than showing both', () => {
    const html = renderToStaticMarkup(
      <Field label="Port" hint="1-65535" error="Port is out of range">
        <Input defaultValue="0" />
      </Field>,
    );
    expect(html).toContain('Port is out of range');
    expect(html).not.toContain('1-65535');
  });
});

describe('metric sizing', () => {
  it('reads at the supporting size by default and the focal size on request', () => {
    const md = renderToStaticMarkup(<Metric label="Ping" value={12} unit="ms" />);
    const lg = renderToStaticMarkup(<Metric label="Download" value={120} unit="mbps" size="lg" />);
    expect(md).toContain('text-xl');
    expect(md).not.toContain('text-2xl');
    expect(lg).toContain('text-2xl');
  });
});

describe('engine hero heading rank', () => {
  const hero = (pageTitle?: boolean) => (
    <EngineHero
      pageTitle={pageTitle}
      glyph={<span />}
      name="Node name"
      tagline="vless · tcp · tls"
    />
  );

  /**
   * `headingTag` clamps to a minimum of h2 so a nested card can never emit h1.
   * NodeDetailPage is the page, not a section of one, and it consequently had no
   * h1 at all — the document outline started at h2.
   */
  it('is an h2 by default, because a hero under a page title is a section', () => {
    const html = renderToStaticMarkup(hero());
    expect(html).toContain('<h2');
    expect(html).not.toContain('<h1');
  });

  it('becomes the page h1 only when it is the page title', () => {
    const html = renderToStaticMarkup(hero(true));
    expect(html).toContain('<h1');
    expect(html).not.toContain('<h2');
  });
});
