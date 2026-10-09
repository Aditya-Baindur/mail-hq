CREATE TABLE oauth_connections (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 client_id TEXT NOT NULL,
 name TEXT NOT NULL,
 mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
 scopes TEXT NOT NULL,
 grant_id TEXT,
 expires_at TEXT NOT NULL,
 revoked_at TEXT,
 last_used_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX oauth_connections_user ON oauth_connections(user_id,created_at);
-- D1 gives consent a strongly consistent, one-use claim as well as the
-- OAuth provider's short-lived browser-binding cookie and KV transaction.
CREATE TABLE oauth_consents (
 handle_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 expires_at TEXT NOT NULL
);
