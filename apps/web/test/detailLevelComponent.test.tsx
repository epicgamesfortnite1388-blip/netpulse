import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DetailGate, DetailLevelControl, DetailLevelProvider } from '../src/components/ui/DetailLevel';

/**
 * Component-level coverage for the four-level disclosure wiring.
 *
 * The policy in `lib/detailLevel.ts` is tested separately and thoroughly. That is
 * not the same thing as testing the binding: `declares` and `depth` are merged
 * into a requirement list by a `useMemo`, gates register themselves in an effect
 * *after* the render that decides whether to show their children, and the control
 * has a guard that decides whether it exists at all. Every one of those is
 * ordinary code that a refactor can break while the policy tests stay green.
 *
 * Before this file existed, nothing in `test/` referenced `DetailGate`,
 * `DetailLevelProvider` or `DetailLevelControl` — the binding was verified only
 * end-to-end in a browser. That is real evidence for the four pages captured, but
 * it says nothing about the pages that were not captured, and it cannot tell a
 * future editor which invariant they just broke.
 *
 * Rendered with `react-dom/client` and `act` rather than a testing library,
 * because the repo deliberately carries no testing-library dependency.
 */

// React 19 warns on `act` outside a configured test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

/** The labels the detail control is currently offering, in order. */
function offeredLabels(): string[] {
  const group = document.querySelector('[role="radiogroup"][aria-label="Detail level"]');
  if (!group) return [];
  return [...group.querySelectorAll('[role="radio"]')].map((el) => (el.textContent ?? '').trim());
}

describe('DetailGate', () => {
  it('hides its children below the required level', async () => {
    await render(
      <DetailLevelProvider scope="below" defaultLevel={2}>
        <DetailGate required={3}>
          <span>advanced only</span>
        </DetailGate>
      </DetailLevelProvider>,
    );
    expect(container.textContent).not.toContain('advanced only');
  });

  it('shows its children at the required level', async () => {
    await render(
      <DetailLevelProvider scope="at" defaultLevel={3}>
        <DetailGate required={3}>
          <span>advanced only</span>
        </DetailGate>
      </DetailLevelProvider>,
    );
    expect(container.textContent).toContain('advanced only');
  });

  it('renders children unconditionally when there is no provider', async () => {
    // A gate outside a provider must not silently delete content; the page has
    // simply not opted into disclosure.
    await render(
      <DetailGate required={4}>
        <span>ungated</span>
      </DetailGate>,
    );
    expect(container.textContent).toContain('ungated');
  });

  it('tags the wrapper with its level so the rendered depth is inspectable', async () => {
    await render(
      <DetailLevelProvider scope="t" defaultLevel={4}>
        <DetailGate required={2}>
          <span>x</span>
        </DetailGate>
      </DetailLevelProvider>,
    );
    expect(container.querySelector('[data-detail-level="2"]')).not.toBeNull();
  });
});

describe('DetailLevelControl', () => {
  it('renders nothing when the page has neither gates nor a declared depth', async () => {
    await render(
      <DetailLevelProvider scope="t" defaultLevel={1}>
        <span>plain</span>
      </DetailLevelProvider>,
    );
    expect(offeredLabels()).toEqual([]);
  });

  it('renders when the page declares a depth, even with no gate mounted', async () => {
    // This is the Diagnostics case: its level-3 gates live inside a run, so on an
    // idle page nothing registers. Without `depth` the control vanished and a
    // reader could not reach Advanced at all.
    await render(
      <DetailLevelProvider scope="t" defaultLevel={2} depth={3}>
        <DetailLevelControl />
      </DetailLevelProvider>,
    );
    expect(offeredLabels()).toEqual(['Essential', 'Context', 'Advanced']);
  });

  it('offers only the levels the mounted gates can reach', async () => {
    await render(
      <DetailLevelProvider scope="t" defaultLevel={2}>
        <DetailLevelControl />
        <DetailGate required={2}>
          <span>a</span>
        </DetailGate>
      </DetailLevelProvider>,
    );
    // Nothing beyond Context exists on this page, so Expert is not offered — an
    // option that changes nothing reads as a broken control.
    expect(offeredLabels()).toEqual(['Essential', 'Context']);
  });

  it('counts declared requirements but not the declared depth', async () => {
    await render(
      <DetailLevelProvider scope="t" defaultLevel={1} declares={[2, 3, 4]} depth={4}>
        <DetailLevelControl />
      </DetailLevelProvider>,
    );
    expect(offeredLabels()).toEqual(['Essential', 'Context', 'Advanced', 'Expert']);
    // Three declared sections are hidden at Essential. `depth` adds no count.
    const hint = container.textContent ?? '';
    expect(hint).toContain('3 more from Context');
  });

  it('clamps the selected level to what the page offers', async () => {
    // A stored Expert on a page that only reaches Context must not leave the
    // control with nothing selected.
    sessionStorage.setItem('np.ui.detail:t', '4');
    await render(
      <DetailLevelProvider scope="t" defaultLevel={2} declares={[2]}>
        <DetailLevelControl />
      </DetailLevelProvider>,
    );
    const checked = document.querySelector('[role="radio"][aria-checked="true"]');
    expect(checked?.textContent?.trim()).toBe('Context');
  });
});

describe('level changes through the real control', () => {
  it('reveals content when a deeper level is clicked', async () => {
    await render(
      <DetailLevelProvider scope="t" defaultLevel={1} declares={[2]}>
        <DetailLevelControl />
        <DetailGate required={2}>
          <span>context block</span>
        </DetailGate>
      </DetailLevelProvider>,
    );
    expect(container.textContent).not.toContain('context block');

    const context = [...document.querySelectorAll('[role="radio"]')].find(
      (el) => (el.textContent ?? '').trim() === 'Context',
    ) as HTMLButtonElement;
    await act(async () => {
      context.click();
    });

    expect(container.textContent).toContain('context block');
  });
});
