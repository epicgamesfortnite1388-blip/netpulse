/**
 * Failure intelligence: turn raw probe errors into cautious, useful diagnoses.
 *
 * Rules:
 *   - Labels are always qualified: "Likely", "Possible", "No evidence", or
 *     "Unable to determine" — we never claim certainty without evidence.
 *   - Patterns are ordered most-specific first; first match wins.
 *   - The raw error stays available (detail) — this mapper only ADDS context.
 */

export interface FailureDiagnosis {
  /** Short category, e.g. "DNS failure", "TLS handshake failure". */
  category: string;
  /** Cautious qualifier. */
  confidence: 'likely' | 'possible' | 'no-evidence' | 'undetermined';
  /** One-sentence human explanation (already includes the qualifier). */
  summary: string;
  /** Suggested next step, when there is one. */
  action?: string;
}

interface Pattern {
  re: RegExp;
  category: string;
  confidence: FailureDiagnosis['confidence'];
  summary: (m: string) => string;
  action?: (m: string) => string;
}

const PATTERNS: Pattern[] = [
  {
    re: /no proxy core installed|engine_unavailable|sing-box is not installed|no installed core supports/i,
    category: 'Engine unavailable',
    confidence: 'likely',
    summary: () => 'Likely cause: no proxy core (xray/sing-box) is installed, so the proxy could not be tested locally.',
    action: () => 'Install xray or sing-box into the app cores folder to enable proxy testing.',
  },
  {
    re: /core exited during startup|engine_start_failed|core did not become ready|core spawn failed/i,
    category: 'Engine startup failure',
    confidence: 'likely',
    summary: () => 'Likely cause: the proxy core rejected the node\'s configuration or failed to start (engine-side error).',
    action: () => 'The config may be unsupported by this core version or contain invalid parameters.',
  },
  {
    re: /ENOTFOUND|dns_resolution_failed|getaddrinfo|resolve.*timed out/i,
    category: 'DNS failure',
    confidence: 'likely',
    summary: () => 'Likely cause: the node\'s hostname did not resolve (DNS failure) — the server may be offline or its domain expired.',
    action: () => 'Check your DNS settings, then retry; if it persists the server\'s domain is likely dead.',
  },
  {
    re: /ECONNREFUSED/i,
    category: 'Port closed',
    confidence: 'likely',
    summary: () => 'Likely cause: the server actively refused the connection — the service on that port is down.',
  },
  {
    re: /ETIMEDOUT|timed out|timeout/i,
    category: 'Timeout',
    confidence: 'possible',
    summary: () => 'Possible cause: the server is unreachable (blocked, offline, or heavily degraded) — the connection attempt timed out.',
    action: () => 'Retest later; persistent timeouts usually mean the server is blocked or dead.',
  },
  {
    re: /certificate|SSL|TLS|handshake_failed|self-signed|EPROTO/i,
    category: 'TLS failure',
    confidence: 'possible',
    summary: () => 'Possible cause: the TLS handshake failed — certificate, SNI, or security-layer mismatch with this node.',
    action: () => 'If the node uses TLS/Reality, verify its SNI and fingerprint settings.',
  },
  {
    re: /401|403|407|auth|unauthorized|forbidden/i,
    category: 'Authentication failure',
    confidence: 'likely',
    summary: () => 'Likely cause: authentication failed — the node\'s credentials (UUID/password) are wrong, rotated, or expired.',
  },
  {
    re: /private_node_host|loopback|metadata|private IPv4|private IPv6/i,
    category: 'Blocked target',
    confidence: 'likely',
    summary: () => 'Likely cause: the target resolved to a private/loopback address and was blocked by the safety guard.',
  },
  {
    re: /ENETUNREACH|EHOSTUNREACH|network.*(down|unreachable)|offline/i,
    category: 'Local network failure',
    confidence: 'possible',
    summary: () => 'Possible cause: your local network cannot reach the Internet right now (adapter, route, or DNS problem).',
    action: () => 'Check your Internet connection and retry.',
  },
  {
    re: /port_not_allowed|cidr_too_large|not on the endpoint allowlist/i,
    category: 'Blocked by policy',
    confidence: 'likely',
    summary: () => 'Likely cause: the request was blocked by the app\'s safety policy (allowlist), not by the network.',
  },
];

/**
 * Diagnose a raw error string. Returns null for empty input; an
 * "unable to determine" diagnosis when nothing matches.
 */
export function diagnoseFailure(raw: string | null | undefined): FailureDiagnosis | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  for (const p of PATTERNS) {
    if (p.re.test(text)) {
      return {
        category: p.category,
        confidence: p.confidence,
        summary: p.summary(text),
        action: p.action?.(text),
      };
    }
  }
  return {
    category: 'Unknown error',
    confidence: 'undetermined',
    summary: 'Unable to determine the cause from the error message.',
  };
}
