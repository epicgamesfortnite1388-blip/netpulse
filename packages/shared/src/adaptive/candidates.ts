/**
 * Research candidates — the schema a new connectivity idea must satisfy before
 * anyone is allowed to act on it.
 *
 * This is the boundary the research side of the mission must respect: an idea can
 * be proposed freely, but it cannot become a strategy the app uses because a
 * model or a website suggested it. A candidate carries where it came from, what
 * licence governs it, what it would cost, how it would be tested, and what the
 * test concluded — and only an `accepted` candidate with evidence may be turned
 * into a strategy by a human-authored change.
 *
 * The rules enforced here are all refusals, deliberately:
 *
 *  - **Provenance**: a candidate must name a source kind and a URL/reference. An
 *    idea with no source is `proposed` at best and cannot reach `testing`.
 *  - **Licence**: a technique that carries no licence statement cannot be
 *    recommended, because shipping it would be a legal decision made by accident.
 *  - **No live credentials, ever**: subscription links, uuids, passwords, keys
 *    and bare host:port endpoints are detected and rejected. A candidate may
 *    describe a protocol; it may not carry somebody's access to a server.
 *  - **Authorization**: a candidate that names a third-party hostname to be used
 *    as a relay/SNI target must carry an explicit `authorization` note.
 *  - **No auto-execution**: nothing in the app turns a candidate into a running
 *    configuration. `accepted` is a statement about evidence, and the promotion
 *    to a strategy is a code change with its own review.
 */

export const ADAPTIVE_CANDIDATE_VERSION = 1;

/** Where an idea came from — a closed list, because "the internet" is not a source. */
export type CandidateSourceKind =
  | 'protocol-repository'
  | 'specification'
  | 'research-paper'
  | 'vendor-documentation'
  | 'measurement-dataset'
  | 'internal-measurement'
  | 'design-consultation';

export type CandidateStatus = 'proposed' | 'testing' | 'accepted' | 'rejected' | 'deferred';

export type CandidateRisk = 'low' | 'medium' | 'high';

export interface CandidateEvidence {
  /** what was run, in enough detail to repeat it */
  method: string;
  /** measured outcome, stated as a number or a boolean with its conditions */
  result: string;
  /** authorised environment this ran in (lab, owned server, own network) */
  environment: string;
  at: number;
  /** where the raw output lives, when it exists */
  artifact?: string | null;
}

export interface AdaptiveCandidate {
  id: string;
  version: number;
  title: string;
  /** one sentence: the failure it addresses */
  problem: string;
  summary: string;
  source: {
    kind: CandidateSourceKind;
    /** repository URL, spec section, paper DOI — never a paste service */
    reference: string;
    /** publisher/site, for reading */
    publisher: string;
    /** retrieved date (epoch ms) — a source that moved still has a date */
    retrievedAt: number;
  };
  /** SPDX-ish licence statement, or an explicit "unknown — do not ship" */
  license: string;
  /** what has to exist on the client/server for this to work at all */
  compatibility: {
    clientCores: string[];
    protocols: string[];
    platforms: string[];
    notes?: string;
  };
  security: {
    risk: CandidateRisk;
    /** what could go wrong, written before it is tested */
    concerns: string[];
    /** who authorises the use of any third-party endpoint this needs */
    authorization?: string | null;
  };
  /** what the mission expects to gain, and how it would be measured */
  expectedBenefit: {
    claim: string;
    metric: string;
    baseline: string;
  };
  testPlan: string[];
  status: CandidateStatus;
  evidence: CandidateEvidence[];
  /** why it was accepted, rejected or deferred — required for a terminal state */
  conclusion: string | null;
  proposedAt: number;
  updatedAt: number;
}

export type CandidateRefusal =
  | 'not-an-object'
  | 'missing-id'
  | 'missing-source'
  | 'unsafe-source'
  | 'missing-license'
  | 'missing-problem'
  | 'missing-test-plan'
  | 'credential-material'
  | 'unauthorized-endpoint'
  | 'terminal-without-evidence'
  | 'terminal-without-conclusion'
  | 'invalid-status'
  | 'invalid-risk'
  | 'too-many-evidence';

export interface CandidateValidation {
  ok: boolean;
  refusals: Array<{ code: CandidateRefusal; detail: string }>;
  /** non-blocking notes worth reading */
  warnings: string[];
}

const SOURCE_KINDS: readonly CandidateSourceKind[] = [
  'protocol-repository',
  'specification',
  'research-paper',
  'vendor-documentation',
  'measurement-dataset',
  'internal-measurement',
  'design-consultation',
];

const STATUSES: readonly CandidateStatus[] = ['proposed', 'testing', 'accepted', 'rejected', 'deferred'];
const RISKS: readonly CandidateRisk[] = ['low', 'medium', 'high'];

