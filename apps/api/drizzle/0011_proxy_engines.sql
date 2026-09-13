-- Migration 0011: proxy-test core engine attribution.
-- Records which local core (xray / sing-box) produced each proxy test result,
-- so measurements are attributable and mixed-engine histories stay honest.

ALTER TABLE node_tests ADD COLUMN engine TEXT;
