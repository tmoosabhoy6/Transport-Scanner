CREATE TABLE IF NOT EXISTS slips (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL,            -- queued | processing | done | error
  attempts INTEGER NOT NULL DEFAULT 0,
  file_name TEXT,
  engine TEXT,
  fields TEXT,                     -- JSON: sheet columns
  extras TEXT,                     -- JSON: pax, times, office use, raw Arabic
  review TEXT,                     -- JSON: list of field keys that need a human look
  reviewed INTEGER NOT NULL DEFAULT 0,
  exported INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  raw TEXT                         -- JSON: raw model readings (for debugging)
);
CREATE INDEX IF NOT EXISTS idx_slips_created ON slips(created_at);
CREATE INDEX IF NOT EXISTS idx_slips_status ON slips(status);
CREATE INDEX IF NOT EXISTS idx_slips_batch ON slips(batch_id);

-- Learned Arabic -> English spellings (from your corrections in the dashboard)
CREATE TABLE IF NOT EXISTS aliases (
  kind TEXT NOT NULL,              -- driver | group | vehicle | place
  arabic TEXT NOT NULL,
  english TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, arabic)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