/** Paste/link services and credential-bearing strings: never a research source. */
const UNSAFE_REFERENCE = /(pastebin|paste\.ee|ghostbin|rentry|hastebin|0x0\.st|transfer\.sh|file\.io|mega\.nz)/i;

/** A share link, a uuid, or a `user:pass@host` — material that must not travel inside a candidate. */
const SHARE_LINK = /\b(vless|vmess|trojan|ss|ssr|hysteria2?|hy2|tuic|wireguard):\/\/\S+/i;
const UUID_LIKE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const CREDENTIAL_PAIR = /\b[A-Za-z0-9_.\-]{3,}:[^\s@/]{6,}@[A-Za-z0-9.\-]+/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** Free text a candidate may carry, which must stay free of secrets. */
function textFields(candidate: Partial<AdaptiveCandidate>): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string') out.push(value);
  };
  push(candidate.title);
  push(candidate.problem);
  push(candidate.summary);
  push(candidate.conclusion ?? undefined);
  push(candidate.source?.reference);
  push(candidate.source?.publisher);
  push(candidate.license);
  push(candidate.security?.authorization ?? undefined);
  push(candidate.expectedBenefit?.claim);
  push(candidate.expectedBenefit?.metric);
  push(candidate.expectedBenefit?.baseline);
  for (const plan of candidate.testPlan ?? []) push(plan);
  for (const concern of candidate.security?.concerns ?? []) push(concern);
  for (const note of candidate.compatibility?.notes ? [candidate.compatibility.notes] : []) push(note);
  for (const e of candidate.evidence ?? []) {
    push(e.method);
    push(e.result);
    push(e.environment);
    push(e.artifact ?? undefined);
  }
  return out;
}

/**
 * Validate one candidate. Pure: no I/O, no clock, no network. A research agent
 * can call this on anything it produces and get told exactly what is missing.
 */
export function validateCandidate(candidate: unknown): CandidateValidation {
  const refusals: CandidateValidation['refusals'] = [];
  const warnings: string[] = [];
  const refuse = (code: CandidateRefusal, detail: string): void => {
    refusals.push({ code, detail });
  };

  if (candidate == null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, refusals: [{ code: 'not-an-object', detail: 'candidate must be an object' }], warnings };
  }
  const c = candidate as Partial<AdaptiveCandidate>;

  if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9.\-]{2,63}$/i.test(c.id)) {
    refuse('missing-id', 'candidate needs a stable id (letters, digits, dot or dash)');
  }
  if (typeof c.problem !== 'string' || c.problem.trim().length < 10) {
    refuse('missing-problem', 'candidate must name the observed failure it addresses');
  }
  if (c.source == null || typeof c.source !== 'object') {
    refuse('missing-source', 'candidate must name where it came from');
  } else {
    const kind = c.source.kind as CandidateSourceKind | undefined;
    if (!kind || !SOURCE_KINDS.includes(kind)) {
      refuse('missing-source', `source kind "${String(kind)}" is not one of ${SOURCE_KINDS.join(', ')}`);
    }
    const reference = c.source.reference;
    if (typeof reference !== 'string' || reference.trim().length === 0) {
      refuse('missing-source', 'candidate must carry a source reference (URL, spec section or DOI)');
    } else {
      if (UNSAFE_REFERENCE.test(reference)) {
        refuse('unsafe-source', `"${reference}" is a paste service — a source must be a maintained reference`);
      }
      if (!/^https?:\/\//i.test(reference) && !/^doi:|^RFC/i.test(reference) && kind !== 'internal-measurement' && kind !== 'design-consultation') {
        warnings.push(`source reference "${reference}" is not a URL, DOI or RFC — say clearly how it can be found again`);
      }
    }
    if (!Number.isFinite(c.source.retrievedAt) || (c.source.retrievedAt ?? 0) <= 0) {
      warnings.push('source has no retrievedAt date; a reference that moves needs a date it was read');
    }
  }

  if (typeof c.license !== 'string' || c.license.trim().length === 0) {
    refuse('missing-license', 'candidate must state the licence that governs the technique, or say "unknown" explicitly');
  } else if (/^unknown/i.test(c.license.trim())) {
    warnings.push('licence is unknown — this candidate cannot be recommended for shipping as-is');
  }

  if (!Array.isArray(c.testPlan) || c.testPlan.filter((s) => typeof s === 'string' && s.trim().length > 0).length < 2) {
    refuse('missing-test-plan', 'candidate needs a test plan with at least two concrete steps');
  }

  if (c.status != null && !STATUSES.includes(c.status)) {
    refuse('invalid-status', `status "${String(c.status)}" is not one of ${STATUSES.join(', ')}`);
  }
  if (c.security != null && c.security.risk != null && !RISKS.includes(c.security.risk)) {
    refuse('invalid-risk', `risk "${String(c.security.risk)}" is not low, medium or high`);
  }

  const evidence = Array.isArray(c.evidence) ? c.evidence : [];
  if (evidence.length > 20) refuse('too-many-evidence', 'store at most 20 evidence entries; archive the rest');

  const status = (c.status ?? 'proposed') as CandidateStatus;
  if (status === 'accepted' || status === 'rejected') {
    if (evidence.length === 0) {
      refuse('terminal-without-evidence', `"${status}" requires at least one recorded measurement`);
    }
    if (typeof c.conclusion !== 'string' || c.conclusion.trim().length < 10) {
      refuse('terminal-without-conclusion', `"${status}" requires a stated conclusion`);
    }
  }

  const texts = textFields(c);
  for (const text of texts) {
    if (SHARE_LINK.test(text) || UUID_LIKE.test(text) || CREDENTIAL_PAIR.test(text) || PRIVATE_KEY.test(text)) {
      refuse('credential-material', `a candidate field carries credential material: "${redact(text)}"`);
      break;
    }
  }

  // A candidate that names a third-party host to be used as a relay or SNI
  // target must say who authorised it. A hostname that resolves is not permission.
  const endpointMention = texts.some((t) => /\b(sni|relay|front|bridge)\b/i.test(t) && /\b[a-z0-9-]+(\.[a-z0-9-]+){1,}\b/i.test(t));
  if (endpointMention && !(typeof c.security?.authorization === 'string' && c.security.authorization.trim().length > 0)) {
    refuse(
      'unauthorized-endpoint',
      'this candidate mentions using a third-party hostname as an SNI/relay target without an authorization note',
    );
  }

  return { ok: refusals.length === 0, refusals, warnings };
}

