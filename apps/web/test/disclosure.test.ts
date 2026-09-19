import { describe, expect, it } from 'vitest';

import {
  DISCLOSURE_KEY_PREFIX,
  disclosureKey,
  foldedSummary,
  ignoresScopeBroadcast,
  pinnedCount,
  resolveOpen,
  toggleableSections,
} from '../src/lib/disclosure';

import type { DisclosureSpec } from '../src/lib/disclosure';

/**
 * Folding is UI state the app must own deliberately: a page-wide "collapse all"
 * that also hid the section you were working in would be worse than no control
 * at all, and a section whose remembered state leaks across pages makes the app
 * feel unpredictable. These are the rules that prevent both.
 */
describe('collapsible section policy', () => {
  it('namespaces the storage key by scope, so two pages can share a section id', () => {
    const spec: DisclosureSpec = { id: 'advanced', defaultOpen: true };
    const a = disclosureKey('vpn:aether', spec);
    const b = disclosureKey('vpn:xray', spec);

    expect(a).not.toBe(b);
    expect(a.startsWith(DISCLOSURE_KEY_PREFIX + 'vpn:aether:')).toBe(true);
    // Never collides with the session state other hooks persist under np.ui.*
    expect(a).not.toContain('np.ui.');
  });

  it('stores under storageId when a section keeps its id but needs a stable key', () => {
    const spec: DisclosureSpec = { id: 'auto-test', storageId: 'settings.autoTest', defaultOpen: true };
    expect(disclosureKey('settings', spec)).toBe(`${DISCLOSURE_KEY_PREFIX}settings:settings.autoTest`);
  });

  it('lets a stored choice win over the declared default, both ways', () => {
    const folded: DisclosureSpec = { id: 'diagnostics', defaultOpen: false };
    const open: DisclosureSpec = { id: 'profiles', defaultOpen: true };

    expect(resolveOpen(folded, false)).toBe(false);
    expect(resolveOpen(folded, true)).toBe(true);
    expect(resolveOpen(open, false)).toBe(false);
    expect(resolveOpen(open, true)).toBe(true);
  });

  it('falls back to the default when nothing (or something unusable) is stored', () => {
    const spec: DisclosureSpec = { id: 'capabilities', defaultOpen: false };

    expect(resolveOpen(spec, null)).toBe(false);
    expect(resolveOpen(spec, undefined)).toBe(false);
    // Storage is a boundary too: a hand-edited value must not become a boolean.
    expect(resolveOpen(spec, 'yes')).toBe(false);
    expect(resolveOpen({ id: 'x', defaultOpen: true }, 0)).toBe(true);
  });

  it('a page-wide fold moves every section except the pinned ones', () => {
    const specs: DisclosureSpec[] = [
      { id: 'engines', defaultOpen: true, pinned: true },
      { id: 'admin', defaultOpen: false },
      { id: 'relationships', defaultOpen: false },
    ];

    expect(toggleableSections(specs)).toEqual(['admin', 'relationships']);
    expect(ignoresScopeBroadcast(specs[0]!)).toBe(true);
    expect(ignoresScopeBroadcast(specs[1]!)).toBe(false);
    expect(pinnedCount(specs)).toBe(1);
  });

  it('a folded section keeps a one-line summary, and invents nothing when there is none', () => {
    expect(foldedSummary('  3 profiles, secrets in the vault  ')).toBe('3 profiles, secrets in the vault');
    expect(foldedSummary('')).toBeNull();
    expect(foldedSummary('   ')).toBeNull();
    expect(foldedSummary(undefined)).toBeNull();
  });
});
