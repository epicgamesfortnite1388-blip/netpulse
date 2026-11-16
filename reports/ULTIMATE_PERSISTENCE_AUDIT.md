# ULTIMATE PERSISTENCE AUDIT

**Audit date:** 2026-11-16 · Scope: `apps/api/src/db/**`, `cloud/worker/migrations/**`, `src-tauri/src/network_intelligence/persistence.rs`, secret vaults. **[V]** verified · **[A]** analysis.

---

## 1. Verified integrity mechanisms

- **Boot gate:** `quick_check` compared to `'ok'`; corrupt DB quarantined (rename, then copy+unlink fallback), never silently deleted; refuses to start without a migrations folder (`db/client.ts:18-58,98-167`). **[V]**
- **Pragmas:** WAL, `foreign_keys=ON`, 5s busy timeout, bounded WAL autocheckpoint, compact-on-close (`client.ts:116-132,172-182`). **[V]**
- **Schema parity:** all 41 `sqliteTable` names and column names appear in migrations; FK declarations in `0000` (10), `0001` (3), `0010` (8); unique constraints on `users.username`, `public_nodes.canonical_fingerprint`, composite node uniqueness; indexes on hot paths. **[V]**
- **Crash recovery:** stale `running` tests finalized; kill-switch "armed" only if the recovery record persisted; adaptive manifest install/rollback persists with explicit failure warning; Rust NANI disk store installed during setup (replacing the in-memory placeholder). **[V]**
- **Settings:** Zod-validated, deep-merged with defaults, persisted. **[V]**
- **Retention:** bounded per-table/per-run delete caps (`db/retention.ts:29-47,82-105`). **[V]**

## 2. Confirmed defects

**P1 — Serialization corruption in NANI store [V] [FIXED].** `persistence.rs:197-198,209,256` used `unwrap_or_default()`; a serialization error wrote an empty JSONL line or an empty `model_state.json` and atomically renamed it over good state. **Fixed:** errors now propagate as `io::Error(InvalidData)`, aborting the write and preserving the previous good file. Verified by 529 passing Rust tests.

**P2 — No explicit transactions [V] [UNFIXED] [MED].** No `.transaction()`, `BEGIN/COMMIT/ROLLBACK` anywhere in `apps/api/src/**`. Logical multi-statement units (test create/finish `repositories.ts:123-145`, benchmark batch insert `:460-468`, source/fetch/document writes) are per-statement autocommit; a mid-sequence failure leaves partial state. **Fix:** wrap each logical unit in a Drizzle transaction.

**P3 — Migration snapshot drift [V] [UNFIXED] [MED].** `apps/api/drizzle/meta/` has only `0000_snapshot.json` while `_journal.json` lists 14 entries; migrations 0001–0013 are hand-written (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD`) with no snapshots, so `db:generate` has no drift guardrail. **Fix:** regenerate snapshots or switch to reviewed hand-written migrations with a drift check.

**P4 — Cloud migration numbering collision [V] [UNFIXED] [LOW].** `0005_reset_atomic.sql` and `0005_vpn_credentials.sql` both exist; independent changes so ordering is benign today, but relative order depends on filename sort. **Fix:** renumber.

**P5 — Retention doc/behaviour mismatch + dead state [V] [UNFIXED] [LOW].** `retention.ts:71-75` claims a WAL checkpoint after every statement; implementation does none. `RetentionService.getState()` is in-memory with no consumer (only `sweep()` wired). **Fix:** implement the checkpoint or correct the comment; remove dead state.

**P6 — SQL identifier interpolation [V] [INVESTIGATE].** Retention builds `DELETE FROM ${rule.table} ... ${rule.tsColumn}` (`retention.ts:90-96`); safe only because both come from the hardcoded `RETENTION_RULES` constant — fragile. **Fix:** whitelist-validate or use a typed builder.

**P7 — Retention coverage gaps [V] [UNFIXED] [LOW].** `user_history`, `devices`, `audit_events`, `np_events`, `node_health`, `public_nodes`, `vpn_connections` have no retention rule → unbounded growth.

## 3. "UI saves but only in memory" check

- **Verified non-issue:** the earlier suspicion that Rust NANI state was memory-only is **not** substantiated — the disk-backed store is installed at `main.rs:430-432`; `PersistenceStore::default()` is documented as test-only.
- **Verified non-issue:** the entitlement mirror is real D1 persistence, not in-memory (see integration audit).

## 4. Secret persistence (summary; see security audit)
- Node secret vault: AES-256-GCM ciphertext + master key in Windows Credential Manager (DPAPI). **The key file ACL bug (read-only `(R)`) was fixed this audit** — it previously blocked key rotation and vault deletion, leaving plaintext keys behind. See `ULTIMATE_REMOVAL_CHANGELOG.md`.
- `vpn_credentials.secret` is plaintext in D1 by documented design; DB read access yields live credentials. **[A]**

## 5. Verdict
Persistence is defensively engineered (integrity gate, WAL, FK, quarantine). The gaps are transactional atomicity (P2), migration drift (P3), and NANI serialization (P1, fixed). None of these delete or reset user data. Priority: P2 → P3 → P5/P6.
