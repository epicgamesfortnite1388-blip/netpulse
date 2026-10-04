import fs from 'node:fs';

import type { FastifyInstance } from 'fastify';
import type { ZodError } from 'zod';

import { AppError } from '../util/appError';
import { apiErrorBody, replyApiError, validationIssue, validationMessage } from '../util/apiError';

export function registerErrorHandler(
  app: FastifyInstance,
  opts: { spaIndex?: string } = {},
): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.status).send(apiErrorBody(err.code, err.message, { hint: err.hint }));
      return;
    }

    const name = (err as { name?: string }).name;
    if (name === 'ZodError') {
      const zod = err as unknown as ZodError;
      reply.status(400).send(
        apiErrorBody('validation_error', validationMessage(zod), { issues: validationIssue(zod) }),
      );
      return;
    }

    // an explicit numeric statusCode was chosen deliberately by the thrower
    // (4xx client errors and 5xx like 501 not-implemented / 502 upstream) —
    // honor it instead of masking it as a generic internal error
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599) {
      reply.status(statusCode).send(
        apiErrorBody(
          (err as { code?: string }).code ?? `http_${statusCode}`,
          err instanceof Error ? err.message : String(err),
        ),
      );
      return;
    }

    req.log.error({ err }, 'unhandled error');
    reply.status(500).send(
      apiErrorBody('internal_error', 'An unexpected error occurred', {
        hint: `Check the API logs for request ${req.id}`,
      }),
    );
  });

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (path.startsWith('/api/')) {
      reply.status(404).send(apiErrorBody('not_found', `No API route for ${req.method} ${path}`));
      return;
    }
    if (opts.spaIndex && !path.includes('.')) {
      reply.type('text/html').send(fs.readFileSync(opts.spaIndex));
      return;
    }
    replyApiError(reply, 404, 'not_found', 'Not found');
  });
}
