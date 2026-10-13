-- Keep usage independently of messages/filters so deleting mail cannot erase costs.
CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  mailbox_id TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','completed','failed','invalid')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_nano_usd INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX ai_usage_owner_date ON ai_usage(owner_id,created_at);
CREATE TABLE billing_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO billing_metadata(key,value) VALUES('tracking_since',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE billing_expenses (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  month TEXT NOT NULL,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
  created_at TEXT NOT NULL
);
CREATE INDEX billing_expenses_owner_month ON billing_expenses(owner_id,month);
