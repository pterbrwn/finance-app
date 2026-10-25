PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  item_id TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transactions_account_idx ON transactions(account_id);
CREATE INDEX IF NOT EXISTS transactions_item_idx ON transactions(item_id);

CREATE TABLE IF NOT EXISTS holdings (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS budgets (
  category TEXT PRIMARY KEY,
  amount INTEGER NOT NULL CHECK (amount >= 0)
);

CREATE TABLE IF NOT EXISTS import_batches (
  source_checksum TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  imported_at TEXT NOT NULL,
  record_counts_json TEXT NOT NULL
);
