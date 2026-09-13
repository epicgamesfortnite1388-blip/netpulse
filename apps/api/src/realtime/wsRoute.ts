import crypto from 'node:crypto';

import type { RealtimeBus, WsMessage } from '../realtime/bus';

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

interface WsClientMessage {
  type?: string;
  testId?: string;
}

/**
 * One-time WebSocket tickets.
 *
 * Browser WS clients cannot attach Authorization headers, and the sidecar's
 * session cookie is SameSite=strict (not sent on cross-origin WS handshakes
 * from the webview origin). A unauthenticated WS would let any local process
 * or a drive-by web page (via a crafted cross-origin WS handshake) observe
 * test progress. Instead, an authenticated client mints a single-use ticket
 * (POST /ws/ticket, 30 s TTL) and passes it as `?ticket=` on the WS URL. The
 * ticket is consumed on first use: replay is dead on arrival.
 */
const TICKET_TTL_MS = 30_000;
const MAX_LIVE_TICKETS = 100;

export function registerWsRoute(app: FastifyInstance, bus: RealtimeBus): void {
  const tickets = new Map<string, number>(); // ticket -> expiresAt

  const sweepTickets = () => {
    const now = Date.now();
    for (const [t, exp] of tickets) if (exp <= now) tickets.delete(t);
  };

  app.post('/api/v1/ws/ticket', async () => {
    sweepTickets();
    // Bound: a runaway client cannot accumulate live tickets.
    if (tickets.size >= MAX_LIVE_TICKETS) {
      const oldest = tickets.keys().next().value as string | undefined;
      if (oldest) tickets.delete(oldest);
    }
    const ticket = crypto.randomBytes(32).toString('hex');
    tickets.set(ticket, Date.now() + TICKET_TTL_MS);
    return { ticket, expiresInMs: TICKET_TTL_MS };
  });

  app.get('/api/v1/ws', { websocket: true }, (socket: WebSocket, req) => {
    // Authenticate the upgrade: exactly one valid, unexpired, unused ticket.
    const url = new URL(req.url ?? '/api/v1/ws', 'http://127.0.0.1');
    const presented = url.searchParams.get('ticket') ?? '';
    const expiresAt = presented ? tickets.get(presented) : undefined;
    if (!presented || expiresAt === undefined || expiresAt <= Date.now()) {
      tickets.delete(presented);
      socket.close(4401, 'ws authentication required');
      return;
    }
    tickets.delete(presented); // single use — consumed even on success

    const unsubscribes = new Map<string, () => void>();
    const MAX_SUBSCRIPTIONS_PER_SOCKET = 32;

    const send = (msg: WsMessage) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(msg));
    };

    socket.on('message', (raw: Buffer) => {
      let parsed: WsClientMessage;
      try {
        parsed = JSON.parse(raw.toString()) as WsClientMessage;
      } catch {
        return;
      }
      const testId = typeof parsed.testId === 'string' ? parsed.testId : null;
      if (!testId) return;
      if (parsed.type === 'subscribe') {
        // Bound per-socket subscriptions and make re-subscribe idempotent, so
        // a chatty client cannot accumulate listener sets on a topic.
        if (unsubscribes.has(testId)) {
          send({ type: 'subscribed', testId });
          return;
        }
        if (unsubscribes.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
          send({ type: 'error', testId, error: 'too many subscriptions on this connection' });
          return;
        }
        const unsubscribe = bus.subscribe(testId, send);
        unsubscribes.set(testId, unsubscribe);
        send({ type: 'subscribed', testId });
      } else if (parsed.type === 'unsubscribe') {
        const unsubscribe = unsubscribes.get(testId);
        if (unsubscribe) {
          unsubscribe();
          unsubscribes.delete(testId);
        }
        send({ type: 'unsubscribed', testId });
      }
    });

    socket.on('close', () => {
      for (const unsubscribe of unsubscribes.values()) unsubscribe();
      unsubscribes.clear();
    });

    req.log.debug('ws client connected');
  });
}
