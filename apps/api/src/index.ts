import { buildApp } from './app';
import { sweepStaleCoreDirs } from './services/proxyCores';

const { app, ctx } = await buildApp();

// Housekeeping: core temp dirs from a crashed/killed run hold core.json, which
// embeds node credentials. Remove the stale ones so they do not accumulate.
const swept = sweepStaleCoreDirs();
if (swept.removed > 0 || swept.failed > 0) {
  app.log.info(
    `Removed ${swept.removed} stale core config dir(s) from a previous run${swept.failed > 0 ? ` (${swept.failed} left behind)` : ''}`,
  );
}

await app.listen({ port: ctx.config.port, host: ctx.config.host });
app.log.info(`NetPulse API ready at http://localhost:${ctx.config.port}`);
app.log.info(`Demo mode: ${ctx.config.demoMode ? 'ON (data labeled DEMO DATA)' : 'off'}`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info('Shutting down...');
  await app.close();
  ctx.db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
