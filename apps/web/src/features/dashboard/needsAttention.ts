/**
 * "Needs attention" — which problems the backend already knows about should be
 * shown on the Dashboard, and what single action resolves each one.
 *
 * This module is deliberately pure: no fetch, no React, no storage. It turns
 * two payloads the app ALREADY has (`GET /vpn/selftest` and `GET /events`) into
 * a ranked, deduplicated, individually-dismissible list. The view lives in
 * NeedsAttentionCard.tsx; the rules live here so they can be tested directly.
 *
 * Five rules decide what earns a place on the strip. Each exists because the
 * naive version of this feature is worse than no feature:
 *
 *  1. THE STRUCTURED RESULT IS THE DIAGNOSIS; THE LOG IS THE ECHO. The dev
 *     database held eight copies of one sentence ("6 of 7 stored profiles have
 *     missing or unreadable key material") because the scheduler runs hourly.
 *     Rendering the event log as an attention list shows the same fault eight
 *     times, so `GET /vpn/selftest` is the authoritative item and its own log
 *     lines are filtered out of the event tier.
 *  2. A VERDICT DOES NOT SURVIVE A RESTART. `VpnSelfTestService.last` is an
 *     in-memory field, so a freshly launched app answers `/vpn/selftest` with
 *     `last: null` and genuinely knows nothing — while the stored profiles are
 *     exactly as broken as they were at shutdown. The only persisted trace of
 *     the previous verdict is its own log line, so when there is no live result
 *     that line becomes the evidence, labelled as a RECORD rather than passed
 *     off as current.
 *  3. ONLY BREAKAGE IS ATTENTION. `unavailable` means "the app works, tunnels
 *     cannot" — a machine with no VPN profile has not got a fault, it has not
 *     used the feature, and nagging about it is how an attention strip teaches
 *     people to ignore attention strips. `error` is the backend's own word for
 *     "something is broken".
 *  4. A DISMISSAL IS BOUND TO THE DIAGNOSIS, NOT TO THE APP. Each id is derived
 *     from the diagnosis itself, so a worse new fault ("7 of 7" after "6 of 7")
 *     resurfaces while the one the user dismissed stays gone.
 *  5. THE DETAIL STRING IS NEVER REWRITTEN. The backend wrote a precise
 *     sentence, including its own remedy; paraphrasing it here is the only way
 *     this strip could say something the app does not actually know.
 */

import type { VpnSelfTestResult } from '@shared/models/settings';
import type { EventRecord } from '@shared/models/common';
import type { VpnSurfaceId } from '@/features/vpn/engineMeta';

export type AttentionTone = 'danger' | 'warn';

/**
 * What one click does. `route` navigates to the surface that fixes the fault;
 * `rerun` re-asks the backend the only question that can retire a stale verdict.
 */
export type AttentionAction =
  | { kind: 'route'; label: string; to: string; /** VPN tab to open, when the target is the VPN page. */
      surface?: VpnSurfaceId; providerId?: string }
  | { kind: 'rerun'; label: string };

export interface AttentionItem {
  /** Dismissal identity. Any change in the diagnosis yields a new id. */
  id: string;
  tone: AttentionTone;
  /** Which subsystem produced this — decides the label, never the detail. */
  source: 'vpn-selftest' | 'vpn-selftest-recorded' | 'event';
  /** The backend's own sentence, verbatim. */
  detail: string;
  /** When the backend established this. */
  ts: number;
  action: AttentionAction;
  /**
   * Whether re-running the VPN dry-run says something about THIS fault. True
   * only for the self-test's own diagnosis: re-running it cannot tell you
   * whether a dropped TCP probe or an unclean shutdown is still true, so those
   * items never offer a check they cannot honour.
   */
  canRecheck: boolean;
  /** How many times the log recorded the same fault (event items only). */
  repeats?: number;
}

