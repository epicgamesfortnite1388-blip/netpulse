import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { Segmented } from '@/components/ui/Segmented';
import { usePersistentState } from '@/lib/usePersistentState';
import {
  DEFAULT_DETAIL_LEVEL,
  DETAIL_LEVEL_META,
  deepestLevel,
  detailKey,
  isVisible,
  nextLevelWithContent,
  offeredLevels,
  resolveDetailLevel,
  suppressedCount,
} from '@/lib/detailLevel';

import type { DetailLevel } from '@/lib/detailLevel';
import type { ReactNode } from 'react';

/**
 * The four-level progressive-disclosure binding.
 *
 * A page wraps its content in `<DetailLevelProvider scope="dashboard" …>` and
 * marks each block with the shallowest level at which it becomes relevant:
 *
 *   <DetailGate required={2}>  …measurements…  </DetailGate>
 *   <DetailGate required={4}>  …event history… </DetailGate>
 *
 * The provider remembers the reader's choice per scope (sessionStorage, like
 * every other piece of UI state), and the control reports how many blocks are
 * suppressed so depth is never invisible.
 *
 * The policy — which level means what, how gating composes, how a stored value
 * is validated — lives in `lib/detailLevel.ts` and is unit-tested there. This
 * file only binds it to React.
 */

interface DetailValue {
  scope: string;
  level: DetailLevel;
  setLevel: (level: DetailLevel) => void;
  register: (id: number, required: DetailLevel) => void;
  unregister: (id: number) => void;
  /** Every level currently required by a mounted gate, plus any declared. */
  requirements: DetailLevel[];
  /**
   * The deepest level this page supports. Drives which options the control
   * offers, so an option can never be a dead click.
   */
  reach: DetailLevel;
  /** The declared depth, or null when the page derives its depth from gates. */
  depth: DetailLevel | null;
}

const DetailContext = createContext<DetailValue | null>(null);

export function DetailLevelProvider({
  scope,
  defaultLevel = DEFAULT_DETAIL_LEVEL,
  declares,
  depth,
  children,
}: {
  scope: string;
  defaultLevel?: DetailLevel;
  /**
   * Requirements the page owns structurally rather than through a `DetailGate`,
   * where those requirements *are* the disclosed sections.
   *
   * Most pages gate blocks, and each gate registers itself. A page whose
   * disclosure is its navigation — NANI, where the level decides which tabs
   * exist — has no gate to mount, so without this the provider would see an
   * empty requirement list and render no control at all, leaving the feature
   * invisible on exactly the page that depends on it most. Declared levels are
   * counted, because each one stands for a section the reader cannot see yet.
   */
  declares?: readonly DetailLevel[];
  /**
   * The deepest level this page supports, when that depth is not visible as a
   * mounted gate.
   *
   * Diagnostics gates its per-stage timings inside `running`/`report`, so on an
   * idle page those gates do not exist and the control would silently collapse
   * from three options to two — and a reader who chose Advanced during a run
   * would come back to find the option gone. This states the page's real depth
   * independently of what happens to be on screen. It is *not* counted: it is a
   * capability, not a hidden section, and counting it would inflate the hint.
   */
  depth?: DetailLevel;
  children: ReactNode;
}) {
  // Persisted per scope: opening Expert on Diagnostics must not turn the
  // dashboard into a wall of events.
  const [stored, setStored] = usePersistentState<DetailLevel>(detailKey(scope), defaultLevel);
  const level = resolveDetailLevel(stored, defaultLevel);
  const [requirements, setRequirements] = useState<Array<[number, DetailLevel]>>([]);

  const setLevel = useCallback((next: DetailLevel) => setStored(next), [setStored]);

  const register = useCallback((id: number, required: DetailLevel) => {
    setRequirements((prev) => (prev.some(([k]) => k === id) ? prev : [...prev, [id, required]]));
  }, []);

  const unregister = useCallback((id: number) => {
    setRequirements((prev) => (prev.length === 0 ? prev : prev.filter(([k]) => k !== id)));
  }, []);

  const value = useMemo<DetailValue>(() => {
    const fromGates = requirements.map(([, r]) => r);
    const all = declares ? [...fromGates, ...declares] : fromGates;
    const gateReach = deepestLevel(all);
    return {
      scope,
      level,
      setLevel,
      register,
      unregister,
      requirements: all,
      reach: depth && depth > gateReach ? depth : gateReach,
      depth: depth ?? null,
    };
  }, [scope, level, setLevel, register, unregister, requirements, declares, depth]);

  return <DetailContext.Provider value={value}>{children}</DetailContext.Provider>;
}

