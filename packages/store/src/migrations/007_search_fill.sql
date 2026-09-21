CREATE TABLE search_materials (
  id            TEXT PRIMARY KEY,
  target_item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  event_title   TEXT NOT NULL,
  event_time    INTEGER NOT NULL,
  date_estimated INTEGER NOT NULL DEFAULT 0,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  search_text   TEXT NOT NULL,
  filled_text   TEXT,
  publishable   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX search_materials_item ON search_materials(target_item_id, created_at DESC);

CREATE TABLE search_material_sources (
  material_id TEXT NOT NULL REFERENCES search_materials(id) ON DELETE CASCADE,
  ref_id      TEXT NOT NULL,
  url         TEXT NOT NULL,
  title       TEXT,
  publisher   TEXT,
  item_id     TEXT REFERENCES items(id) ON DELETE SET NULL,
  accessible  INTEGER NOT NULL DEFAULT 0,
  relevant    INTEGER NOT NULL DEFAULT 0,
  supported   INTEGER NOT NULL DEFAULT 0,
  evidence_text TEXT,
  PRIMARY KEY (material_id, ref_id)
);
ALTER TABLE flashes ADD COLUMN search_material_id TEXT REFERENCES search_materials(id) ON DELETE SET NULL;
