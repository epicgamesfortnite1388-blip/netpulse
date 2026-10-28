import { Activity, Check, Circle, Loader2, Radio, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { subscribeTest } from '@/lib/ws';

import { AgentPathTrace } from './AgentPathTrace';
import { deriveAgentPath } from './agentPath';

interface ActivityEvent {
  type: string;
  stage?: string;
  message?: string;
  at?: number;
  engine?: string;
  node?: string;
  profile?: string;
  depth?: string;
  done?: number;
  total?: number;
  latencyMs?: number;
  exitIp?: string | null;
  dnsPolicy?: string;
  error?: string | null;
  ok?: boolean;
}

const STAGE_META: Record<string, { label: string; tone: string }> = {
  accepted: { label: 'REQUEST', tone: 'text-muted' },
  preparing: { label: 'INIT', tone: 'text-muted' },
  handoff: { label: 'HANDOFF', tone: 'text-warn' },
  'memory-check': { label: 'MEMORY', tone: 'text-cyan-300' },
  'adaptive-plan': { label: 'POLICY', tone: 'text-violet-300' },
  'adaptive-choice': { label: 'DECISION', tone: 'text-violet-300' },
  'discovery-start': { label: 'SCAN', tone: 'text-cyan-300' },
  'candidate-probe': { label: 'PROBE', tone: 'text-cyan-300' },
  'attempt-start': { label: 'ATTEMPT', tone: 'text-sky-300' },
  'core-start': { label: 'CORE', tone: 'text-sky-300' },
  'core-ready': { label: 'CORE READY', tone: 'text-sky-300' },
  'core-failed': { label: 'CORE FAILED', tone: 'text-red-300' },
  'dns-policy-active': { label: 'DNS POLICY', tone: 'text-cyan-300' },
  'relay-check': { label: 'TUNNEL TEST', tone: 'text-amber-300' },
  'dns-response': { label: 'DNS RESPONSE', tone: 'text-cyan-300' },
  'verification-failed': { label: 'VERIFY FAILED', tone: 'text-red-300' },
  'attempt-failed': { label: 'RETRY', tone: 'text-amber-300' },
  connected: { label: 'VERIFIED', tone: 'text-emerald-300' },
  'route-active': { label: 'ROUTE ACTIVE', tone: 'text-emerald-300' },
  complete: { label: 'COMPLETE', tone: 'text-emerald-300' },
};

function IconForStage({ stage }: { stage: string }) {
  if (stage === 'complete' || stage === 'connected' || stage === 'route-active' || stage === 'core-ready') return <Check size={12} />;
  if (stage.includes('failed') || stage === 'attempt-failed') return <X size={12} />;
  if (stage === 'relay-check' || stage === 'candidate-probe' || stage === 'core-start' || stage === 'dns-policy-active') return <Loader2 size={12} className="animate-spin" />;
  return <Circle size={9} />;
}

export function QuickConnectActivity({ activityId, busy }: { activityId: string | null; busy: boolean }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setEvents([]);
    setConnected(false);
    if (!activityId) return;
    return subscribeTest(`quick-connect:${activityId}`, (msg) => {
      const event = msg as ActivityEvent;
      if (event.type !== 'quick-connect:activity' || !event.stage) return;
      setEvents((previous) => {
        const next = [...previous, event];
        return next.slice(-48);
      });
      if (event.stage === 'complete' || event.stage === 'connected') setConnected(Boolean(event.ok ?? event.stage === 'connected'));
    });
  }, [activityId]);

  const latestProbe = useMemo(() => [...events].reverse().find((event) => event.stage === 'candidate-probe'), [events]);
  const active = busy && !events.some((event) => event.stage === 'complete');
  const hops = useMemo(() => deriveAgentPath(events, active), [events, active]);
  if (!activityId && events.length === 0) return null;

  const latest = events[events.length - 1];
  const title = active ? 'Adaptive agent is working' : connected ? 'Route verified' : events.length ? 'Agent run finished' : 'Connecting to agent stream…';

  return (
    <section aria-live="polite" aria-label="Adaptive connection activity" className="relative overflow-hidden rounded-xl border border-cyan-400/20 bg-[#07121b] shadow-[0_0_34px_rgba(34,211,238,0.07)]">
      {active && <div className="pointer-events-none absolute inset-x-0 top-0 h-px animate-[pulse_1.8s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-cyan-300/80 to-transparent" />}
      <div className="flex items-center justify-between gap-3 border-b border-white/5 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-cyan-300/20 bg-cyan-300/10 text-cyan-200 ${active ? 'animate-pulse' : ''}`}>
            <Activity size={17} />
            {active && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-emerald-400 ring-2 ring-[#07121b]" />}
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-text">{title}</h3>
            <p className="truncate text-xs text-faint">{latest?.message ?? 'Waiting for server-side progress events'}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-micro font-medium uppercase tracking-[0.16em] text-cyan-200/80">
          <Radio size={12} className={active ? 'animate-pulse' : ''} />{active ? 'Live' : 'Trace'}
        </div>
      </div>

      <div className="border-b border-white/5 px-3 pt-3">
        <AgentPathTrace hops={hops} busy={active} />
      </div>

      <div className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_160px]">
        <div className="relative max-h-56 space-y-0.5 overflow-y-auto pr-1">
          <div className="absolute bottom-3 left-[5px] top-3 w-px bg-gradient-to-b from-cyan-300/50 via-violet-300/20 to-transparent" />
          {events.map((event, index) => {
            const meta = STAGE_META[event.stage ?? ''] ?? { label: event.stage?.toUpperCase() ?? 'EVENT', tone: 'text-muted' };
            const failed = event.stage?.includes('failed') || event.stage === 'attempt-failed';
            const done = event.stage === 'complete' || event.stage === 'connected' || event.stage === 'route-active' || event.stage === 'core-ready';
            return (
              <div key={`${event.at ?? index}-${index}`} className="relative flex animate-[fade-up_220ms_ease-out_both] gap-2.5 py-1.5" style={{ animationDelay: `${Math.min(index * 22, 180)}ms` }}>
                <span className={`relative z-[1] mt-0.5 grid h-3 w-3 shrink-0 place-items-center rounded-full ${failed ? 'bg-red-400/20 text-red-300' : done ? 'bg-emerald-400/15 text-emerald-300' : 'bg-[#07121b] text-cyan-200'}`}><IconForStage stage={event.stage ?? ''} /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className={`font-mono text-micro font-semibold tracking-[0.14em] ${meta.tone}`}>{meta.label}</span>
                    {event.engine && <span className="font-mono text-micro text-violet-200/80">{event.engine}</span>}
                    {event.node && <span className="truncate text-micro text-faint">{event.node}</span>}
                    {event.at && <time className="ml-auto font-mono text-micro text-faint/70">{new Date(event.at).toLocaleTimeString()}</time>}
                  </span>
                  <p className={`break-words text-xs leading-relaxed ${failed ? 'text-red-200/90' : 'text-muted'}`}>{event.message}</p>
                  {event.error && <p className="break-words font-mono text-micro text-red-200/70">{event.error}</p>}
                </span>
              </div>
            );
          })}
          {active && <div className="relative flex items-center gap-2.5 py-1.5 text-micro text-faint"><span className="relative z-[1] h-2.5 w-2.5 rounded-full border border-cyan-300/40 bg-[#07121b]" /><Loader2 size={11} className="animate-spin text-cyan-200/70" /> awaiting next measured milestone</div>}
          {!events.length && <p className="py-5 text-center text-xs text-faint">Connecting to the secure activity stream…</p>}
        </div>

        <aside className="flex flex-col justify-between gap-3 rounded-lg border border-white/5 bg-black/20 p-3">
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-micro font-semibold uppercase tracking-[0.16em] text-faint"><ShieldCheck size={11} className="text-cyan-200" /> Route telemetry</p>
            <div className="space-y-2">
              {[
                ['Discovery', latestProbe ? `${latestProbe.done ?? 0}/${latestProbe.total ?? 0} checked` : 'pending'],
                ['Probe depth', latestProbe?.depth ?? 'pending'],
                ['Measured probe', latestProbe?.latencyMs != null ? `${Math.round(latestProbe.latencyMs)} ms` : 'not measured'],
                ['DNS policy', latest?.dnsPolicy === 'tunnel-configured' ? 'core configured' : latest?.dnsPolicy === 'core-default' ? 'core default' : 'pending'],
                ['Verified egress', latest?.exitIp ?? 'not yet observed'],
              ].map(([label, value]) => <div key={label} className="flex items-baseline justify-between gap-2 text-micro"><span className="text-faint">{label}</span><span className="max-w-[92px] truncate text-right font-mono text-muted" title={value}>{value}</span></div>)}
            </div>
          </div>
          <p className="border-t border-white/5 pt-2 text-micro leading-relaxed text-faint">A green DNS event means the trace hostname resolved during a real tunneled HTTPS request. It does not independently identify the resolver.</p>
        </aside>
      </div>
    </section>
  );
}
