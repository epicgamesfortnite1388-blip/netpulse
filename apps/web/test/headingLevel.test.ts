import { describe, expect, it } from 'vitest';

import { headingTag } from '../src/components/ui/HeadingLevel';

/**
 * Heading ranks are derived from nesting depth rather than declared per call
 * site, so this is the one place the document outline can be wrong. The clamp
 * matters: HTML defines h1..h6, and a card nested seven deep would otherwise
 * render `<h7>` — which browsers silently demote to a div, losing the heading
 * role entirely and re-introducing the very gap this fixes.
 */
describe('headingTag', () => {
  it('renders a top-level card as h2 — the level every page was missing', () => {
    expect(headingTag(2)).toBe('h2');
  });

  it('deepens with nesting', () => {
    expect(headingTag(3)).toBe('h3');
    expect(headingTag(4)).toBe('h4');
  });

  it('clamps to the levels HTML actually defines', () => {
    expect(headingTag(7)).toBe('h6');
    expect(headingTag(42)).toBe('h6');
  });

  it('never demotes a card below the page title', () => {
    expect(headingTag(1)).toBe('h2');
    expect(headingTag(0)).toBe('h2');
  });
});