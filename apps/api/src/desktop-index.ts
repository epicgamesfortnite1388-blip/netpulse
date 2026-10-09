/**
 * NetPulse desktop sidecar entry point.
 *
 * This is the packaged backend used by the Tauri desktop shell. Differences
 * from the dev/web server (`src/index.ts`):
 *
 *  - PORT is taken from NETPULSE_PORT (chosen by the Rust supervisor, ephemeral)
 *  - DATA_DIR is taken from NETPULSE_DATA_DIR (OS app-data dir, set by Rust)
 *  - The daemon token is NOT generated/persisted here: the supervisor generates
 *    an ephemeral token and hands it over via stdin. A missing/short token is a
 *    fatal config error — the sidecar refuses to start unauthenticated.
 *  - Bind host is always 127.0.0.1 — the sidecar is never exposed to the LAN.
 *  - stdin close => graceful shutdown (the supervisor closes stdin on exit).
 *
 * Built as CommonJS (Node single-executable packaging requires CJS), so the
 * top-level await flow lives inside an async `main()`.
 */
import { buildApp } from './app';
import { runAutoConnectIfNeeded } from './services/autoConnect';

function readTokenFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      // Supervisor sends a single line then closes stdin.
      if (buf.includes('\n') || buf.length >= 64) {
        cleanup();
        resolve(buf.trim());
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(buf.trim());
    };
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    // If stdin is already closed or never delivers, don't hang forever.
    setTimeout(() => {
      cleanup();
      resolve(buf.trim());
    }, 3000).unref();
  });
}

let shuttingDown = false;
let app: Awaited<ReturnType<typeof buildApp>>['app'] | null = null;
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'] | null = null;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app?.log.info(`Shutting down (${reason})...`);
  await app?.close();
  ctx?.db.close();
  process.exit(0);
}

async function main(): Promise<void> {
  const stdinToken = await readTokenFromStdin();
  if (!stdinToken || stdinToken.length < 32) {
    process.stderr.write('sidecar-fatal: missing or short daemon token on stdin\n');
    process.exit(78); // EX_CONFIG: supervisor handshake failed
  }

  const built = await buildApp({
    configOverrides: {
      port: Number(process.env.NETPULSE_PORT ?? 0),
      host: '127.0.0.1',
      dataDir: process.env.NETPULSE_DATA_DIR || undefined,
      // Desktop CORS is centralized in config.ts (DESKTOP_WEBVIEW_ORIGINS is
      // merged into the default allowlist), so no override is needed here.
    },
    daemonToken: stdinToken,
  });
  app = built.app;
  ctx = built.ctx;

  await app.listen({ port: ctx.config.port, host: '127.0.0.1' });

  // The supervisor may pass NETPULSE_PORT=0 (ephemeral); report the ACTUAL
  // bound port so the verify pipeline and any port-aware consumers agree.
  const address = app.server.address();
  const boundPort = typeof address === 'object' && address ? address.port : ctx.config.port;
  app.log.info(`NetPulse desktop sidecar ready on 127.0.0.1:${boundPort}`);

  // Auto-connect preference: same helper as the dev server, same quick-connect
  // path as the Connect button (remembered gateways → discovery scan).
  runAutoConnectIfNeeded(app, ctx);

  // Notify the supervisor that we are listening (stderr is piped to the app log).
  process.stderr.write(`sidecar-ready port=${boundPort}\n`);

  // stdin EOF => supervisor gone or quitting.
  process.stdin.on('end', () => void shutdown('supervisor stdin closed'));
  process.on('SIGINT', () => void shutdown('sigint'));
  process.on('SIGTERM', () => void shutdown('sigterm'));

  // Keep the process referenced; stdin is our lifecycle channel.
  process.stdin.resume();
}

void main().catch((err) => {
  process.stderr.write(`sidecar-fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
