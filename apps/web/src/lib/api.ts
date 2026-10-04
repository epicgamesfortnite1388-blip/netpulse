import { initTransport, resetTransport, transport } from '@/lib/transport';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint?: string;

  constructor(code: string, status: number, message: string, hint?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

/**
 * Whether sending the identical request again could ever succeed.
 *
 * A 4xx is the server describing a request that is itself wrong — `/nodes/bad$id`
 * is not a node id no matter how often it is asked for. Offering "Try again" for
 * one invited the user to click forever, so those no longer show a retry action.
 * Retryable means the fault is on our side of the wire: the server failed (5xx),
 * it is throttling us (429), the request timed out (408), or the request never
 * reached it at all (a transport failure, which the sidecar may respawn out of).
 *
 * This is a status test, not a code registry: 503 means "try later" by
 * definition, and a service that is permanently unconfigured should not be
 * returning 503 in the first place.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status >= 500 || error.status === 429 || error.status === 408;
  }
  return true;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  json?: unknown;
  _retried?: boolean;
}

/** What an error body can contribute, before it is layered onto the status. */
export interface ParsedErrorBody {
  code?: string;
  message?: string;
  hint?: string;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Read the one error envelope the API returns: `{ error: { code, message, hint } }`.
 *
 * This is deliberately NOT a tolerant reader. The API used to emit two
 * incompatible envelopes (a flat one at 39 sites, the nested one at 9), this
 * client understood only the nested one, and the messages from the other 39
 * were silently dropped. Accepting both here hid that instead of fixing it, and
 * would have let the server grow a third shape nobody reads. The server now
 * owns the envelope in a single place (`apps/api/src/util/apiError.ts`) and this
 * mirrors it.
 *
 * A body that does not match contributes nothing, so a non-API error (a proxy,
 * a port-forward, a WebView-level failure) still falls back to the HTTP status
 * text rather than inventing a code.
 */
export function parseErrorBody(body: unknown): ParsedErrorBody {
  if (typeof body !== 'object' || body === null) return {};
  const err = (body as Record<string, unknown>).error;
  if (typeof err !== 'object' || err === null) return {};
  const e = err as Record<string, unknown>;
  return {
    code: asText(e.code),
    message: asText(e.message),
    hint: asText(e.hint),
  };
}

/**
 * All backend traffic goes through the transport layer (see transport.ts):
 * desktop mode talks to the token-authenticated loopback sidecar chosen by
 * the Rust core; web mode talks to the same-origin deployment.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  await initTransport();
  const t = transport();

  const { json, _retried, ...rest } = options;
  const url = `${t.apiBase}${path}`;
  const init: RequestInit = {
    ...rest,
    credentials: 'include',
    headers: {
      ...t.authHeaders(),
      ...(rest.headers ?? {}),
    },
  };
  if (json !== undefined) {
    init.method = init.method ?? 'POST';
    init.headers = { ...(init.headers as Record<string, string>), 'content-type': 'application/json' };
    init.body = JSON.stringify(json);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Desktop: a network-level failure (e.g. connection refused) means the
    // sidecar may have respawned — possibly on a NEW ephemeral port. Re-run
    // bootstrap once and retry before surfacing the error, so a watchdog
    // respawn can never leave the UI latched to a dead endpoint.
    //
    // Only idempotent requests are retried. A timeout AFTER a POST was
    // delivered would replay the action (double connect / double UAC prompt),
    // which serializeVpnOp on the server exists to prevent.
    const method = (init.method ?? 'GET').toUpperCase();
    if (t.mode === 'desktop' && !_retried && (method === 'GET' || method === 'HEAD')) {
      resetTransport();
      return request<T>(path, { ...options, _retried: true });
    }
    throw err;
  }

  // Web mode: a 401 can mean an expired cookie session — re-issue once.
  // Desktop mode: the bearer token is ephemeral and always valid for the
  // sidecar's lifetime, so retrying would be pointless.
  if (res.status === 401 && t.mode === 'web' && path !== '/auth/session' && !_retried) {
    const session = await fetch(`${t.apiBase}/auth/session`, {
      method: 'POST',
      credentials: 'include',
    });
    if (session.ok) return request<T>(path, { ...options, _retried: true });
  }

  if (!res.ok) {
    let parsed: ParsedErrorBody = {};
    try {
      parsed = parseErrorBody(await res.json());
    } catch {
      // non-JSON error body
    }
    throw new ApiError(
      parsed.code ?? `http_${res.status}`,
      res.status,
      parsed.message ?? res.statusText,
      parsed.hint,
    );
  }

  // Some endpoints return plain text (e.g. config export) — return raw text
  // when the caller asked for it and the body is not JSON.
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await res.json()) as T;
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, json?: unknown) => request<T>(path, { method: 'POST', json }),
  put: <T>(path: string, json?: unknown) => request<T>(path, { method: 'PUT', json }),
  patch: <T>(path: string, json?: unknown) => request<T>(path, { method: 'PATCH', json }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
