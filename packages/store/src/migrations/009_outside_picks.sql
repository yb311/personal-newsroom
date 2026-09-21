CREATE TABLE outside_picks (
  id TEXT PRIMARY KEY,
  edition_date TEXT NOT NULL,
  lang TEXT NOT NULL,
  mode TEXT NOT NULL,
  event_title TEXT NOT NULL,
  importance_reason TEXT NOT NULL,
  item_ids_json TEXT NOT NULL,
  suggestion_json TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX outside_picks_current ON outside_picks(edition_date, lang, config_fingerprint, created_at DESC);
