CREATE TABLE mail_app_passwords (
 id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), name TEXT NOT NULL,
 password_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- An AUTOINCREMENT UID is never reused, including after an expunge or move.
-- UIDVALIDITY is 1 for this schema. Restore the database and sqlite_sequence together.
CREATE TABLE imap_entries (
 uid INTEGER PRIMARY KEY AUTOINCREMENT, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
 source_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('message','draft')),
 folder TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '[]', raw_key TEXT,
 UNIQUE(mailbox_id,kind,source_id)
);
CREATE INDEX imap_entries_folder ON imap_entries(mailbox_id,folder,uid);
INSERT INTO imap_entries(mailbox_id,source_id,kind,folder)
 SELECT mailbox_id,id,'message',folder FROM messages ORDER BY created_at,id;
INSERT INTO imap_entries(mailbox_id,source_id,kind,folder)
 SELECT mailbox_id,id,'draft','drafts' FROM drafts ORDER BY updated_at,id;
CREATE TRIGGER imap_message_insert AFTER INSERT ON messages BEGIN
 INSERT INTO imap_entries(mailbox_id,source_id,kind,folder) VALUES(NEW.mailbox_id,NEW.id,'message',NEW.folder);
END;
CREATE TRIGGER imap_message_move AFTER UPDATE OF folder ON messages WHEN OLD.folder <> NEW.folder BEGIN
 DELETE FROM imap_entries WHERE source_id=NEW.id AND kind='message';
 INSERT INTO imap_entries(mailbox_id,source_id,kind,folder) VALUES(NEW.mailbox_id,NEW.id,'message',NEW.folder);
END;
CREATE TRIGGER imap_message_delete AFTER DELETE ON messages BEGIN
 DELETE FROM imap_entries WHERE source_id=OLD.id AND kind='message';
END;
CREATE TRIGGER imap_draft_insert AFTER INSERT ON drafts BEGIN
 INSERT INTO imap_entries(mailbox_id,source_id,kind,folder) VALUES(NEW.mailbox_id,NEW.id,'draft','drafts');
END;
-- Changing MIME creates a new UID; an existing UID's content never changes.
CREATE TRIGGER imap_draft_update AFTER UPDATE ON drafts BEGIN
 DELETE FROM imap_entries WHERE source_id=NEW.id AND kind='draft';
 INSERT INTO imap_entries(mailbox_id,source_id,kind,folder) VALUES(NEW.mailbox_id,NEW.id,'draft','drafts');
END;
CREATE TRIGGER imap_draft_delete AFTER DELETE ON drafts BEGIN
 DELETE FROM imap_entries WHERE source_id=OLD.id AND kind='draft';
END;
CREATE TABLE imap_submissions (
 dedupe_key TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, source_id TEXT NOT NULL,
 client_message_id TEXT, reconciled INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
