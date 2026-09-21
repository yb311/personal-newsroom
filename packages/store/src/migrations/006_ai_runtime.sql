-- Vendor-neutral AI runtime state. Vec0 tables stay fixed at 768 dimensions;
-- metadata prevents equal-sized vectors from different models being mixed.
CREATE TABLE ai_runtime (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  vector_profile    TEXT,
  vector_generation INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
);
INSERT INTO ai_runtime (id, vector_generation, updated_at) VALUES (1, 0, 0);

CREATE TABLE embedding_cache_meta (
  item_id           TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  vector_profile    TEXT NOT NULL,
  vector_generation INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE TABLE watch_vector_meta (
  watch_id          TEXT PRIMARY KEY REFERENCES watches(id) ON DELETE CASCADE,
  vector_profile    TEXT NOT NULL,
  vector_generation INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);

-- One row per physical provider request. Feature events may point at it but
-- never duplicate its cost in reports.
CREATE TABLE ai_requests (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT REFERENCES runs(id) ON DELETE SET NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  operation          TEXT NOT NULL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  search_calls       INTEGER,
  cost_usd           REAL,
  cost_known         INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);
CREATE INDEX ai_requests_run ON ai_requests(run_id, created_at);
