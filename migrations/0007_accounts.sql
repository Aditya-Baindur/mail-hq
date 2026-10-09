CREATE TABLE users (
 id TEXT PRIMARY KEY,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE mailboxes ADD COLUMN owner_id TEXT REFERENCES users(id);
CREATE INDEX mailboxes_owner ON mailboxes(owner_id);
ALTER TABLE domains ADD COLUMN owner_id TEXT REFERENCES users(id);
CREATE INDEX domains_owner ON domains(owner_id);
CREATE TABLE domain_connections (
 domain_id TEXT PRIMARY KEY REFERENCES domains(id),
 account_id TEXT NOT NULL,
 worker_name TEXT NOT NULL,
 credentials TEXT NOT NULL,
 ready INTEGER NOT NULL DEFAULT 0
);
