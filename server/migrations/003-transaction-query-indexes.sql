CREATE INDEX IF NOT EXISTS transactions_date_id_idx
  ON transactions(json_extract(payload_json, '$.date') DESC, id ASC);

CREATE INDEX IF NOT EXISTS transactions_account_date_id_idx
  ON transactions(account_id, json_extract(payload_json, '$.date') DESC, id ASC);

CREATE INDEX IF NOT EXISTS transactions_item_date_id_idx
  ON transactions(item_id, json_extract(payload_json, '$.date') DESC, id ASC);
