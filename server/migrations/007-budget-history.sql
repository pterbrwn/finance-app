CREATE TABLE IF NOT EXISTS budget_change_history (
  history_id TEXT PRIMARY KEY NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('budget','income','outlook')),
  category_id TEXT,
  month TEXT CHECK (month IS NULL OR (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(month,6,2) BETWEEN '01' AND '12')),
  scope TEXT CHECK (scope IS NULL OR scope IN ('recurring','month')),
  action TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  operation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS budget_history_month_idx ON budget_change_history(month,created_at DESC,history_id);
CREATE INDEX IF NOT EXISTS budget_history_category_idx ON budget_change_history(category_id,created_at DESC,history_id);
CREATE INDEX IF NOT EXISTS budget_history_operation_idx ON budget_change_history(operation_id);
