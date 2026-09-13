import { z } from 'zod';

import { SettingsPatchSchema } from '@netpulse/shared';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

const runKindSchema = z.object({
  kind: z.enum(['dns', 'gaming', 'vpn']),
});

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/settings', async () => ({ settings: ctx.services.settings.get() }));

  app.put('/api/v1/settings', async (req) => {
    const parsed = SettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) throw parsed.error;
    return { settings: ctx.services.settings.update(parsed.data) };
  });

  // Live state of the recurring benchmark scheduler (last/next run, failures).
  app.get('/api/v1/settings/schedule', async () => ({ status: ctx.services.schedule.statusSnapshot() }));

  // Kick off an immediate run of one scheduled benchmark kind.
  app.post('/api/v1/settings/schedule/run', async (req) => {
    const parsed = runKindSchema.safeParse(req.body);
    if (!parsed.success) throw parsed.error;
    const status = await ctx.services.schedule.runNow(parsed.data.kind);
    return { status };
  });
}