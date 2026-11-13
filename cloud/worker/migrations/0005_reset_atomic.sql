-- 0005: password reset as an atomic transaction, with delivery state on the
-- token row itself.
--
-- Before this, issuing a reset was three independent writes (retire the old
-- token, insert the new one, audit) and redeeming one was three more (claim the
-- token, change the password, revoke sessions). A failure between them left
-- states that cannot be reconciled afterwards:
--
--   * a live, usable token whose email was never sent -- the user has no code
--     and the row looks like a working reset;
--   * a consumed token whose password was never changed -- the user is locked
--     out, and the one credential that could have fixed it is spent.
--
-- Both flows now run as one D1 batch (transactional, all-or-nothing), and these
-- columns are what make the participation of a redemption provable:
--
--   delivery_status : 'pending' -> 'sent' | 'failed:<reason>'
--   delivered_at    : when the transport accepted the message
--   attempts        : HTTP attempts the send took (0 = never attempted)
--   last_error      : the failure reason, readable by support without logs
--   used_nonce      : unique id of the redemption that consumed the token.
--                     Every other statement of that redemption is conditioned
--                     on it, so a concurrent second redemption matches nothing
--                     even when both share the same millisecond clock tick.
ALTER TABLE password_reset_tokens ADD COLUMN delivery_status TEXT;
ALTER TABLE password_reset_tokens ADD COLUMN delivered_at INTEGER;
ALTER TABLE password_reset_tokens ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE password_reset_tokens ADD COLUMN last_error TEXT;
ALTER TABLE password_reset_tokens ADD COLUMN used_nonce TEXT;
