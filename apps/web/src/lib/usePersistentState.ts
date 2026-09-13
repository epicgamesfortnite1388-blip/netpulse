import { useCallback, useState } from 'react';

function serialize<T>(v: T): string {
  // JSON.stringify(new Set(...)) yields "{}" — store sets as arrays and revive
  // them so Set-valued state round-trips intact.
  return JSON.stringify(v instanceof Set ? { __npSet: [...v] } : v);
}

function deserialize<T>(raw: string): T {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed != null && typeof parsed === 'object' && '__npSet' in (parsed as Record<string, unknown>)) {
    return new Set((parsed as { __npSet: unknown[] }).__npSet) as unknown as T;
  }
  return parsed as T;
}

/**
 * State that survives unmounting (tab switches) and full reloads.
 *
 * Why: this is a desktop app with multiple heavyweight pages. Switching tabs
 * unmounts the page component; plain useState wipes filters, form inputs,
 * selections, and — worst — the IDs of running background tests, so the user
 * returns to find everything reset while the backend job kept running.
 *
 * sessionStorage survives route unmounts AND full app reloads within the
 * webview session, and is cleared when the app window closes — exactly the
 * lifetime "this app session" state wants. Server data itself is NOT cached
 * here; pages refetch on mount as usual, only UI state persists.
 */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const storageKey = `np.ui.${key}`;

  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw != null) return deserialize<T>(raw);
    } catch {
      // corrupted entry: fall through to initial
    }
    return initial;
  });

  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        try {
          sessionStorage.setItem(storageKey, serialize(next));
        } catch {
          // storage full/blocked — state still works in-memory
        }
        return next;
      });
    },
    [storageKey],
  );

  return [value, set];
}

/**
 * Narrower helper for the common "selected/running entity id" pattern.
 * Returns null when the stored id's entity no longer exists (caller checks).
 */
export function usePersistentId(key: string): [string | null, (v: string | null) => void] {
  return usePersistentState<string | null>(key, null);
}
