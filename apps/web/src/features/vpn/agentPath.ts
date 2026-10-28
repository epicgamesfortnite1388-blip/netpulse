/**
 * The adaptive agent's hop map, derived from the real quick-connect stream.
 *
 * The activity panel renders a *path* (request → policy → core → DNS → tunneled
 * trace → egress) because that is what the run actually is: an ordered sequence
 * of measured steps. Deriving it from published events — rather than from a
 * timer or a guess — is what keeps the visual honest: a hop may only light up
 * when the server-side step that owns it has been observed.
 *
 * Two deliberate distinctions this module owns:
 *
 * - `dns-policy-active` means the core was *started with* the configured DNS
 *   policy. It is not a resolver response and it must not turn the DNS hop
 *   green on its own. Only `dns-response` — a hostname actually resolved inside
 *   a tunneled HTTPS request — completes the hop, and even then the resolver is
 *   not independently identified (see the panel's footnote).
 * - A new attempt resets the attempt-scoped hops. An earlier failure is history,
 *   not the current state, so the path always describes the attempt in flight.
 */

export type AgentHopId = 'request' | 'policy' | 'core' | 'dns' | 'trace' | 'egress';

export type AgentHopState = 'pending' | 'active' | 'ok' | 'failed';

export interface AgentHop {
  id: AgentHopId;
  label: string;
  state: AgentHopState;
  /** What was actually observed for this hop — never a promise of what's next. */
  detail: string;
}

/** The subset of an activity frame the hop map reads. Kept structural on purpose. */
export interface AgentPathEvent {
  stage?: string;
  message?: string;
  engine?: string;
  node?: string;
  depth?: string;
  latencyMs?: number;
  exitIp?: string | null;
  dnsPolicy?: string;
  ok?: boolean;
}

const FAILED_STAGES = new Set(['core-failed', 'verification-failed']);

function isFailure(event: AgentPathEvent): boolean {
  return event.stage != null && FAILED_STAGES.has(event.stage);
}

/**
 * The events that describe the attempt currently in flight.
 *
 * `attempt-start` is emitted immediately before a core is dialed for one
 * candidate, so everything from the last one onward is the live attempt.
 * Before the first attempt (planning, memory recheck) the whole stream is the
 * attempt, which is what the planning hops need.
 */
export function currentAttempt(events: readonly AgentPathEvent[]): AgentPathEvent[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.stage === 'attempt-start') return events.slice(i);
  }
  return [...events];
}

function lastOf(events: readonly AgentPathEvent[], stages: readonly string[]): AgentPathEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const stage = events[i]?.stage;
    if (stage != null && stages.includes(stage)) return events[i] ?? null;
  }
  return null;
}

function firstOf(events: readonly AgentPathEvent[], stages: readonly string[]): AgentPathEvent | null {
  for (const event of events) {
    if (event.stage != null && stages.includes(event.stage)) return event;
  }
  return null;
}

/**
 * Build the six hops for `events`.
 *
 * `busy` is only used to decide between `active` and `pending` when nothing has
 * been observed yet: a finished, silent run must not keep pulsing.
 */