export interface AttentionInput {
  selftest: VpnSelfTestResult | null;
  events: readonly EventRecord[];
  /** providerId of every stored profile, from `GET /vpn/profiles`. */
  profileProviders: readonly string[];
  /** Injected so the recency window is testable rather than ambient. */
  now: number;
  /** Log items shown after the structured one. */
  maxEventItems?: number;
}

/**
 * Problems are only "needing attention" while they are recent. The event log is
 * append-only, so without a window this strip becomes a museum of last month's
 * warnings. The self-test items are exempt: a live verdict is the CURRENT
 * standing assessment, and a recorded one is exempt precisely because its age
 * is the reason it is being offered for a re-check rather than acted upon.
 */
export const EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_MAX_EVENT_ITEMS = 2;

/** Provider ids the self-test inspects (it skips `custom`, which has no surface). */
const IMPORT_SURFACE: Record<string, VpnSurfaceId> = {
  wireguard: 'wireguard',
  openvpn: 'openvpn',
  singbox: 'sing-box',
  aether: 'aether',
};

const PROVIDER_LABEL: Record<string, string> = {
  wireguard: 'WireGuard',
  openvpn: 'OpenVPN',
  singbox: 'sing-box',
  aether: 'Aether',
};

/**
 * The VPN tab that owns the fix, when the stored profiles make that
 * unambiguous. With profiles spread over several engines no single tab can be
 * called "the" fix, so the caller gets null and the item routes to the VPN
 * overview instead of guessing.
 */
export function resolveImportTarget(
  profileProviders: readonly string[],
): { surface: VpnSurfaceId; providerId: string } | null {
  const ids = [...new Set(profileProviders.filter((id) => id !== 'custom' && IMPORT_SURFACE[id] != null))];
  if (ids.length !== 1) return null;
  const providerId = ids[0]!;
  return { surface: IMPORT_SURFACE[providerId]!, providerId };
}

/**
 * The self-test's own log lines. The service records an event for every run
 * (`vpnSelfTestService.ts`) and the scheduler records a second line for the same
 * run; both are echoes of the same verdict.
 */
function isSelfTestEcho(message: string): boolean {
  return /^(Scheduled )?VPN self-test\b/.test(message);
}

/** `(scheduled)` / `(manual)` is scheduler bookkeeping, not part of the finding. */
function stripTrigger(message: string): string {
  return message.replace(/\s*\((?:scheduled|manual)\)\s*$/, '').trim();
}

/**
 * The log line's own framing ("VPN self-test error: ") is dropped because the
 * row already names its source, so keeping it would print the same words twice.
 * What survives is the backend's finding, untouched.
 */
function stripLogFraming(message: string): string {
  return stripTrigger(message)
    .replace(/^(?:Scheduled )?VPN self-test\b[^:]*:\s*/, '')
    .trim();
}

/** Newest first, so "the last verdict" is well defined even though events are newest-first already. */
function newest<T>(items: readonly T[], by: (item: T) => number): T | undefined {
  return [...items].sort((a, b) => by(b) - by(a))[0];
}

function selftestItem(
  last: VpnSelfTestResult,
  profileProviders: readonly string[],
): AttentionItem | null {
  const target = resolveImportTarget(profileProviders);
  const hasProfiles = profileProviders.some((id) => id !== 'custom');

  if (last.state === 'error') {
    return {
      // Counts are in the detail, so "6 of 7" and "7 of 7" are different faults
      // and the second one is not silenced by dismissing the first.
      id: `selftest:error:${last.detail}`,
      tone: 'danger',
      source: 'vpn-selftest',
      detail: last.detail,
      ts: last.checkedAt,
      action: target
        ? {
            kind: 'route',
            label: `Open ${PROVIDER_LABEL[target.providerId]}`,
            to: '/vpn',
            surface: target.surface,
            providerId: target.providerId,
          }
        : { kind: 'route', label: 'Open VPN', to: '/vpn' },
      canRecheck: true,
    };
  }

  // `unavailable` has exactly two causes (no engine / no profiles) and the
  // no-engine branch is taken first, so stored profiles prove the missing thing
  // is the engine. With no stored profiles it is the "not set up yet" branch:
  // nothing is broken, so nothing is raised.
  if (last.state === 'unavailable' && hasProfiles) {
    return {
      id: `selftest:unavailable:${last.detail}`,
      tone: 'warn',
      source: 'vpn-selftest',
      detail: last.detail,
      ts: last.checkedAt,
      action: { kind: 'route', label: 'Install an engine', to: '/engines' },
      canRecheck: true,
    };
  }

  return null;
}

