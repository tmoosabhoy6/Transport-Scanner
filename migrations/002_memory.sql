-- What the AI originally read, so corrections can be compared against it
ALTER TABLE slips ADD COLUMN ai_fields TEXT;

-- Every correction made in the dashboard: "AI read X in this field, the right value was Y"
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  field TEXT NOT NULL,          -- sheet field key, or "move:<from>><to>" for an amount put in the wrong column
  ai_value TEXT NOT NULL,
  arabic TEXT NOT NULL DEFAULT '',
  corrected TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE (field, ai_value, arabic, corrected)
);
CREATE INDEX IF NOT EXISTS idx_corrections_field ON corrections(field, ai_value);
