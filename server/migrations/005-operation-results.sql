CREATE TABLE IF NOT EXISTS operation_results (
  operation_id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 64),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  response_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL
);