/** The current level, or null when the page has not opted into disclosure. */
export function useDetailLevel(): DetailValue | null {
  return useContext(DetailContext);
}

/**
 * The level control.
 *
 * A radiogroup rather than a menu: four options is few enough to show, and
 * showing them is the point — a reader who cannot see that Expert exists will
 * never look for it. The hint underneath names the next level that has content,
 * so "there is more" is a statement rather than a guess.
 *
 * Renders nothing when no gate has registered, i.e. on pages where every block
 * is essential and there is nothing to disclose.
 */
export function DetailLevelControl({ className = '' }: { className?: string }) {
  const detail = useContext(DetailContext);
  if (!detail) return null;
  // A page with neither gates nor a declared depth has nothing to disclose, so
  // it gets no control. But a page that declared a depth keeps its control even
  // while no gate is mounted — otherwise Essential would be a trap: at that
  // level every gate may be unmounted, and with them the only way back up.
  if (detail.requirements.length === 0 && detail.depth === null) return null;

  // Offer only the levels this page can actually reach, so no option is a dead
  // click. `shown` is clamped the same way, because a stored level from a
  // deeper configuration of this page would otherwise select nothing.
  const offered = offeredLevels([detail.reach]);
  const shown = (detail.level > detail.reach ? detail.reach : detail.level) as DetailLevel;

  const hidden = suppressedCount(detail.requirements, shown);
  const next = nextLevelWithContent(detail.requirements, shown);

  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 ${className}`}>
      <span className="np-label">Detail</span>
      <Segmented<DetailLevel>
        value={shown}
        onChange={detail.setLevel}
        ariaLabel="Detail level"
        size="sm"
        items={offered.map((level) => ({
          value: level,
          label: (
            <span title={DETAIL_LEVEL_META[level].summary} className="whitespace-nowrap">
              {DETAIL_LEVEL_META[level].label}
            </span>
          ),
        }))}
      />
      <span className="text-micro text-faint" aria-live="polite">
        {next ? `${hidden} more from ${DETAIL_LEVEL_META[next].label}` : DETAIL_LEVEL_META[shown].summary}
      </span>
    </div>
  );
}

/**
 * Renders its children only when the current level reaches `required`.
 *
 * `required: 1` is allowed and renders unconditionally — it is how a page states
 * "this is essential" explicitly, which keeps the level of a block readable in
 * the source rather than implied by the absence of a gate.
 */
export function DetailGate({ required, children }: { required: DetailLevel; children: ReactNode }) {
  const detail = useContext(DetailContext);
  const idRef = useRef<number>(0);
  if (idRef.current === 0) idRef.current = nextGateId();

  const register = detail?.register;
  const unregister = detail?.unregister;

  useEffect(() => {
    if (!register || !unregister) return;
    const id = idRef.current;
    register(id, required);
    return () => unregister(id);
  }, [register, unregister, required]);

  if (!detail) return <>{children}</>;
  if (!isVisible(required, detail.level)) return null;
  return (
    <div data-detail-level={required} className="contents">
      {children}
    </div>
  );
}

let gateCounter = 0;
function nextGateId(): number {
  gateCounter += 1;
  return gateCounter;
}
