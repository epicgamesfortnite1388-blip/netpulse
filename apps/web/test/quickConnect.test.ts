import { describe, expect, it } from 'vitest';

import {
  filterQuickNodes,
  overlayShortcut,
  quickNodeMeta,
  stepActive,
  type QuickNode,
} from '../src/lib/quickConnect';

/**
 * Quick connect is keyboard-only: the selection lives in state, not in the DOM,
 * so a bug here cannot be seen by looking at the list. These pin the three rules
 * that decide what Enter will do — which nodes a query matches, where the
 * selection moves, and which overlay a shortcut opens.
 */

function node(overrides: Partial<QuickNode> = {}): QuickNode {
  return {
    id: 'node:1',
    label: 'Tokyo edge',
    protocol: 'vless',
    country: 'Japan',
    city: 'Tokyo',
    remark: 'premium relay',
    medianProxyMs: 84,
    status: 'healthy',
    ...overrides,
  };
}

const NODES: QuickNode[] = [
  node({ id: 'a', label: 'Tokyo edge', protocol: 'vless', country: 'Japan', city: 'Tokyo', medianProxyMs: 84 }),
  node({ id: 'b', label: 'Frankfurt core', protocol: 'trojan', country: 'Germany', city: 'Frankfurt', medianProxyMs: 132, remark: null }),
  node({ id: 'c', label: 'Tokyo backup', protocol: 'vmess', country: 'Japan', city: 'Saitama', medianProxyMs: null, remark: null }),
  node({ id: 'd', label: 'Relay', protocol: 'hysteria2', country: null, city: null, medianProxyMs: 210, remark: 'premium relay' }),
];

describe('quick connect filtering', () => {
  it('keeps every candidate for an empty query', () => {
    expect(filterQuickNodes(NODES, '').map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterQuickNodes(NODES, '   ').map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('preserves the server order (fastest tested first) rather than re-sorting', () => {
    const filtered = filterQuickNodes(NODES, 'tokyo');
    expect(filtered.map((n) => n.id)).toEqual(['a', 'c']);
  });

  it('matches label, protocol, country, city and remark, case-insensitively', () => {
    expect(filterQuickNodes(NODES, 'FRANKFURT').map((n) => n.id)).toEqual(['b']);
    expect(filterQuickNodes(NODES, 'hysteria2').map((n) => n.id)).toEqual(['d']);
    expect(filterQuickNodes(NODES, 'japan').map((n) => n.id)).toEqual(['a', 'c']);
    expect(filterQuickNodes(NODES, 'saitama').map((n) => n.id)).toEqual(['c']);
    expect(filterQuickNodes(NODES, 'premium').map((n) => n.id)).toEqual(['a', 'd']);
  });

  it('ANDs multiple tokens across different fields', () => {
    // "japan vless" is neither a label nor a field on its own; the user typing
    // two words means both constraints, not one string.
    expect(filterQuickNodes(NODES, 'japan vless').map((n) => n.id)).toEqual(['a']);
    expect(filterQuickNodes(NODES, 'tokyo trojan')).toEqual([]);
  });

  it('returns nothing for a query no candidate contains', () => {
    expect(filterQuickNodes(NODES, 'moon base')).toEqual([]);
  });

  it('does not mutate the list it was given', () => {
    const copy = [...NODES];
    const filtered = filterQuickNodes(NODES, 'tokyo');
    expect(filtered).not.toBe(NODES);
    filtered.pop();
    expect(NODES).toEqual(copy);
  });
});

describe('quick connect selection', () => {
  it('moves down and up one row at a time', () => {
    expect(stepActive(0, 4, 1)).toBe(1);
    expect(stepActive(2, 4, -1)).toBe(1);
  });

  it('wraps at both ends, so the first row is reachable from the top', () => {
    // The overlay opens on row 0; ↑ must reach the last candidate, not stall.
    expect(stepActive(0, 4, -1)).toBe(3);
    expect(stepActive(3, 4, 1)).toBe(0);
  });

  it('stays at 0 for an empty result set', () => {
    expect(stepActive(0, 0, 1)).toBe(0);
    expect(stepActive(0, 0, -1)).toBe(0);
  });

  it('keeps a single-row list on that row', () => {
    expect(stepActive(0, 1, 1)).toBe(0);
    expect(stepActive(0, 1, -1)).toBe(0);
  });
});

describe('row meta', () => {
  it('shows place and the measured latency', () => {
    expect(quickNodeMeta(node())).toBe('Tokyo, Japan · 84 ms');
  });

  it('drops a missing city instead of printing an empty comma', () => {
    expect(quickNodeMeta(node({ city: null }))).toBe('Japan · 84 ms');
  });

  it('says the location is unknown rather than leaving the slot blank', () => {
    expect(quickNodeMeta(node({ city: null, country: null }))).toBe('location unknown · 84 ms');
  });

  it('never rounds an unmeasured latency into a number', () => {
    expect(quickNodeMeta(node({ medianProxyMs: null }))).toBe('Tokyo, Japan · unmeasured');
  });
});

describe('overlay shortcuts', () => {
  const key = (overrides: Partial<Parameters<typeof overlayShortcut>[0]> = {}) => ({
    key: 'k',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it('opens the command palette on Ctrl+K and on Cmd+K', () => {
    expect(overlayShortcut(key({ ctrlKey: true }))).toBe('palette');
    expect(overlayShortcut(key({ metaKey: true }))).toBe('palette');
  });

  it('opens quick connect on Ctrl+Shift+K and on Cmd+Shift+K', () => {
    // Shift+K reports key "K" on most layouts, which is why the key is folded.
    expect(overlayShortcut(key({ ctrlKey: true, shiftKey: true, key: 'K' }))).toBe('quick-connect');
    expect(overlayShortcut(key({ metaKey: true, shiftKey: true }))).toBe('quick-connect');
  });

  it('leaves every other key alone', () => {
    expect(overlayShortcut(key({ key: 'j', ctrlKey: true }))).toBeNull();
    expect(overlayShortcut(key({ key: 'k' }))).toBeNull();
    expect(overlayShortcut(key({ key: 'Enter', ctrlKey: true }))).toBeNull();
  });
});