/** Keep a refusal message readable without echoing a secret. */
function redact(text: string): string {
  return text.length > 60 ? `${text.slice(0, 24)}…[redacted]…` : `${text.slice(0, 12)}…[redacted]`;
}

/* --------------------------------- registry -------------------------------- */

export interface CandidateRegistry {
  version: number;
  updatedAt: number;
  candidates: AdaptiveCandidate[];
}

export interface RegistryValidation {
  ok: boolean;
  /** per-candidate verdicts, keyed by id (or "#index" when the id is missing) */
  results: Array<{ id: string; validation: CandidateValidation }>;
  summary: Record<CandidateStatus, number>;
  /** ids that are `accepted` — the only ones a human may promote into a strategy */
  promotable: string[];
}

/** Validate a whole registry, and count what state each candidate is in. */
export function validateRegistry(registry: unknown): RegistryValidation {
  const summary: Record<CandidateStatus, number> = { proposed: 0, testing: 0, accepted: 0, rejected: 0, deferred: 0 };
  const results: RegistryValidation['results'] = [];
  const promotable: string[] = [];

  const list = Array.isArray((registry as Partial<CandidateRegistry> | null)?.candidates)
    ? ((registry as CandidateRegistry).candidates as unknown[])
    : [];

  list.forEach((candidate, index) => {
    const id = typeof (candidate as Partial<AdaptiveCandidate>)?.id === 'string' ? String((candidate as AdaptiveCandidate).id) : `#${index}`;
    const validation = validateCandidate(candidate);
    results.push({ id, validation });
    const status = ((candidate as Partial<AdaptiveCandidate>)?.status ?? 'proposed') as CandidateStatus;
    if (STATUSES.includes(status)) summary[status] += 1;
    if (validation.ok && status === 'accepted') promotable.push(id);
  });

  return { ok: results.every((r) => r.validation.ok), results, summary, promotable };
}

/**
 * The only sanctioned way for a candidate to influence the app: an `accepted`,
 * valid candidate whose technique has been turned into a strategy by hand.
 * This function does not create that strategy — it refuses to, and says so.
 */
export function promotionRefusal(candidate: unknown): { promotable: true } | { promotable: false; reason: string } {
  const validation = validateCandidate(candidate);
  if (!validation.ok) {
    return { promotable: false, reason: `candidate is invalid: ${validation.refusals.map((r) => r.code).join(', ')}` };
  }
  const status = (candidate as AdaptiveCandidate).status;
  if (status !== 'accepted') {
    return { promotable: false, reason: `candidate status is "${status}" — only an accepted candidate may be considered for a strategy` };
  }
  if ((candidate as AdaptiveCandidate).evidence.length === 0) {
    return { promotable: false, reason: 'accepted candidate carries no recorded measurement' };
  }
  return { promotable: true };
}
