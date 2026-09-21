ALTER TABLE deep_summaries RENAME TO legacy_deep_summaries;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  anchor_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  topic TEXT NOT NULL,
  initial_item_ids_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX conversations_anchor ON conversations(anchor_item_id, lang, updated_at DESC);

CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,
  question TEXT,
  answer_json TEXT,
  status TEXT NOT NULL,
  model TEXT,
  request_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(conversation_id, sequence)
);
CREATE INDEX conversation_messages_order ON conversation_messages(conversation_id, sequence);

CREATE TABLE conversation_sources (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ref_id TEXT NOT NULL,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  basis TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  publisher TEXT,
  published_at INTEGER,
  material_text TEXT NOT NULL,
  search_material_id TEXT REFERENCES search_materials(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, ref_id),
  UNIQUE(conversation_id, item_id)
);
