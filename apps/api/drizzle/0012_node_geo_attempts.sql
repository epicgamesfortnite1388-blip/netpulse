-- Migration 0012: node geolocation attempts.
-- Tracks when each node's IP-based geo lookup last ran so the geo worker can
-- (a) never re-attempt in a tight loop, (b) retry failed lookups after a week,
-- (c) refresh successful geo after a month (IPs / GeoIP data drift).
-- Unset means "never attempted" - the default for existing and new nodes.

ALTER TABLE public_nodes ADD COLUMN geo_last_attempt INTEGER;
