ALTER TABLE domains ADD COLUMN routing_mode TEXT NOT NULL DEFAULT 'literal' CHECK(routing_mode IN ('literal','managed'));
CREATE TABLE protected_addresses(address TEXT PRIMARY KEY COLLATE NOCASE, domain_id TEXT NOT NULL REFERENCES domains(id), routing_rule_id TEXT NOT NULL);
