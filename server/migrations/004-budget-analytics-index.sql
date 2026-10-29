CREATE INDEX IF NOT EXISTS transactions_budget_analytics_idx
  ON transactions(
    json_extract(payload_json, '$.date') DESC,
    substr(json_extract(payload_json, '$.date'), 1, 7),
    json_extract(payload_json, '$.currency'),
    json_extract(payload_json, '$.pending'),
    coalesce(nullif(json_extract(payload_json, '$.override'), ''), json_extract(payload_json, '$.category')),
    CASE
      WHEN nullif(json_extract(payload_json, '$.override'), '') IS NOT NULL THEN json_extract(payload_json, '$.overrideCategoryId')
      ELSE json_extract(payload_json, '$.categoryId')
    END,
    json_extract(payload_json, '$.amount')
  );
