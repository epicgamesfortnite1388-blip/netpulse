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
    const before = ctx.services.settings.get().vpn?.killSwitch === true;
    const settings = ctx.services.settings.update(parsed.data);
    // Turning the switch off must release a block that is currently applied —
    // otherwise "off" would keep the machine cut off until the next connect,
    // which is exactly the silent-broken-state class this feature avoids.
    if (before && settings.vpn?.killSwitch !== true && ctx.services.killSwitch.status().armed) {
      await ctx.services.killSwitch.release('disabled in settings');
    }
    return { settings };
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