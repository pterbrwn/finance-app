ALTER TABLE custom_categories RENAME TO custom_categories_before_profile_unique;
CREATE TABLE custom_categories (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  profile_id TEXT NOT NULL DEFAULT 'peter' REFERENCES household_profiles(id),
  UNIQUE(profile_id,normalized_name)
);
INSERT INTO custom_categories(id,name,normalized_name,profile_id)
SELECT id,name,normalized_name,profile_id FROM custom_categories_before_profile_unique;
DROP TABLE custom_categories_before_profile_unique;
CREATE INDEX custom_categories_profile_idx ON custom_categories(profile_id,normalized_name);
