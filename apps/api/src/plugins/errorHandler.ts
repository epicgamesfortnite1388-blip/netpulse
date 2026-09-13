import fs from 'node:fs';

import type { FastifyInstance } from 'fastify';
import type { ZodError } from 'zod';

import { AppError } from '../util/appError';

export function registerErrorHandler(
  app: FastifyInstance,
  opts: { spaIndex?: string } = {},
): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.status).send({
        error: { code: err.code, message: err.message, hint: err.hint },
      });
      return;
    }

    const name = (err as { name?: string }).name;
    if (name === 'ZodError') {
      const issues = (err as unknown as ZodError).issues ?? [];
      reply.status(400).send({
        error: {
          code: 'validation_error',
          message: issues[0] ? `${issues[0].path.join('.')}: ${issues[0].message}` : 'Invalid request',
          issues: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }

    // an explicit numeric statusCode was chosen deliberately by the thrower
    // (4xx client errors and 5xx like 501 not-implemented / 502 upstream) —
    // honor it instead of masking it as a generic internal error
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599) {
      reply.status(statusCode).send({
        error: {
          code: (err as { code?: string }).code ?? `http_${statusCode}`,
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    }

    req.log.error({ err }, 'unhandled error');
    reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred',
        hint: `Check the API logs for request ${req.id}`,
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (path.startsWith('/api/')) {
      reply.status(404).send({
        error: { code: 'not_found', message: `No API route for ${req.method} ${path}` },
      });
      return;
    }
    if (opts.spaIndex && !path.includes('.')) {
      reply.type('text/html').send(fs.readFileSync(opts.spaIndex));
      return;
    }
    reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });
}
