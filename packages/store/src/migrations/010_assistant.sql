-- 新闻助手：不绑定任何文章的问答会话。每一轮的材料快照完整保存，
-- 回答里的每条事实只能引用本会话登记过的来源编号。
CREATE TABLE assistant_chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  lang TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX assistant_chats_recent ON assistant_chats(updated_at DESC);

CREATE TABLE assistant_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES assistant_chats(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,              -- user | assistant
  content TEXT,                    -- the question, for user turns
  answer_json TEXT,                -- { units }, for assistant turns
  status TEXT NOT NULL,            -- pending | complete | cancelled | failed
  web INTEGER NOT NULL DEFAULT 0,  -- whether this turn was allowed to go online
  error TEXT,
  model TEXT,
  request_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(chat_id, sequence)
);

CREATE TABLE assistant_sources (
  chat_id TEXT NOT NULL REFERENCES assistant_chats(id) ON DELETE CASCADE,
  ref_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- library | news | web
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  publisher TEXT,
  published_at INTEGER,
  material_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, ref_id),
  UNIQUE(chat_id, url)
);
