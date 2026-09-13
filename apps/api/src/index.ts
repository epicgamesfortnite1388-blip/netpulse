import { buildApp } from './app';

const { app, ctx } = await buildApp();

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
