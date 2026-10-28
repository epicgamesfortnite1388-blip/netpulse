import { Check, ChevronRight, Cpu, Globe2, Lock, Radar, Router, X } from 'lucide-react';

import type { AgentHop, AgentHopId } from './agentPath';

/**
 * The agent's live path.
 *
 * Six hops in the order the run actually performs them. Each hop owns a real
 * stage of the quick-connect stream (`agentPath.ts` maps them), so the beam
 * only advances when the server-side step has been observed — never on a timer.
 *
 * Motion is deliberately gated: `motion-safe:` prefixes mean a user with
 * `prefers-reduced-motion` gets the same states with no travelling packets.
 */

const HOP_ICON: Record<AgentHopId, typeof Globe2> = {
  request: Radar,
  policy: Cpu,
  core: Router,
  dns: Globe2,
  trace: Lock,
  egress: Check,
};

const STATE_CHIP: Record<AgentHop['state'], string> = {
  pending: 'border-white/8 bg-white/[0.02] text-faint',
  active: 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100 shadow-[0_0_18px_rgba(34,211,238,0.18)]',
  ok: 'border-emerald-400/35 bg-emerald-400/10 text-emerald-100',
  failed: 'border-red-400/40 bg-red-400/10 text-red-100',
};

const STATE_RAIL: Record<AgentHop['state'], string> = {
  pending: 'bg-white/8',
  active: 'bg-gradient-to-r from-cyan-300/70 to-cyan-300/20',
  ok: 'bg-emerald-400/45',
  failed: 'bg-red-400/40',
};

function StateGlyph({ state, id }: { state: AgentHop['state']; id: AgentHopId }) {
  if (state === 'ok') return <Check size={11} />;
  if (state === 'failed') return <X size={11} />;
  const Icon = HOP_ICON[id];
  return <Icon size={11} className={state === 'active' ? 'motion-safe:animate-pulse' : ''} />;
}

export function AgentPathTrace({ hops, busy }: { hops: readonly AgentHop[]; busy: boolean }) {
  const current = hops.find((hop) => hop.state === 'active') ?? null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-micro font-semibold uppercase tracking-[0.18em] text-faint">Agent path</p>
        <p className="truncate font-mono text-micro text-cyan-200/80" aria-live="polite">
          {current ? `${current.label} · ${current.detail}` : busy ? 'planning' : 'idle'}
        </p>
      </div>

      <ol className="flex items-stretch gap-1 overflow-x-auto pb-1" aria-label="Connection path">
        {hops.map((hop, index) => {
          const next = hops[index + 1];
          const active = hop.state === 'active';
          return (
            <li key={hop.id} className="flex min-w-0 flex-1 items-stretch gap-1">
              <div
                title={`${hop.label}: ${hop.detail}`}
                data-state={hop.state}
                className={`group relative flex min-w-[74px] flex-1 flex-col gap-1 rounded-lg border px-2 py-1.5 transition-colors duration-300 ${STATE_CHIP[hop.state]}`}
              >
                {active && (
                  <span className="pointer-events-none absolute inset-x-1 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200 to-transparent motion-safe:animate-pulse motion-reduce:animate-none" />
                )}
                <span className="flex items-center gap-1.5">
                  <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-white/10 bg-black/25">
                    <StateGlyph state={hop.state} id={hop.id} />
                  </span>
                  <span className="truncate text-micro font-semibold uppercase tracking-[0.1em]">{hop.label}</span>
                  {hop.id === 'dns' && active && (
                    <span className="relative ml-auto grid h-2 w-2 shrink-0 place-items-center">
                      <span className="absolute h-2 w-2 rounded-full bg-cyan-300/60 motion-safe:animate-ping motion-reduce:animate-none" />
                      <span className="h-1 w-1 rounded-full bg-cyan-200" />
                    </span>
                  )}
                </span>
                <span className="truncate font-mono text-micro leading-tight opacity-80">{hop.detail}</span>
              </div>
              {next && (
                <span aria-hidden className="relative flex w-3 shrink-0 items-center justify-center">
                  <span className={`h-px w-full ${STATE_RAIL[hop.state]}`} />
                  {hop.state === 'ok' && next.state === 'pending' && (
                    <span className="absolute h-1 w-1 rounded-full bg-emerald-300/70" />
                  )}
                  {hop.state === 'active' && (
                    <span className="absolute h-1.5 w-1.5 rounded-full bg-cyan-200 shadow-[0_0_8px_rgba(34,211,238,0.9)] motion-safe:animate-pulse motion-reduce:animate-none" />
                  )}
                  <ChevronRight size={9} className="absolute -right-1 text-white/15" />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
