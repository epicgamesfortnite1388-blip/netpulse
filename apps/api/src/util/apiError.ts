import type { FastifyReply } from 'fastify';
import type { ZodError } from 'zod';

/**
 * The one wire shape for every error this API returns.
 *
 * This file is the only place the shape is written. The routes used to hand-
 * write it, and two incompatible envelopes existed: `{ error: 'not_found',
 * message: '…' }` (error a *string*) at 39 sites and `{ error: { code,
 * message } }` at 9. The desktop client could only read one of them, so every
 * message from the other was discarded and the UI fell back to "Not Found" and
 * `http_404`. A future site copied from its neighbour would have reproduced
 * the split.
 *
 * The nested envelope is the one already documented as the contract in
 * `cloud/worker/src/api.ts` ("{ error: { code, message } } … consistent error
 * envelope") and already asserted by every API test but one, so this adopts it
 * rather than inventing a third. Callers of this API: the web client
 * (`apps/web/src/lib/api.ts`) and the API test suite. Nothing else — the Rust
 * core spawns the sidecar but never reads its response bodies — so there is no
 * compatibility case to preserve and no second shape is kept.
 */

/** One validation problem, flattened for transport. */
export interface ApiErrorIssue {
  path: string;
  message: string;
}

export interface ApiErrorEnvelope {
  error: {
    /** Stable machine code, e.g. `not_found`, `validation_error`. */
    code: string;
    /** One human sentence saying what went wrong. Never empty. */
    message: string;
    /** Optional next step for the user. */
    hint?: string;
    /** Every validation problem, when `code` is a validation code. */
    issues?: ApiErrorIssue[];
  };
}

export interface ApiErrorExtra {
  hint?: string;
  issues?: ApiErrorIssue[];
}

/**
 * Build the envelope without sending it. Exported so `setErrorHandler` and the
 * routes share one definition rather than two that can drift.
 */
export function apiErrorBody(
  code: string,
  message: string,
  extra: ApiErrorExtra = {},
): ApiErrorEnvelope {
  const error: ApiErrorEnvelope['error'] = {
    code,
    message: message || code,
  };
  if (extra.hint) error.hint = extra.hint;
  if (extra.issues?.length) error.issues = extra.issues;
  return { error };
}

/**
 * Send an error using the one envelope. Every explicit error response in a
 * route goes through here — that is the whole point: the shape is defined once,
 * so a new site cannot invent its own.
 */
export function replyApiError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  extra: ApiErrorExtra = {},
): FastifyReply {
  return reply.status(status).send(apiErrorBody(code, message, extra));
}

/**
 * Turn a zod failure into the human sentence plus every issue.
 *
 * The message used to be `JSON.stringify(zodError.message)` — a multi-line
 * issue dump that reached the user verbatim, so the one line that actually
 * explained the failure ("id must be alphanumeric, colon, dot, underscore, or
 * hyphen") was buried inside it. Now the first issue is the message and the
 * full list travels alongside as `issues`.
 */
export function validationIssue(error: ZodError): ApiErrorIssue[] {
  return (error.issues ?? []).map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

export function validationMessage(error: ZodError): string {
  const first = error.issues?.[0];
  if (!first) return 'Invalid request';
  return first.path.length ? `${first.path.join('.')}: ${first.message}` : first.message;
}

/**
 * The 400 for a request that failed schema validation. `detail`/`details` were
 * previously three different field names for the same thing across the nodes
 * routes; this is the one call.
 */
export function replyValidationError(
  reply: FastifyReply,
  code: string,
  error: ZodError,
): FastifyReply {
  return replyApiError(reply, 400, code, validationMessage(error), {
    issues: validationIssue(error),
  });
}