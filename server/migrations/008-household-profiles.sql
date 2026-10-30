CREATE TABLE IF NOT EXISTS household_profiles (
  id TEXT PRIMARY KEY NOT NULL CHECK (id IN ('peter','maddie','joint')),
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO household_profiles(id,label,created_at) VALUES
  ('peter','Peter',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('maddie','Maddie',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('joint','Joint',strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE IF NOT EXISTS household_plan_state (
  profile_id TEXT PRIMARY KEY NOT NULL REFERENCES household_profiles(id),
  income_templates_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(income_templates_json)),
  monthly_income_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(monthly_income_json)),
  outlooks_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(outlooks_json)),
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO household_plan_state(profile_id,updated_at) VALUES
  ('peter',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('maddie',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('joint',strftime('%Y-%m-%dT%H:%M:%fZ','now'));

ALTER TABLE budget_records RENAME TO budget_records_before_profiles;
CREATE TABLE budget_records (
  category_id TEXT NOT NULL CHECK (length(category_id) BETWEEN 1 AND 160),
  effective_month TEXT NOT NULL CHECK (effective_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(effective_month,6,2) BETWEEN '01' AND '12'),
  scope TEXT NOT NULL CHECK (scope IN ('recurring','month')),
  profile_id TEXT NOT NULL DEFAULT 'peter' REFERENCES household_profiles(id),
  monthly_cents INTEGER CHECK (monthly_cents IS NULL OR monthly_cents >= 0),
  source_cents INTEGER CHECK (source_cents IS NULL OR source_cents >= 0),
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','semiannual','annual')),
  due_month INTEGER CHECK (due_month IS NULL OR due_month BETWEEN 1 AND 12),
  CHECK ((source_cents IS NULL AND monthly_cents IS NULL) OR (source_cents IS NOT NULL AND monthly_cents IS NOT NULL)),
  CHECK ((frequency = 'annual' AND due_month IS NOT NULL) OR (frequency <> 'annual' AND due_month IS NULL)),
  PRIMARY KEY(profile_id,category_id,effective_month,scope)
);
INSERT INTO budget_records(category_id,effective_month,scope,profile_id,monthly_cents,source_cents,frequency,due_month)
SELECT category_id,effective_month,scope,'peter',monthly_cents,source_cents,frequency,due_month FROM budget_records_before_profiles;
DROP TABLE budget_records_before_profiles;
CREATE INDEX budget_records_month_profile_idx ON budget_records(effective_month,profile_id,category_id);

ALTER TABLE budget_change_history RENAME TO budget_change_history_before_profiles;
CREATE TABLE budget_change_history (
  history_id TEXT PRIMARY KEY NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('budget','income','outlook')),
  category_id TEXT,
  month TEXT CHECK (month IS NULL OR (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(month,6,2) BETWEEN '01' AND '12')),
  scope TEXT CHECK (scope IS NULL OR scope IN ('recurring','month')),
  profile_id TEXT NOT NULL DEFAULT 'peter' REFERENCES household_profiles(id),
  action TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  operation_id TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO budget_change_history(history_id,record_type,category_id,month,scope,profile_id,action,before_json,after_json,revision,operation_id,created_at)
SELECT history_id,record_type,category_id,month,scope,'peter',action,before_json,after_json,revision,operation_id,created_at FROM budget_change_history_before_profiles;
DROP TABLE budget_change_history_before_profiles;
CREATE INDEX budget_history_month_idx ON budget_change_history(month,created_at DESC,history_id);
CREATE INDEX budget_history_category_idx ON budget_change_history(category_id,created_at DESC,history_id);
CREATE INDEX budget_history_operation_idx ON budget_change_history(operation_id);
CREATE INDEX budget_history_profile_month_idx ON budget_change_history(profile_id,month,created_at DESC,history_id);

ALTER TABLE custom_categories RENAME TO custom_categories_before_profiles;
CREATE TABLE custom_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL DEFAULT 'peter' REFERENCES household_profiles(id)
);
INSERT INTO custom_categories(id,name,normalized_name,profile_id)
SELECT id,name,normalized_name,'peter' FROM custom_categories_before_profiles;
DROP TABLE custom_categories_before_profiles;
CREATE INDEX custom_categories_profile_idx ON custom_categories(profile_id,normalized_name);