export function deriveAgentPath(events: readonly AgentPathEvent[], busy: boolean): AgentHop[] {
  // Planning stages (handoff, policy, candidate probes) happen once per run,
  // before any attempt, and never repeat inside one — so they are read from the
  // whole stream. Only the attempt-scoped hops reset per attempt.
  const attempt = currentAttempt(events);

  const handoff = lastOf(events, ['handoff']);
  const plan = lastOf(events, ['adaptive-plan']);
  const choice = lastOf(events, ['adaptive-choice']);
  const started = firstOf(attempt, ['attempt-start']);
  const coreStart = lastOf(attempt, ['core-start']);
  const coreReady = lastOf(attempt, ['core-ready']);
  const dnsPolicy = lastOf(attempt, ['dns-policy-active']);
  const relay = lastOf(attempt, ['relay-check']);
  const dnsResponse = lastOf(attempt, ['dns-response']);
  const route = lastOf(attempt, ['route-active', 'connected']);
  const failure = lastOf(attempt, ['core-failed', 'verification-failed']);
  const done = lastOf(events, ['complete']);

  const coreFailed = attempt.some((e) => e.stage === 'core-failed');
  const verifyFailed = attempt.some((e) => e.stage === 'verification-failed');

  // Any attempt-scoped stage proves the request was accepted, even on a stream
  // that starts mid-run (a resubscribe after the socket dropped).
  const accepted = Boolean(handoff ?? plan ?? started ?? coreStart ?? coreReady ?? dnsPolicy ?? relay);

  const request: AgentHop = {
    id: 'request',
    label: 'Request',
    state: accepted ? 'ok' : busy ? 'active' : 'pending',
    detail: handoff?.message ?? (accepted ? 'Quick connect accepted' : busy ? 'Preparing the run' : 'Not started'),
  };

  const policy: AgentHop = {
    id: 'policy',
    label: 'Policy',
    // A core was already dialed, so a strategy was chosen whether or not its
    // planning frame survived on this socket.
    state: Boolean(plan) || accepted ? 'ok' : busy ? 'active' : 'pending',
    detail: choice?.engine
      ? `${choice.engine} chosen`
      : plan
        ? (plan.message ?? 'Baseline core order')
        : accepted
          ? 'Baseline order in use'
          : busy
            ? 'Reading approved strategies'
            : 'No policy observed',
  };

  const core: AgentHop = {
    id: 'core',
    label: 'Core',
    state: coreFailed ? 'failed' : coreReady ? 'ok' : coreStart ? 'active' : started ? 'active' : 'pending',
    detail: coreReady
      ? (coreReady.engine ? `${coreReady.engine} accepting local traffic` : 'Core ready')
      : coreStart?.engine
        ? `Starting ${coreStart.engine}`
        : failure?.stage === 'core-failed'
          ? (failure.message ?? 'Core could not start')
          : started
            ? 'Dialing the candidate'
            : 'Not started',
  };

  // DNS is the hop most likely to be misreported, so its states are ordered and
  // narrow: policy armed (active) is NOT resolution. Only dns-response is ok.
  const dns: AgentHop = {
    id: 'dns',
    label: 'DNS',
    state: dnsResponse
      ? 'ok'
      : dnsPolicy
        ? verifyFailed
          ? 'failed'
          : 'active'
        : 'pending',
    detail: dnsResponse
      ? 'Hostname resolved inside the tunneled request'
      : dnsPolicy
        ? dnsPolicy.dnsPolicy === 'tunnel-configured'
          ? 'Core configured with DoH policy; response not yet observed'
          : 'DNS-through-tunnel disabled for this core'
        : 'Not reached',
  };

  const trace: AgentHop = {
    id: 'trace',
    label: 'TLS trace',
    state: verifyFailed ? 'failed' : dnsResponse ? 'ok' : relay ? 'active' : 'pending',
    detail: dnsResponse
      ? 'HTTPS through the tunnel returned a valid address'
      : relay
        ? 'Requesting HTTPS through the entry core'
        : verifyFailed
          ? (failure?.message ?? 'Verification failed')
          : 'Not reached',
  };

  const egress: AgentHop = {
    id: 'egress',
    label: 'Egress',
    state: route ? 'ok' : verifyFailed ? 'pending' : dnsResponse ? 'active' : 'pending',
    detail: route?.exitIp
      ? `Exit ${route.exitIp}`
      : done?.exitIp
        ? `Exit ${done.exitIp}`
        : dnsResponse
          ? 'Waiting for the next verified attempt'
          : 'Not observed',
  };

  return [request, policy, core, dns, trace, egress];
}

/** The hop the agent is working on right now, if any. */
export function activeHop(hops: readonly AgentHop[]): AgentHop | null {
  return hops.find((hop) => hop.state === 'active') ?? null;
}
