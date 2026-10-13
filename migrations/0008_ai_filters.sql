CREATE TABLE ai_filters (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT 'inbox',
  threshold REAL NOT NULL DEFAULT 0.8 CHECK(threshold >= 0.5 AND threshold <= 0.99),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ai_filters_mailbox ON ai_filters(mailbox_id);
CREATE TABLE ai_filter_results (
  filter_id TEXT NOT NULL REFERENCES ai_filters(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  body_key TEXT NOT NULL,
  probability REAL NOT NULL CHECK(probability >= 0 AND probability <= 1),
  truncated INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL,
  PRIMARY KEY(filter_id, message_id)
);
CREATE INDEX ai_results_message ON ai_filter_results(message_id);
