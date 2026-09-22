-- 0001: NetPulse cloud schema -- accounts, sessions, sync payloads.
-- Security posture: passwords are PBKDF2 hashes (never plaintext), session
-- tokens are stored as SHA-256 hashes (a DB leak cannot mint sessions),
-- reset tokens are hashed + single-use + short-lived, and every user-owned
-- row carries user_id with ON DELETE CASCADE so account deletion is complete.
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  normalized_email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_algo TEXT NOT NULL DEFAULT 'PBKDF2-SHA256',
  password_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_users_normalized_email ON users(normalized_email);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE,
  device_name TEXT,
  os TEXT,
  app_version TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash);
CREATE INDEX idx_sessions_refresh ON sessions(refresh_hash);

CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  requested_ip TEXT
);
CREATE INDEX idx_reset_user ON password_reset_tokens(user_id);

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE vpn_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  -- Envelope-only: host/port/transport metadata. Secrets (uuid/password/key)
  -- stay local unless the user opts into encrypted backup (future pass).
  endpoint TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  config_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_profiles_user ON vpn_profiles(user_id);
CREATE UNIQUE INDEX idx_profiles_user_name ON vpn_profiles(user_id, name) WHERE deleted_at IS NULL;

CREATE TABLE user_favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, node_key)
);
CREATE TABLE user_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_history_user_at ON user_history(user_id, at DESC);

CREATE TABLE user_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  os TEXT,
  app_version TEXT,
  first_seen_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

-- Tombstones of rotated refresh tokens: replaying one revokes the chain.
CREATE TABLE rotated_refresh_hashes (
  hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  rotated_at INTEGER NOT NULL
);
CREATE INDEX idx_rotated_session ON rotated_refresh_hashes(session_id);

-- Fixed-window rate limiter state (no Durable Object needed at this scale).
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
CREATE INDEX idx_rate_window ON rate_limits(window_start);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  ip TEXT,
  detail TEXT
);
CREATE INDEX idx_audit_user_at ON audit_events(user_id, at DESC);
CREATE INDEX idx_audit_kind_at ON audit_events(kind, at DESC);
