-- A durable cleanup marker lets deletion resume after a storage failure.
ALTER TABLE mailboxes ADD COLUMN deletion_started_at TEXT;

-- Reject requests that began before deletion but write after the mailbox pauses.
CREATE TRIGGER messages_require_active_mailbox BEFORE INSERT ON messages
WHEN NOT EXISTS (SELECT 1 FROM mailboxes WHERE id=NEW.mailbox_id AND status='active')
BEGIN SELECT RAISE(ABORT, 'Mailbox is not active'); END;
CREATE TRIGGER attachments_require_active_mailbox BEFORE INSERT ON attachments
WHEN NOT EXISTS (SELECT 1 FROM mailboxes WHERE id=NEW.mailbox_id AND status='active')
BEGIN SELECT RAISE(ABORT, 'Mailbox is not active'); END;
CREATE TRIGGER drafts_require_active_mailbox BEFORE INSERT ON drafts
WHEN NOT EXISTS (SELECT 1 FROM mailboxes WHERE id=NEW.mailbox_id AND status='active')
BEGIN SELECT RAISE(ABORT, 'Mailbox is not active'); END;
CREATE TRIGGER drafts_update_require_active_mailbox BEFORE UPDATE ON drafts
WHEN NOT EXISTS (SELECT 1 FROM mailboxes WHERE id=NEW.mailbox_id AND status='active')
BEGIN SELECT RAISE(ABORT, 'Mailbox is not active'); END;
