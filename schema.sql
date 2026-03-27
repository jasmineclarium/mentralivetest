-- Run once in your Postgres database.
-- In Railway: Postgres plugin -> Data tab -> Query -> paste & run.

CREATE TABLE IF NOT EXISTS scanned_items (
  id                   SERIAL PRIMARY KEY,
  user_id              TEXT NOT NULL,
  scanned_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  product_name         TEXT NOT NULL,
  manufacturer         TEXT,
  barcode              TEXT,
  expiry_date          DATE,
  is_expired           BOOLEAN,
  days_until_expiry    INTEGER,
  no_expiry_confirmed  BOOLEAN DEFAULT FALSE,
  stream_hls_url       TEXT
);

CREATE INDEX IF NOT EXISTS idx_scanned_items_user
  ON scanned_items (user_id, scanned_at DESC);

CREATE TABLE IF NOT EXISTS active_streams (
  user_id    TEXT PRIMARY KEY,
  hls_url    TEXT,
  dash_url   TEXT,
  started_at TIMESTAMPTZ
);
