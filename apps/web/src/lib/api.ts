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

interface RequestOptions extends Omit<RequestInit, 'body'> {
  json?: unknown;
  _retried?: boolean;
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
    let code = `http_${res.status}`;
    let message = res.statusText;
    let hint: string | undefined;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string; hint?: string } };
      if (body.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        hint = body.error.hint;
      }
    } catch {
      // non-JSON error body
    }
    throw new ApiError(code, res.status, message, hint);
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
