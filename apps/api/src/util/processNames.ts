import { execFile } from 'node:child_process';

/**
 * PID → process name resolution for the Live Map connection tracker.
 *
 * Windows: `tasklist /fi "PID eq N" /fo csv /nh` — one row, quoted CSV.
 * Best-effort by design: processes can exit between netstat and tasklist, and
 * elevated/system PIDs may refuse the query. Failures return null, never throw.
 */

const cache = new Map<number, string | null>();
const MAX_CACHE = 2_000;

function run(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout ?? null);
    });
  });
}

function remember(pid: number, name: string | null): string | null {
  if (cache.size >= MAX_CACHE) {
    // drop the oldest quarter — process churn is bounded, so this stays fresh
    const cut = Math.floor(MAX_CACHE / 4);
    let n = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++n >= cut) break;
    }
  }
  cache.set(pid, name);
  return name;
}

export async function processNameForPid(pid: number | null): Promise<string | null> {
  if (pid == null || !Number.isInteger(pid) || pid <= 0 || process.platform !== 'win32') return null;
  const hit = cache.get(pid);
  if (hit !== undefined) return hit;
  const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 4_000);
  if (!out) return remember(pid, null);
  // CSV: "name","pid","session",..., or "INFO: no tasks..." when the PID is gone
  const first = out.split('\n')[0]?.trim() ?? '';
  if (!first.startsWith('"')) return remember(pid, null);
  const name = /^"([^"]{1,120})"/.exec(first)?.[1] ?? null;
  return remember(pid, name);
}

/** Resolve names for many PIDs with bounded concurrency, caching as it goes. */
export async function processNamesForPids(pids: (number | null)[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  const todo = [...new Set(pids.filter((p): p is number => p != null && p > 0 && !cache.has(p)))].slice(0, 60);
  let index = 0;
  const workers = Array.from({ length: Math.min(6, todo.length) }, async () => {
    for (;;) {
      const pid = todo[index++];
      if (pid == null) return;
      out.set(pid, await processNameForPid(pid));
    }
  });
  await Promise.all(workers);
  // include cached answers too
  for (const p of pids) {
    if (p == null) continue;
    if (cache.has(p)) out.set(p, cache.get(p) ?? null);
  }
  return out;
}

/** Test hook: drop cached entries so tests are hermetic. */
export function clearProcessNameCache(): void {
  cache.clear();
}
