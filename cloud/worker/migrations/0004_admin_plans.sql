-- 0004: Admin plan-of-record and role-aware account gating.
--
-- This worker has never had a global "Plan" table. What it DOES have is:
--  - `users` rows (no role column until this migration adds one)
--  - per-user `vpn_profiles` and `user_favorites` (already user-scoped)
--  - mirrored `np_entitlements` (bot-owned plan codes, not this app's Plan of record)
--
-- So the new "Plan" is an app-owned definition an admin can edit, stored in
-- one row of `plans`. NORMAL accounts keep every path they already had (their
-- OWN profiles/favorites/subscriptions); this migration only ADDS admin-only
-- surfaces, it never shrinks a user path.
--
-- ASCII only on purpose: the test runtime inlines this file via a vitest
-- `define`, which travels as an HTTP header and rejects bytes > 255.

-- Role column. Existing rows default to 'normal', so a deployment that runs
-- this migration ends up with ZERO admins and requires an explicit bootstrap
-- (POST /api/v1/admin/account, or a promotion by an existing admin). Nobody
-- silently gains admin on a rolled-out worker.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'normal';

-- The plan of record: one row an admin owns. `default_profiles` and
-- `default_nodes` are JSON arrays of opaque keys (the app's config/node
-- identifiers, same key space as user_favorites.node_key); `code` is the
-- SAME field the bot mirrors into np_entitlements.plan_code.
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  default_profiles TEXT NOT NULL DEFAULT '[]',
  default_nodes TEXT NOT NULL DEFAULT '[]',
  default_scan_profile TEXT NOT NULL DEFAULT 'balanced',
  preferred_proxy_engine TEXT NOT NULL DEFAULT 'auto',
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO plans (id, code, name, default_profiles, default_nodes, default_scan_profile, preferred_proxy_engine, updated_at)
  VALUES ('plan_pro', 'pro', 'Pro', '[]', '[]', 'balanced', 'auto', 0);

-- admin_events: audit of admin-only mutations (role changes, plan edits).
CREATE TABLE IF NOT EXISTS admin_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  acted_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acted_at INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_events_by ON admin_events(acted_by, acted_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_events_target ON admin_events(target_user_id);

-- WARNING: the INSERT OR IGNORE bootstrap row above must NOT be treated as
-- proof that any account is admin. Admin status is the user row's `role`
-- column, NOT the presence of a `plans` row.
