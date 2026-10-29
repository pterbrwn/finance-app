CREATE TABLE IF NOT EXISTS budget_records (
  category_id TEXT NOT NULL CHECK (length(category_id) BETWEEN 1 AND 160),
  effective_month TEXT NOT NULL CHECK (effective_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(effective_month,6,2) BETWEEN '01' AND '12'),
  scope TEXT NOT NULL CHECK (scope IN ('recurring','month')),
  monthly_cents INTEGER CHECK (monthly_cents IS NULL OR monthly_cents >= 0),
  source_cents INTEGER CHECK (source_cents IS NULL OR source_cents >= 0),
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','semiannual','annual')),
  due_month INTEGER CHECK (due_month IS NULL OR due_month BETWEEN 1 AND 12),
  CHECK ((source_cents IS NULL AND monthly_cents IS NULL) OR (source_cents IS NOT NULL AND monthly_cents IS NOT NULL)),
  CHECK ((frequency = 'annual' AND due_month IS NOT NULL) OR (frequency <> 'annual' AND due_month IS NULL)),
  PRIMARY KEY(category_id,effective_month,scope)
);
