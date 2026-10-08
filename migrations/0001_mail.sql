PRAGMA foreign_keys = ON;
CREATE TABLE domains (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, receiving INTEGER NOT NULL DEFAULT 0,
 sending INTEGER NOT NULL DEFAULT 0, note TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE mailboxes (
 id TEXT PRIMARY KEY, domain_id TEXT NOT NULL REFERENCES domains(id), address TEXT NOT NULL UNIQUE COLLATE NOCASE,
 name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#647c68', status TEXT NOT NULL DEFAULT 'provisioning' CHECK(status IN ('provisioning','active','failed','paused')),
 routing_rule_id TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE messages (
 id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), thread_id TEXT NOT NULL,
 direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')), folder TEXT NOT NULL DEFAULT 'inbox' CHECK(folder IN ('inbox','sent','archive','trash','spam')),
 sender TEXT NOT NULL, sender_name TEXT NOT NULL DEFAULT '', recipients TEXT NOT NULL DEFAULT '[]', cc TEXT NOT NULL DEFAULT '[]', bcc TEXT NOT NULL DEFAULT '[]', reply_to TEXT,
 subject TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', body_key TEXT NOT NULL, raw_key TEXT,
 message_id TEXT, in_reply_to TEXT, refs TEXT NOT NULL DEFAULT '', dedupe_key TEXT,
 is_read INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','sending','accepted','failed','uncertain')),
 error TEXT, size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 UNIQUE(mailbox_id,dedupe_key)
);
CREATE INDEX messages_mailbox_folder_date ON messages(mailbox_id,folder,created_at DESC);
CREATE INDEX messages_thread ON messages(mailbox_id,thread_id,created_at);
CREATE INDEX messages_message_id ON messages(mailbox_id,message_id);
CREATE TABLE attachments (
 id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), message_id TEXT REFERENCES messages(id),
 filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, object_key TEXT NOT NULL UNIQUE, content_id TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX attachments_message ON attachments(message_id);
CREATE TABLE drafts (
 id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), data TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE agent_tokens (
 id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
 scopes TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE audit_events (
 id TEXT PRIMARY KEY, mailbox_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX audit_events_date ON audit_events(created_at DESC);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window INTEGER NOT NULL);