/**
 * The verdict this machine last wrote down, for the case where the live one is
 * gone. The service records `warn` for a fault and `info` for everything else,
 * so the event LEVEL — not the wording — says whether that last verdict was a
 * problem. If it was not, there is nothing to raise and the strip stays silent
 * rather than inventing a worry.
 */
function recordedVerdictItem(events: readonly EventRecord[]): AttentionItem | null {
  const lines = events.filter((e) => isSelfTestEcho(e.message));
  const last = newest(lines, (e) => e.ts);
  if (!last || last.level !== 'warn') return null;

  const detail = stripLogFraming(last.message);
  return {
    // Keyed on the recorded sentence so dismissing it sticks, but a DIFFERENT
    // recorded fault still surfaces. `recheck` is dropped from the id on
    // purpose: the same fault re-read after a restart must not re-announce.
    id: `selftest:recorded:${detail}`,
    tone: 'danger',
    source: 'vpn-selftest-recorded',
    detail,
    ts: last.ts,
    // The verdict is stale, so the only honest action is to get a fresh one.
    // The dry run never elevates, never spawns a tunnel and never changes state,
    // so asking again costs the user nothing but a second of waiting.
    action: { kind: 'rerun', label: 'Re-check now' },
    canRecheck: true,
  };
}

function eventItems(events: readonly EventRecord[], now: number, max: number): AttentionItem[] {
  // Newest per distinct fault: the log repeats the same sentence on every
  // scheduled run, and a strip that repeats itself is ignored.
  const newestPerFault = new Map<string, EventRecord>();
  for (const e of events) {
    if (e.level !== 'warn' && e.level !== 'error') continue;
    if (isSelfTestEcho(e.message)) continue;
    if (now - e.ts > EVENT_WINDOW_MS) continue;
    const key = `${e.category}|${e.message}`;
    if (!newestPerFault.has(key)) newestPerFault.set(key, e);
  }

  return [...newestPerFault.values()]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, max)
    .map((e) => {
      const repeats = events.filter((o) => o.category === e.category && o.message === e.message).length;
      return {
        // Event ids are unique, so a dismissed fault never comes back and every
        // NEW fault is announced even when its wording is identical.
        id: `event:${e.id}`,
        tone: e.level === 'error' ? 'danger' : 'warn',
        source: 'event' as const,
        detail: e.message,
        ts: e.ts,
        repeats: repeats > 1 ? repeats : undefined,
        action: { kind: 'route' as const, label: 'Open events', to: '/events' },
        canRecheck: false,
      };
    });
}

/** The strip's contents. Empty means: nothing needs attention. */
export function deriveAttentionItems(input: AttentionInput): AttentionItem[] {
  const { selftest, events, profileProviders, now } = input;
  const max = input.maxEventItems ?? DEFAULT_MAX_EVENT_ITEMS;

  const items: AttentionItem[] = [];
  if (selftest) {
    const item = selftestItem(selftest, profileProviders);
    if (item) items.push(item);
  } else {
    // No live verdict: the last one this machine wrote down is the only
    // evidence that exists, and it is offered as evidence, not as truth.
    const recorded = recordedVerdictItem(events);
    if (recorded) items.push(recorded);
  }
  items.push(...eventItems(events, now, max));
  return items;
}