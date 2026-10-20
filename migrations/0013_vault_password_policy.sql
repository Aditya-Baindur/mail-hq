-- Per-service password policy for Agent Vault rotations.
-- vault_services.password_length stays the legacy 20–64 length the dashboard already stores.
-- Policies that need a shorter password (down to 8) or character rules live here.
-- The generator prefers this row and falls back to password_length, then 32.
CREATE TABLE IF NOT EXISTS vault_password_policies (
  service_id TEXT PRIMARY KEY,
  policy TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
