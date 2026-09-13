-- Migration 0010: public V2Ray/Xray config intelligence tables.
-- Stores discovered public configs, normalized nodes, their tests, health, scan jobs,
-- user favorites/tags and provenance. Connection secrets are kept in the vault
-- (via source_config_ref pointing into the encrypted config store) — never in these tables.

CREATE TABLE IF NOT EXISTS public_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  homepage TEXT,
  repository_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL DEFAULT 'custom',
  urls TEXT NOT NULL DEFAULT '[]',
  formats TEXT NOT NULL DEFAULT '[]',
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  last_fetch INTEGER,
  last_success INTEGER,
  last_failure INTEGER,
  status TEXT NOT NULL DEFAULT 'idle',
  discovered_config_count INTEGER NOT NULL DEFAULT 0,
  imported_config_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  recent_discovered INTEGER NOT NULL DEFAULT 0,
  recent_imported INTEGER NOT NULL DEFAULT 0,
  recent_healthy INTEGER NOT NULL DEFAULT 0,
  health TEXT NOT NULL DEFAULT 'unknown',
  last_content_hash TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS source_fetches (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES public_sources(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  raw_bytes INTEGER,
  config_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  content_hash TEXT
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS raw_documents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES public_sources(id) ON DELETE CASCADE,
  fetch_id TEXT NOT NULL REFERENCES source_fetches(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  original_text TEXT NOT NULL,
  original_hash TEXT NOT NULL,
  detected_format TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  parsed_at INTEGER,
  config_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  fetched_at INTEGER NOT NULL
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public_nodes (
  id TEXT PRIMARY KEY,
  canonical_fingerprint TEXT NOT NULL UNIQUE,
  protocol TEXT NOT NULL DEFAULT 'unknown',
  host TEXT NOT NULL,
  ipv4 TEXT NOT NULL DEFAULT '[]',
  ipv6 TEXT NOT NULL DEFAULT '[]',
  port INTEGER NOT NULL DEFAULT 443,
  transport TEXT NOT NULL DEFAULT 'tcp',
  security TEXT NOT NULL DEFAULT 'none',
  sni TEXT,
  alpn TEXT NOT NULL DEFAULT '[]',
  fingerprint TEXT,
  flow TEXT,
  alter_id INTEGER,
  path TEXT,
  host_header TEXT,
  service_name TEXT,
  allow_insecure INTEGER NOT NULL DEFAULT 0,
  reality_public_key TEXT,
  reality_short_id TEXT,
  reality_server_name TEXT,
  encryption TEXT,
  ssr_protocol TEXT,
  remark TEXT,
  source_ids TEXT NOT NULL DEFAULT '[]',
  source_urls TEXT NOT NULL DEFAULT '[]',
  source_count INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_validated INTEGER,
  status TEXT NOT NULL DEFAULT 'discovered',
  confidence TEXT NOT NULL DEFAULT 'unknown',
  country TEXT,
  city TEXT,
  asn INTEGER,
  isp TEXT,
  organization TEXT,
  lat REAL,
  lon REAL,
  geo_source_count INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  favorite INTEGER NOT NULL DEFAULT 0,
  user_notes TEXT,
  last_proxy_ms REAL,
  last_tcp_ms REAL,
  last_tls_ms REAL,
  test_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  recent_test_count INTEGER NOT NULL DEFAULT 0,
  recent_success_count INTEGER NOT NULL DEFAULT 0,
  recent_failure_count INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  reliability_pct REAL NOT NULL DEFAULT 0,
  median_proxy_ms REAL,
  median_tcp_ms REAL,
  median_tls_ms REAL,
  recent_loss_pct REAL NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  freshness TEXT NOT NULL DEFAULT 'stale',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS node_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL REFERENCES public_nodes(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  family INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  UNIQUE(node_id, ip)
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS node_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL REFERENCES public_nodes(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES public_sources(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_config_ref TEXT NOT NULL,
  parser_version TEXT NOT NULL DEFAULT '1.0.0',
  normalized_hash TEXT NOT NULL,
  discovered_at INTEGER NOT NULL,
  UNIQUE(node_id, source_id, source_url)
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS node_tests (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES public_nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  latency_ms REAL,
  total_ms REAL,
  tls_version TEXT,
  authorized INTEGER,
  http_status INTEGER,
  response_size INTEGER,
  error TEXT,
  family INTEGER,
  probed_ip TEXT,
  test_endpoint TEXT
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS node_health (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES public_nodes(id) ON DELETE CASCADE,
  test_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  reliability_pct REAL NOT NULL DEFAULT 0,
  median_latency_ms REAL,
  p95_latency_ms REAL,
  loss_pct REAL NOT NULL DEFAULT 0,
  latency_variance REAL,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  healthy_for_ms INTEGER,
  computed_at INTEGER NOT NULL,
  UNIQUE(node_id)
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS scan_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'test',
  status TEXT NOT NULL DEFAULT 'queued',
  filter TEXT,
  node_ids TEXT NOT NULL DEFAULT '[]',
  concurrency INTEGER NOT NULL DEFAULT 10,
  max_per_minute INTEGER NOT NULL DEFAULT 600,
  progress INTEGER NOT NULL DEFAULT 0,
  discovered INTEGER NOT NULL DEFAULT 0,
  tested INTEGER NOT NULL DEFAULT 0,
  healthy INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS test_endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  expected_status INTEGER NOT NULL DEFAULT 200,
  timeout_ms INTEGER NOT NULL DEFAULT 5000,
  max_bytes INTEGER NOT NULL DEFAULT 4096,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS node_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_nodes_fingerprint ON public_nodes(canonical_fingerprint);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_nodes_host ON public_nodes(host);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_nodes_port ON public_nodes(port);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_nodes_protocol ON public_nodes(protocol);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_nodes_country ON public_nodes(country);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_nodes_asn ON public_nodes(asn);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_nodes_status ON public_nodes(status);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_nodes_score ON public_nodes(score);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_nodes_last_tested ON public_nodes(last_validated);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_nodes_freshness ON public_nodes(freshness);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_nodes_created ON public_nodes(created_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_node_sources_node ON node_sources(node_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_node_sources_source ON node_sources(source_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_node_tests_node ON node_tests(node_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_node_tests_type_ts ON node_tests(type, started_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_node_health_node ON node_health(node_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_source_fetches_source ON source_fetches(source_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_raw_documents_source ON raw_documents(source_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs(status);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_node_events_kind_ts ON node_events(kind, at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_node_addresses_ip ON node_addresses(ip);
