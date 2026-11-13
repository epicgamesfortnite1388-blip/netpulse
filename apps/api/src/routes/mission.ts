import { buildMissionSnapshot } from '../services/missionControl';
import { buildOverdriveSnapshot } from '../services/missionOverdrive';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context';

/**
 * Mission Control API — a single read-only snapshot.
 *
 * There is no POST here on purpose. A control surface with buttons that change
 * the machine would have to duplicate the VPN, node and provisioning routes that
 * already own those operations and their guards; this endpoint's job is to
 * describe, and every claim it makes is classified (see missionControl.ts).
 *
 * `/mission/overdrive` is the wider ledger: live service state plus the measured
 * artifacts and research registry on disk. It also only reads.
 */
export function registerMissionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/mission/status', async () => buildMissionSnapshot(ctx));
  app.get('/api/v1/mission/overdrive', async () => buildOverdriveSnapshot(ctx));
}
