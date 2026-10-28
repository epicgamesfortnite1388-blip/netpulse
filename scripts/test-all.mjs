import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Each workspace's vitest suite is independent (no shared fixtures, databases,
// or network sockets between workspaces), so they are safe to run in parallel.
// Within the API suite the tests are deliberately single-threaded
// (pool: threads, singleThread: true) because they share SQLite temp DBs and
// spawn real sockets — that concurrency limit is preserved by each workspace's
// own vitest config and is not changed here.
const WORKSPACES = [
  { name: '@netpulse/shared', dir: 'packages/shared' },
  { name: '@netpulse/api', dir: 'apps/api' },
  { name: '@netpulse/web', dir: 'apps/web' },
  { name: '@netpulse/cloud-worker', dir: 'cloud/worker' },
];

function runWorkspace(workspace) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    // `npm run test -w <name>` delegates to the workspace's own vitest config
    // (including the API suite's deliberate single-threaded pool), so no
    // concurrency safety is compromised.
    const child = execFile(
      process.platform === 'win32' ? (process.env.comspec || 'cmd.exe') : 'npm',
      process.platform === 'win32'
        ? ['/c', 'npm', 'run', 'test', '-w', workspace.name]
        : ['run', 'test', '-w', workspace.name],
      { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        const failed = error !== null || (stderr && stderr.includes('FAIL'));
        resolve({
          name: workspace.name,
          dir: workspace.dir,
          ok: !failed,
          durationMs: Math.round(durationMs),
          stdout: stdout || '',
          stderr: stderr || '',
          error,
        });
      },
    );
    child.stdout && child.stdout.on('data', () => undefined);
    child.stderr && child.stderr.on('data', () => undefined);
  });
}

async function main() {
  console.log(`\nRunning ${WORKSPACES.length} workspace test suites in parallel...\n`);
  const results = await Promise.all(WORKSPACES.map(runWorkspace));

  let overallOk = true;
  let totalTests = 0;
  let totalFailed = 0;

  for (const r of results) {
    // vitest prints one summary line, with the failed/skipped halves omitted
    // when they are zero:
    //   "Tests  356 passed (356)"
    //   "Tests  1 failed | 355 passed (356)"
    //   "Tests  2 skipped | 354 passed (356)"
    // The earlier regexes only matched the first shape, so every run reported
    // "0 tests" and the totals were meaningless.
    const summary = /Tests\s+([^\n]+?)\((\d+)\)/.exec(r.stdout);
    const tests = summary ? Number(summary[2]) : 0;
    const failedMatch = summary ? /(\d+) failed/.exec(summary[1]) : null;
    const failed = failedMatch ? Number(failedMatch[1]) : 0;
    totalTests += tests;
    totalFailed += failed;

    const status = r.ok ? 'PASS' : 'FAIL';
    console.log(
      `[${status}] ${r.name.padEnd(24)} ${String(r.durationMs).padStart(5)} ms  ${tests} tests${
        failed > 0 ? `, ${failed} failed` : ''
      }`,
    );
    if (!r.ok) {
      overallOk = false;
      const detail = r.error ? ` (${r.error.code} ${r.error.message})` : '';
      console.log(`     stderr: ${(r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n             ')}${detail}`);
    }
  }

  console.log(`\n${overallOk ? 'ALL WORKSPACE TESTS PASSED' : 'ONE OR MORE WORKSPACE TESTS FAILED'}`);
  console.log(`Total: ${totalTests} tests, ${totalFailed} failed (parallel run)`);
  process.exit(overallOk ? 0 : 1);
}

main().catch((err) => {
  console.error('test-all orchestration error:', err);
  process.exit(1);
});
