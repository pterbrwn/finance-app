CREATE TABLE IF NOT EXISTS budget_templates (
  category_id TEXT NOT NULL,
  effective_from TEXT NOT NULL CHECK (length(effective_from) = 7),
  amount INTEGER CHECK (amount IS NULL OR amount >= 0),
  PRIMARY KEY(category_id, effective_from)
);

CREATE TABLE IF NOT EXISTS monthly_budgets (
  month TEXT NOT NULL CHECK (length(month) = 7),
  category_id TEXT NOT NULL,
  amount INTEGER CHECK (amount IS NULL OR amount >= 0),
  PRIMARY KEY(month, category_id)
);
