import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression: a repeat background test must not render the PREVIOUS run's
 * result. Ten screens reuse one mounted component across runs (SpeedTest,
 * Diagnostics x3, Dns x2, Gaming, Optimizer, Routes x2) and callers clear the
 * id (setDiagId(null)) before POSTing the next one. React state is not keyed
 * by the id, so without an explicit reset the old numbers stay visible while
 * the new test attaches — and a failed POST leaves them there with no error.
 *
 * This drives the real hook through a real React root; the WS and REST
 * boundaries are the only mocks. A simplified pure-function copy would pass
 * even if the hook were reverted, which would be a false-green test.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listeners = new Map<string, (msg: { type: string; pct?: number; result?: unknown; message?: string }) => void>();
const unsubscribed: string[] = [];
const apiGet = vi.fn(() => new Promise<{ test: null }>(() => undefined));

vi.mock('@/lib/ws', () => ({
  subscribeTest: (id: string, cb: (msg: { type: string; pct?: number; result?: unknown; message?: string }) => void) => {
    listeners.set(id, cb);
    return () => {
      unsubscribed.push(id);
      listeners.delete(id);
    };
  },
}));

vi.mock('@/lib/api', () => ({ api: { get: apiGet, post: vi.fn() } }));

const { useBackgroundTest } = await import('../src/lib/useBackgroundTest');

interface Result {
  v: string;
}

function Harness({ id }: { id: string | null }) {
  const s = useBackgroundTest<Result>(id);
  return <div>{JSON.stringify(s)}</div>;
}

let container: HTMLDivElement;
let root: Root;

function renderId(id: string | null) {
  act(() => {
    root.render(<Harness id={id} />);
  });
  return () => JSON.parse(container.textContent ?? '{}') as {
    pct: number | null;
    running: boolean;
    result: Result | null;
    error: string | null;
  };
}

beforeEach(() => {
  listeners.clear();
  unsubscribed.length = 0;
  apiGet.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useBackgroundTest id transitions', () => {
  it('drops a finished result when a new test id arrives', () => {
    const read = renderId('A');
    expect(read().running).toBe(true);

    act(() => listeners.get('A')?.({ type: 'test:done', result: { v: 'A' } }));
    expect(read().result).toEqual({ v: 'A' });
    expect(read().running).toBe(false);

    renderId('B');
    const next = read();
    expect(next.result).toBeNull();
    expect(next.error).toBeNull();
    expect(next.running).toBe(true);
    expect(unsubscribed).toContain('A');

    // A late frame from the superseded run cannot repaint the new one.
    act(() => listeners.get('A')?.({ type: 'test:done', result: { v: 'stale' } }));
    expect(read().result).toBeNull();
  });

  it('drops the old result when the caller clears the id before a new POST', () => {
    const read = renderId('A');
    act(() => listeners.get('A')?.({ type: 'test:done', result: { v: 'A' } }));
    expect(read().result).toEqual({ v: 'A' });

    renderId(null);
    expect(read().result).toBeNull();
    expect(read().running).toBe(false);
    expect(read().error).toBeNull();
  });

  it('keeps the completed result while the same id stays mounted', () => {
    const read = renderId('A');
    act(() => listeners.get('A')?.({ type: 'test:done', result: { v: 'A' } }));
    renderId('A');
    expect(read().result).toEqual({ v: 'A' });
    expect(read().running).toBe(false);
  });
});
