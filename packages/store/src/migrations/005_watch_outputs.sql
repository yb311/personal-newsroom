-- Open questions a progress pass left without an answer, carried to the next
-- runs as extra things to look for ("明天优先找"), until answered or stale.
CREATE TABLE open_questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id    TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  asked_at    INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT                          -- milestone id that answered it
);
CREATE INDEX open_questions_watch ON open_questions(watch_id, resolved_at, asked_at DESC);

-- One flash can serve several watches (the same event matters to more than one),
-- and it records every item it was written from, so later runs skip them.
ALTER TABLE flashes ADD COLUMN watch_ids_json TEXT;
ALTER TABLE flashes ADD COLUMN item_ids_json TEXT;
ALTER TABLE flashes ADD COLUMN item_published_at INTEGER;

-- Keywords: the only matching available with AI off, and extra recall terms
-- with it on. Sensitivity: the intent gate's more / balanced / less setting.
ALTER TABLE watches ADD COLUMN keywords_json TEXT;
ALTER TABLE watches ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'balanced';
