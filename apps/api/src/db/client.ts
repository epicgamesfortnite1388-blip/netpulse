import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import type { AppConfig } from '../config';

import * as schema from './schema';

export interface DbHandle {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: Database.Database;
  close(): void;
}

/** Open one SQLite file and run a cheap integrity gate before returning. */
function openSqliteFile(dbPath: string): Database.Database {
  let sqlite: Database.Database;
  try {
    sqlite = new Database(dbPath);
  } catch (err) {
    // Open itself failed (SQLITE_NOTADB etc.): nothing is left open, so the
    // file can be renamed by the caller's quarantine step.
    throw err;
  }
  try {
    // quick_check reports corruption as a RESULT ROW (e.g. "file is not a
    // database"), not as an exception — compare against 'ok' explicitly or
    // the gate never fires and migrate() crashes later.
    const verdict = sqlite.pragma('quick_check', { simple: true });
    if (typeof verdict === 'string' && verdict !== 'ok') {
      throw new Error(`sqlite quick_check failed: ${verdict}`);
    }
    return sqlite;
  } catch (gateErr) {
    // Windows: better-sqlite3 keeps the file handle mapped for a NOTADB file
    // even after close(), blocking rename (EBUSY). The quarantine step below
    // therefore must not race a held handle — leave the close until after the
    // rename by closing here only if we can, and reporting honestly if not.
    try {
      sqlite.close();
    } catch {
      /* handle may stay mapped until process exit — quarantine handles it */
    }
    throw gateErr;
  }
}

/**
 * Move a corrupt DB file aside (never silently destroyed). Windows can hold a
 * transient lock on the file right after close (AV/indexer), so: retry the
 * rename, then fall back to copy+unlink. Returns the quarantine path or null.
 */
function quarantineCorruptDb(dbPath: string): string | null {
  const quarantine = `${dbPath}.corrupt-${Date.now()}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(dbPath, quarantine);
      removeDbSidecars(dbPath);
      return quarantine;
    } catch (renameErr) {
      const detail = renameErr instanceof Error ? `${renameErr.message} (code=${(renameErr as NodeJS.ErrnoException).code})` : String(renameErr);
      process.stderr.write(`[netpulse] quarantine rename attempt ${attempt + 1} failed: ${detail}\n`);
      sleepSync(300);
    }
  }
  try {
    // Fallback: copy the corrupt bytes aside, then remove the original.
    fs.copyFileSync(dbPath, quarantine);
    fs.rmSync(dbPath, { force: true, maxRetries: 10, retryDelay: 500 });
    removeDbSidecars(dbPath);
    return quarantine;
  } catch (copyErr) {
    const detail = copyErr instanceof Error ? `${copyErr.message} (code=${(copyErr as NodeJS.ErrnoException).code})` : String(copyErr);
    process.stderr.write(`[netpulse] quarantine copy fallback failed: ${detail}\n`);
    return null;
  }
}

function removeDbSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true, maxRetries: 10, retryDelay: 500 });
    } catch {
      /* best effort */
    }
  }
}

/** Synchronous sleep that works in module-init contexts. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function openDb(config: AppConfig): DbHandle {
  fs.mkdirSync(config.dataDir, { recursive: true });
  let sqlite: Database.Database;
  try {
    sqlite = openSqliteFile(config.dbPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Corrupt database: quarantine the broken file (never silently delete
    // user data) and self-heal with a fresh DB in the same boot.
    const quarantine = quarantineCorruptDb(config.dbPath);
    process.stderr.write(
      `[netpulse] database corrupted (${message}); ${
        quarantine ? `quarantined to ${quarantine}` : 'could not quarantine — remove the file manually'
      } — ${quarantine ? 'starting with a fresh database' : 'refusing to start'}\n`,
    );
    if (!quarantine) throw err;
    sqlite = new Database(config.dbPath); // fresh DB — do NOT re-run the integrity gate on a brand-new file
  }
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // A desktop app shares this DB across a long-lived process and occasional
  // external readers; a busy timeout converts rare lock contention into a
  // short wait instead of an immediate SQLITE_BUSY error.
  sqlite.pragma('busy_timeout = 5000');
  // Bounded WAL growth: checkpoint when the log passes 4 MB instead of letting
  // it expand indefinitely during long scanner/benchmark sessions.
  sqlite.pragma('wal_autocheckpoint = 4000');
  // Memory tuning for a long-lived desktop sidecar: a bounded page cache,
  // in-memory temp tables (sorts/CTEs for scans), and mmap'd reads cut both
  // allocation churn and read latency on the large history/node queries.
  sqlite.pragma('cache_size = -8192'); // 8 MB page cache
  sqlite.pragma('temp_store = MEMORY');
  sqlite.pragma('mmap_size = 134217728'); // 128 MB read mapping
  sqlite.pragma('cache_spill = false');
  sqlite.pragma('wal_checkpoint(TRUNCATE)'); // start each session with a compact WAL
  const db = drizzle(sqlite, { schema });

  // Locate the drizzle migrations folder regardless of whether this module
  // runs from source (apps/api/src), the bundle (apps/api/dist) or the
  // packaged desktop sidecar (no import.meta.url): walk candidate depths and
  // finally fall back to the migrations folder embedded at bundle time via
  // NETPULSE_MIGRATIONS_DIR (set by the Tauri supervisor / prepare script).
  const metaUrl = (import.meta as { url?: string } | undefined)?.url;
  let here: string;
  if (metaUrl) {
    here = path.dirname(fileURLToPath(metaUrl));
  } else if (typeof __dirname === 'string') {
    // CJS: __dirname is available in the desktop bundle (CommonJS)
    here = __dirname;
  } else {
    // Fallback: use cwd, but also try the executable's directory
    here = process.cwd();
  }
  const candidates = [
    process.env.NETPULSE_MIGRATIONS_DIR,
    path.resolve(here, '../../drizzle'),
    path.resolve(here, '../drizzle'),
    path.resolve(here, '../../../drizzle'),
    // Desktop bundle: the migrations are in src-tauri/backend/drizzle,
    // which is beside the executable's backend/ directory.
    path.resolve(process.execPath, '../drizzle'),
    path.resolve(process.execPath, '../../drizzle'),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  const migrationsFolder = candidates.find((c) => fs.existsSync(path.join(c, 'meta')));
  if (!migrationsFolder) {
    throw new Error(
      `Drizzle migrations folder not found (looked in: ${candidates.join(', ')}) — refusing to start with an unmigrated schema`,
    );
  }
  migrate(db, { migrationsFolder });

  return {
    db,
    sqlite,
    close() {
      // Fold the session's optimizer stats and shrink the WAL before the file
      // handle drops — keeps the on-disk database compact between sessions.
      try {
        sqlite.pragma('optimize');
        sqlite.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        /* best-effort — the close below must always run */
      }
      sqlite.close();
    },
  };
}
