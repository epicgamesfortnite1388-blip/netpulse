-- 0003: NetPulse  Abystral (Telegram commerce) integration schema.
--
-- Contract: docs/netpulse-integration.md in the Abystral repo. Abystral owns
-- purchases/payments/entitlements; NetPulse mirrors them for linked app
-- accounts. Link state is authoritative on the bot; this schema stores the
-- local mirror (np_links), the signed event inbox (np_events), the projected
-- entitlements (np_entitlements), single-use HMAC nonces (service_nonces),
-- and an audit log of signed outbound calls (np_outbound_log).
--
-- Note: partial UNIQUE indexes (WHERE ...) are used  inline
-- "UNIQUE (...) WHERE ..." constraints are not valid SQLite syntax.

-- ---------------------------------------------------------------------------
-- service_nonces: single-use nonces for inbound HMAC verification (np-auth).
--   Insert-before-verify: the PRIMARY KEY makes a replayed nonce fail hard,
--   even under concurrent replays. TTL (15 min) covers the 5 min skew window.
-- ---------------------------------------------------------------------------
CREATE TABLE service_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_service_nonces_expires ON service_nonces(expires_at);

-- ---------------------------------------------------------------------------
-- np_links: durable identity mapping  one active link per app account AND
--   per Telegram user, enforced with partial unique indexes.
--   user_id is the NetPulse account (derived from the verified session);
--   telegram_user_id comes only from the bot's signed API  never from a
--   client payload. status: pending | active | unlinked.
-- ---------------------------------------------------------------------------
CREATE TABLE np_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_user_id INTEGER,
  netpulse_account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  initiated_by TEXT NOT NULL DEFAULT 'netpulse',
  linked_at INTEGER,
  unlinked_at INTEGER,
  last_synced_at INTEGER NOT NULL DEFAULT 0,
  last_sync_status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_np_links_one_active_per_user ON np_links(user_id) WHERE status = 'active';
CREATE UNIQUE INDEX idx_np_links_one_active_per_account ON np_links(netpulse_account_id) WHERE status = 'active';
CREATE INDEX idx_np_links_telegram ON np_links(telegram_user_id);
CREATE INDEX idx_np_links_status ON np_links(status);

-- ---------------------------------------------------------------------------
-- np_events: inbound event inbox. event_id is the bot's dedup key  replayed
--   deliveries are INSERT OR IGNORE no-ops (idempotency, 13 of the contract).
--   Every accepted event is audited with its processing outcome.
-- ---------------------------------------------------------------------------
CREATE TABLE np_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  telegram_user_id INTEGER,
  netpulse_account_id TEXT,
  subscription_ref TEXT,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  processed_status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT
);
CREATE INDEX idx_np_events_account ON np_events(netpulse_account_id, received_at DESC);
CREATE INDEX idx_np_events_status ON np_events(processed_status, received_at DESC);

-- ---------------------------------------------------------------------------
-- np_entitlements: the app-visible mirror of the bot's entitlements  the
--   ONLY source of subscription data in the NetPulse UI (safe model only:
--   no panel URLs, no VPN credentials ever leave the bot).
--   subscription_id is the bot's subscription id (stable across events).
-- ---------------------------------------------------------------------------
CREATE TABLE np_entitlements (
  subscription_id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  netpulse_account_id TEXT,
  plan_code TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  expires_at TEXT,
  auto_renew INTEGER NOT NULL DEFAULT 0,
  total_gb REAL NOT NULL DEFAULT 0,
  used_gb REAL NOT NULL DEFAULT 0,
  ip_limit INTEGER,
  config_updated_at TEXT,
  event_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_np_ent_user ON np_entitlements(user_id);
CREATE INDEX idx_np_ent_account ON np_entitlements(netpulse_account_id);

-- ---------------------------------------------------------------------------
-- np_outbound_log: audit of every request this worker signed and sent to the
--   bot (link request, claim, status poll, entitlement pull, unlink).
--   Never stores signatures or secrets  action + path + outcome only.
-- ---------------------------------------------------------------------------
CREATE TABLE np_outbound_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  request_path TEXT NOT NULL,
  status INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_np_outbound_user ON np_outbound_log(user_id, created_at DESC);
