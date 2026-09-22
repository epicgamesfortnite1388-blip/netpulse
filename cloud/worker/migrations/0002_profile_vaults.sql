-- End-to-end encrypted profile backups (v1.1.0 feature).
-- The Worker stores ONLY ciphertext: the put schema accepts no other field,
-- so plaintext configs cannot land here even from a malicious client.
-- Isolation: user_id always derives from the verified session.

CREATE TABLE profile_vaults (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, profile_id)
);
CREATE INDEX idx_profile_vaults_user ON profile_vaults(user_id, updated_at);
