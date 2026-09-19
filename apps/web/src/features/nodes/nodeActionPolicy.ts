import type { HealthSample, NodeTestResult } from '@netpulse/shared';

/**
 * What a per-node action says to the user.
 *
 * Pure functions, no React and no fetching: every wording decision for the node
 * actions lives here so the explorer row, the node detail page and any future
 * caller cannot drift into three accounts of the same outcome. The rule these
 * encode is that a refusal is reported as the reason the server gave, never as a
 * generic failure — a node without a vaulted credential, an anycast IP and a
 * dead geolocation service must not read the same.
 */

export type ToastTone = 'ok' | 'warn' | 'error';

export interface ActionMessage {
  tone: ToastTone;
  title: string;
  body?: string;
}

/* --------------------------------- export --------------------------------- */

export const EXPORT_FORMATS = ['uri', 'plaintext', 'base64', 'json', 'clash', 'singbox'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * The export route answers with an envelope — `data` is the config text. Sending
 * the envelope itself to a file produced downloads containing `[object Object]`.
 */
export interface ExportEnvelope {
  format: ExportFormat;
  count: number;
  data: string;
}

/** One rule for the saved file's extension, whatever the caller's prefix is. */
export function exportFileName(prefix: string, format: ExportFormat, at = Date.now()): string {
  const ext = format === 'base64' ? 'b64' : format;
  return `${prefix}-${ext}-${at}.${ext === 'json' ? 'json' : 'txt'}`;
}

export function exportMessage(format: ExportFormat, scope: string): ActionMessage {
  return { tone: 'ok', title: 'Exported', body: `${format} — ${scope}` };
}

export function exportErrorMessage(error: unknown): ActionMessage {
  return { tone: 'error', title: 'Export failed', body: reasonOf(error) };
}

/* ------------------------------- share links ------------------------------ */

export interface ShareLinkResult {
  ok: boolean;
  link?: string;
  protocol?: string;
  reason?: string;
}

const LINK_PREVIEW_CHARS = 72;

/** The rebuilt link could not be produced: the server's reason is the answer. */
export function shareLinkRefusalMessage(res: ShareLinkResult): ActionMessage {
  return {
    tone: 'warn',
    title: 'No share link for this node',
    body: res.reason ?? 'The server did not return a usable link.',
  };
}

export function shareLinkCopiedMessage(res: ShareLinkResult): ActionMessage {
  const link = res.link ?? '';
  return {
    tone: 'ok',
    title: `${res.protocol ?? 'Share'} link copied`,
    body: `${link.slice(0, LINK_PREVIEW_CHARS)}${link.length > LINK_PREVIEW_CHARS ? '…' : ''}`,
  };
}

export function shareLinkClipboardFailureMessage(): ActionMessage {
  return {
    tone: 'error',
    title: 'Could not reach the clipboard',
    body: 'The link was built but the app could not copy it — use Export JSON instead.',
  };
}

export function shareLinkErrorMessage(error: unknown): ActionMessage {
  return { tone: 'error', title: 'Could not build the share link', body: reasonOf(error) };
}

/* -------------------------------- geo lookup ------------------------------- */

export interface GeoRecheckOutcome {
  outcome: string;
  reason: string;
}

/** One message per real outcome; "unknown" is never rendered as success. */
export function geoOutcomeMessage(result: GeoRecheckOutcome): ActionMessage {
  if (result.outcome === 'resolved' || result.outcome === 'vouched') {
    return {
      tone: 'ok',
      title: 'Location updated',
      body: result.outcome === 'vouched' ? 'User-attested coordinates applied.' : 'Fresh GeoIP lookup completed.',
    };
  }
  if (result.outcome === 'refused') {
    return {
      tone: 'warn',
      title: 'No location available',
      body:
        result.reason === 'anycast'
          ? 'This IP is anycast — GeoIP answers for it are artifacts, so it stays Unknown.'
          : 'This IP belongs to a global edge network — GeoIP would report a registry office, not a location.',
    };
  }
  if (result.outcome === 'busy') {
    return { tone: 'warn', title: 'Geo worker busy', body: 'A background lookup is running — this node is queued. Try again in a moment.' };
  }
  return {
    tone: 'error',
    title: 'Lookup failed',
    body:
      result.reason === 'private_only'
        ? 'Node has only private addresses — nothing to geolocate.'
        : 'The geolocation service did not answer. It retries in the background.',
  };
}

export function geoErrorMessage(error: unknown): ActionMessage {
  return { tone: 'error', title: 'Re-check failed', body: reasonOf(error) };
}

/* ----------------------------- tests & favorite ---------------------------- */

/**
 * What a finished node test says.
 *
 * The message must agree with the record the backend STORED, which is what the
 * POST returns (`status`, `latencyMs`, `error`) — not with the fact that the
 * request completed. A run recorded as `failed` measured the failed attempt's
 * duration (a DNS lookup that never resolved still takes 85 ms), so reporting it
 * as "complete · 85.0 ms" claims a measurement that was never stored and leaves
 * the row showing `—` next to a number the UI just announced.
 *
 * Non-`done` statuses therefore report failure with the record's own reason. If a
 * failed record carries no reason, say that plainly rather than leaving a blank
 * or inventing one.
 */
export function testMessage(result: Pick<NodeTestResult, 'type' | 'status' | 'latencyMs' | 'totalMs' | 'error'>): ActionMessage {
  const title = `Test ${result.type}`;

  if (result.status === 'failed' || result.status === 'error') {
    return {
      tone: result.status === 'error' ? 'error' : 'warn',
      title: `${title} failed`,
      body: result.error ?? 'The backend recorded this run as failed without a reason.',
    };
  }

  if (result.status === 'done') {
    // `latencyMs` is the connection/DNS time; proxy runs report `totalMs`
    // instead. Both are real measurements — never substitute one for the other
    // without saying which it is.
    const body =
      result.latencyMs != null
        ? `${result.latencyMs.toFixed(1)} ms`
        : result.totalMs != null
          ? `${result.totalMs.toFixed(1)} ms total`
          : 'No latency was recorded for this run';
    return { tone: 'ok', title: `${title} complete`, body };
  }

  // 'running' / 'cancelled': name the state instead of reporting a result the
  // record does not contain.
  return { tone: 'warn', title: `${title} did not complete`, body: `The backend recorded this run as ${result.status}.` };
}

export function testErrorMessage(type: string, error: unknown): ActionMessage {
  return { tone: 'error', title: `Test ${type} failed`, body: reasonOf(error) };
}

export function favoriteMessage(favorite: boolean): ActionMessage {
  return { tone: 'ok', title: favorite ? 'Added to favorites' : 'Removed from favorites' };
}

export function favoriteErrorMessage(error: unknown): ActionMessage {
  return { tone: 'error', title: 'Failed to update favorite', body: reasonOf(error) };
}

/* --------------------------- promote to an engine ------------------------- */

/** What the server returns when a node is promoted into an engine profile. */
export interface PromotedProfile {
  id: string;
  name: string;
  providerId: string;
}

/**
 * A stored node is now an engine profile.
 *
 * The profile's NAME comes from the server's response, so the message names the
 * same thing the user will see in the engine list. Stored nodes are not all
 * promotable — a node whose original config was never vaulted has no rebuildable
 * share link — so the refusal path is a first-class outcome, not an error.
 */
export function promoteMessage(profile: PromotedProfile): ActionMessage {
  return {
    tone: 'ok',
    title: `Added to the ${profile.providerId} engine`,
    body: `Profile "${profile.name}" is ready to connect.`,
  };
}

export function promoteErrorMessage(error: unknown): ActionMessage {
  return { tone: 'error', title: 'Could not add this node to an engine', body: reasonOf(error) };
}

/* ------------------------------ server check ------------------------------ */

/**
 * What a manual server health check says.
 *
 * The POST returns the sample the monitor just STORED (`latest`), which may be
 * `offline` or `null` (the check ran but wrote nothing) — neither may read as
 * success. The stored status, not the request's completion, decides the tone.
 */
export function serverCheckMessage(serverName: string, latest: Pick<HealthSample, 'status' | 'pingMs'> | null | undefined): ActionMessage {
  if (!latest) {
    return { tone: 'warn', title: `No health sample for ${serverName}`, body: 'The check completed but stored nothing — try again.' };
  }
  if (latest.status === 'online') {
    return { tone: 'ok', title: `${serverName} is online`, body: latest.pingMs != null ? `Ping ${latest.pingMs.toFixed(1)} ms` : undefined };
  }
  if (latest.status === 'degraded') {
    return { tone: 'warn', title: `${serverName} is degraded`, body: latest.pingMs != null ? `Ping ${latest.pingMs.toFixed(1)} ms but probes failed` : 'Only some probes answered' };
  }
  return { tone: 'error', title: `${serverName} is offline`, body: 'No probe answered — the stored sample says offline.' };
}

export function serverCheckErrorMessage(error: unknown): ActionMessage {
  return { tone: 'error', title: 'Check failed', body: reasonOf(error) };
}

/* ----------------------------- engine install ----------------------------- */

/** Backend install outcome — the manager's own status field is the truth. */
export interface EngineInstallResult {
  engine: string;
  status: string;
  version: string | null;
  checksumVerified: boolean;
  versionOutput: string | null;
  error: string | null;
}

/**
 * The install route reports what the manager DID (`status`: installed / updated
 * / already_current / failed) after verifying the binary with a real `version`
 * spawn. A `failed` status is a completed request with a failed outcome — it
 * must say so, with the manager's reason.
 */
export function engineInstallMessage(r: EngineInstallResult): ActionMessage {
  if (r.status === 'failed') {
    return { tone: 'error', title: `${r.engine} install failed`, body: r.error ?? 'The manager reported failure without detail.' };
  }
  if (r.status === 'already_current') {
    return { tone: 'ok', title: `${r.engine} is current`, body: r.versionOutput ?? undefined };
  }
  return {
    tone: 'ok',
    title: `${r.engine} ${r.status}`,
    body: `${r.version ?? ''}${r.checksumVerified ? ' · checksum verified' : ''}`,
  };
}

export function engineInstallErrorMessage(error: unknown): ActionMessage {
  return { tone: 'error', title: 'Install failed', body: reasonOf(error) };
}

/* ------------------------------ tunnel start ------------------------------ */

/** The tunnel status the start/reconnect route stored — the exit check's truth. */
export interface TunnelStatusLike {
  state: string;
  exitIp: string | null;
  exitCountry?: string | null;
  engine?: string | null;
  error: string | null;
  chain?: { entryExitIp: string | null; exitIp: string | null; exitDiffers: boolean } | null;
}

/**
 * `state: 'active'` alone does not mean verified: the exit IP is only known
 * after a trace fetched THROUGH the tunnel. "Tunnel verified · Exit ?" was the
 * old wording for exactly that hole — active-but-never-verified announced as a
 * success with an invented placeholder. Unverified is its own honest outcome.
 */
export function tunnelStartMessage(t: TunnelStatusLike): ActionMessage {
  if (t.state !== 'active') {
    return {
      tone: 'error',
      title: 'Tunnel failed',
      body: t.error ?? 'The core started but traffic could not traverse the node.',
    };
  }
  if (t.chain) {
    const verified = t.chain.exitIp != null;
    return {
      tone: verified ? 'ok' : 'warn',
      title: verified ? 'Nested tunnel verified' : 'Nested tunnel up (exit unverified)',
      body: `Entry ${t.chain.entryExitIp ?? '?'} → exit ${t.chain.exitIp ?? '?'}${t.chain.exitDiffers ? ' (differs)' : ' (identical)'}`,
    };
  }
  if (t.exitIp == null) {
    return { tone: 'warn', title: 'Tunnel up, exit unverified', body: 'The core is running but no exit IP was observed through it.' };
  }
  return {
    tone: 'ok',
    title: 'Tunnel verified',
    body: `Exit ${t.exitIp}${t.exitCountry ? ` (${t.exitCountry})` : ''}${t.engine ? ` via ${t.engine}` : ''}`,
  };
}

export function tunnelReconnectMessage(t: TunnelStatusLike): ActionMessage {
  if (t.state === 'active' && t.exitIp != null) return { tone: 'ok', title: 'Reconnected', body: `Exit ${t.exitIp}` };
  if (t.state === 'active') return { tone: 'warn', title: 'Reconnected, exit unverified', body: 'The core is running but no exit IP was observed through it.' };
  return { tone: 'error', title: 'Reconnect failed', body: t.error ?? undefined };
}

/** Errors carry the useful text; unknown throwables must not render as "[object Object]". */
function reasonOf(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (error == null) return undefined;
  return String(error);
}
