-- ---------------------------------------------------------------------------
-- vpn_credentials: one server-side identity per (user, protocol).
--
-- Before this table every user authenticated to the VPN server with the same
-- UUID / password (the `VPN_*` Worker secrets), so expiry could only stop NEW
-- provisioning — a config already handed out stayed valid forever. The VPS
-- reconciler now reads the active set from this table and writes exactly those
-- clients into the Xray/Hysteria configs, so removing a row (or letting the
-- entitlement lapse) removes the tunnel identity on the next sync.
--
-- `secret` is the credential the client presents: a UUID for VLESS/VMess, a
-- random hex password for Trojan/Hysteria. It is stored in plaintext because
-- the Worker must be able to rebuild the same config on re-provisioning; D1 is
-- already inside the trust boundary that holds the server's shared secrets.
--
-- `status` is the admin kill-switch (active/revoked). Normal expiry needs no
-- write: the read model joins np_entitlements and filters by end date.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vpn_credentials (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, protocol)
);
CREATE INDEX IF NOT EXISTS idx_vpn_credentials_status ON vpn_credentials(status);
