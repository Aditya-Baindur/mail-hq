-- Searchable text is separate from message metadata so inbox queries never
-- load complete bodies. Overlapping chunks stay below D1's per-row limit.
CREATE TABLE message_search_chunks (
 id INTEGER PRIMARY KEY,
 message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 part INTEGER NOT NULL,
 text TEXT NOT NULL,
 UNIQUE(message_id, part)
);
CREATE TABLE message_search_state (
 message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
 body_key TEXT NOT NULL,
 version INTEGER NOT NULL,
 indexed_at TEXT NOT NULL
);
-- Trigrams preserve the existing literal substring search, including email
-- addresses and punctuation, while indexing the entire message text.
CREATE VIRTUAL TABLE message_search_fts USING fts5(
 text, content='message_search_chunks', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER message_search_insert AFTER INSERT ON message_search_chunks BEGIN
 INSERT INTO message_search_fts(rowid,text) VALUES(new.id,new.text);
END;
CREATE TRIGGER message_search_delete AFTER DELETE ON message_search_chunks BEGIN
 INSERT INTO message_search_fts(message_search_fts,rowid,text) VALUES('delete',old.id,old.text);
END;
CREATE TRIGGER message_search_update AFTER UPDATE ON message_search_chunks BEGIN
 INSERT INTO message_search_fts(message_search_fts,rowid,text) VALUES('delete',old.id,old.text);
 INSERT INTO message_search_fts(rowid,text) VALUES(new.id,new.text);
END;
-- Metadata remains searchable during rollout and before the body backfill.
CREATE TRIGGER messages_search_insert AFTER INSERT ON messages BEGIN
 INSERT INTO message_search_chunks(message_id,part,text) VALUES(new.id,0,
  new.subject || char(10) || new.sender || char(10) || new.sender_name || char(10) ||
  new.recipients || char(10) || new.cc || char(10) || new.bcc || char(10) || new.snippet);
END;
CREATE TRIGGER messages_search_update AFTER UPDATE OF subject,sender,sender_name,recipients,cc,bcc,snippet ON messages BEGIN
 UPDATE message_search_chunks SET text=
  new.subject || char(10) || new.sender || char(10) || new.sender_name || char(10) ||
  new.recipients || char(10) || new.cc || char(10) || new.bcc || char(10) || new.snippet
 WHERE message_id=new.id AND part=0;
END;
CREATE TRIGGER messages_search_body_changed AFTER UPDATE OF body_key ON messages
 WHEN old.body_key IS NOT new.body_key BEGIN
 DELETE FROM message_search_chunks WHERE message_id=new.id AND part>0;
 DELETE FROM message_search_state WHERE message_id=new.id;
END;
INSERT INTO message_search_chunks(message_id,part,text)
 SELECT id,0,subject || char(10) || sender || char(10) || sender_name || char(10) ||
 recipients || char(10) || cc || char(10) || bcc || char(10) || snippet FROM messages;
