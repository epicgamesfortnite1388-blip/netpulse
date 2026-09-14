-- Migration 0013: per-node last proxy engine.
-- Denormalized from node_tests.engine so the node explorer can show, without
-- a join, which local core (xray / sing-box) produced each node's most recent
-- proxy measurement.

ALTER TABLE public_nodes ADD COLUMN last_engine TEXT;
