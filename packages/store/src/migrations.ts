/**
 * Schema migrations, embedded rather than read from .sql files on disk.
 *
 * The app ships as a bundled Electron main process, where `import.meta.url` is
 * undefined and loose .sql files are not part of the build output. Embedding
 * removes that whole class of packaging failure, and migrations are append-only
 * anyway: never edit an applied one, always add the next.
 */
export interface Migration { name: string; sql: string }

const M001_INIT = `-- personal-newsroom initial schema
-- Design rule (see AGENTS.md "少做有损压缩"): anything the AI needs to reason over
-- is stored as full original text, never as a hash or a compressed summary.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ───────────────────────── sources ─────────────────────────
CREATE TABLE sources (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,          -- rss | news_sitemap | news_sitemap_index | rsshub
                                               -- | telegram | hackernews | reddit | github
                                               -- | gdelt | googlenews | bingnews | apify_x
  name                 TEXT NOT NULL,
  domain               TEXT,
  url                  TEXT NOT NULL,          -- feed URL, or route path for rsshub/telegram/...
  category             TEXT,
  lang                 TEXT,
  country              TEXT,
  -- Per-user, per-source confidence. Replaces daily-brief's global AUTHORITY_WEIGHTS.
  -- 0.9 user-added · AUTHORITY_WEIGHTS for curated outlets · 0.5 social.
  trust                REAL NOT NULL DEFAULT 0.75,
  enabled              INTEGER NOT NULL DEFAULT 0,
  date_hydration       TEXT,                   -- NULL | 'article_html'
  config_json          TEXT,                   -- headers, \${VAR} placeholders (Horizon convention)
  added_by             TEXT NOT NULL DEFAULT 'catalog',  -- catalog | user | opml
  created_at           INTEGER NOT NULL,
  last_fetch_at        INTEGER,
  last_ok_at           INTEGER,
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sources_enabled ON sources(enabled, kind);
CREATE INDEX sources_category ON sources(category) WHERE enabled = 1;

-- ───────────────────────── items ─────────────────────────
CREATE TABLE items (
  id              TEXT PRIMARY KEY,
  -- canonicalDedupKey() from daily-brief: folds www./m./amp., keeps query string.
  dedup_key       TEXT NOT NULL UNIQUE,
  source_id       TEXT REFERENCES sources(id) ON DELETE SET NULL,
  url             TEXT NOT NULL,
  title           TEXT NOT NULL,
  published_at    INTEGER NOT NULL,
  discovered_at   INTEGER NOT NULL,
  snippet         TEXT,
  author          TEXT,
  lang            TEXT,
  image_url       TEXT,
  -- Body extraction. Text lives on disk (body_path), not in the DB.
  body_state      TEXT NOT NULL DEFAULT 'pending',  -- pending|ok|blocked|failed|skipped
  body_path       TEXT,
  body_words      INTEGER,
  body_engine     TEXT,                    -- defuddle | extractus | structural
  body_fetched_at INTEGER,
  body_error      TEXT
);
CREATE INDEX items_published ON items(published_at DESC);
CREATE INDEX items_source ON items(source_id, published_at DESC);
CREATE INDEX items_body_pending ON items(body_state) WHERE body_state = 'pending';

-- ───────────────────────── watches ─────────────────────────
CREATE TABLE watches (
  id              TEXT PRIMARY KEY,
  origin          TEXT NOT NULL,           -- preset | intent | customized
  label           TEXT NOT NULL,
  -- ★ The user's own sentence. Goes into judging prompts verbatim. Never compiled away.
  intent          TEXT NOT NULL,
  output_lang     TEXT,                    -- NULL → use global default
  active          INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  -- Recall aids only ever WIDEN the candidate set. Deliberately no exclude list:
  -- keyword-level exclusion is lossy compression (see AGENTS.md).
  recall_aids_json TEXT,                   -- { aliases[], relatedTerms[], sourceHints[], updatedAt }
  created_at      INTEGER NOT NULL,
  last_run_at     INTEGER
);

-- ★ Full user text, not a normalised label.
CREATE TABLE corrections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id   TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  verdict    TEXT NOT NULL,                -- wanted | not_wanted
  user_note  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX corrections_watch ON corrections(watch_id, created_at DESC);

-- ───────────────────────── matches ─────────────────────────
CREATE TABLE matches (
  watch_id     TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  recalled_by  TEXT NOT NULL,              -- comma list: r1_vector,r2_alias,r3_search
  vector_score REAL,
  intent_score REAL,                       -- 0..10 from the batched LLM judge
  reason       TEXT,                       -- ★ the judge's own words, kept for the user
  novelty      REAL,
  passed_gate  INTEGER NOT NULL DEFAULT 0,
  judged_at    INTEGER,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (watch_id, item_id)
);
CREATE INDEX matches_gate ON matches(watch_id, passed_gate, intent_score DESC);

-- ───────────────────────── outputs ─────────────────────────
CREATE TABLE digests (
  id           TEXT PRIMARY KEY,
  edition_date TEXT NOT NULL UNIQUE,       -- YYYY-MM-DD in the user's timezone
  lang         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body_json    TEXT NOT NULL,              -- RichBlock[] (rich-content.tsx renderer)
  generated_at INTEGER NOT NULL,
  model        TEXT
);

CREATE TABLE flashes (
  id            TEXT PRIMARY KEY,
  watch_id      TEXT REFERENCES watches(id) ON DELETE SET NULL,
  batch_id      TEXT NOT NULL,
  published_at  INTEGER NOT NULL,
  lang          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  importance    INTEGER NOT NULL,          -- 0..10
  importance_reason TEXT,
  category      TEXT,
  -- Ported from daily-brief: records whether this was written from the article
  -- or filled in via googleSearch because the body could not be fetched.
  basis         TEXT NOT NULL DEFAULT 'article',   -- article | search
  follow_up_of  TEXT REFERENCES flashes(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX flashes_recent ON flashes(published_at DESC);
CREATE INDEX flashes_watch ON flashes(watch_id, published_at DESC);

-- Timeline milestones. first_seen_at is what powers BOTH the "since yesterday"
-- panel (first_seen_at = today) and the full watch timeline (everything).
-- One dataset, two renderings, one judgement.
CREATE TABLE milestones (
  id            TEXT PRIMARY KEY,
  watch_id      TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  occurred_on   TEXT NOT NULL,             -- YYYY-MM-DD
  first_seen_at INTEGER NOT NULL,
  summary       TEXT NOT NULL,
  is_new        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX milestones_watch ON milestones(watch_id, occurred_on);
CREATE INDEX milestones_new ON milestones(first_seen_at DESC) WHERE is_new = 1;

CREATE TABLE milestone_sources (
  milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (milestone_id, item_id)
);

-- ★ "What I have already told you" — full narrative text, not a fact hash.
-- This is what novelty judging reads.
CREATE TABLE told_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id   TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  narrative  TEXT NOT NULL,
  surface    TEXT NOT NULL,                -- digest | flash | progress
  surface_id TEXT,
  told_at    INTEGER NOT NULL
);
CREATE INDEX told_watch ON told_records(watch_id, told_at DESC);

CREATE TABLE deep_summaries (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  lang         TEXT NOT NULL,
  body_json    TEXT NOT NULL,              -- RichBlock[] with bound sourceRefIds
  sources_json TEXT NOT NULL,              -- the bound source list; model may not invent URLs
  generated_at INTEGER NOT NULL,
  model        TEXT,
  UNIQUE(item_id, lang)
);

-- ───────────────────────── reader ─────────────────────────
CREATE TABLE reading_state (
  item_id       TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  read_at       INTEGER,
  starred_at    INTEGER,
  scroll_offset REAL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX reading_starred ON reading_state(starred_at DESC) WHERE starred_at IS NOT NULL;

-- v2 (translation). Table exists now so v2 needs no migration.
-- Keyed by paragraph hash so switching reading modes never re-pays.
CREATE TABLE translations (
  para_hash    TEXT NOT NULL,
  target_lang  TEXT NOT NULL,
  item_id      TEXT REFERENCES items(id) ON DELETE CASCADE,
  source_text  TEXT NOT NULL,
  target_text  TEXT NOT NULL,
  model        TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (para_hash, target_lang)
);

-- ───────────────────────── infrastructure ─────────────────────────
-- Generation lock. Replaces the Upstash Redis lock. BEGIN IMMEDIATE + heartbeat;
-- an expired lock is stealable. Not a file lock: flock cleanup after kill -9 is
-- unreliable on macOS, heartbeat expiry is explicit.
CREATE TABLE locks (
  name         TEXT PRIMARY KEY,
  holder_pid   INTEGER NOT NULL,
  acquired_at  INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- Worker → UI channel. The UI may not be running, so there is no IPC:
-- the worker writes here and the UI reads it on next launch.
CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,               -- daily | flashes | backfill | fetch
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  outcome     TEXT,                        -- ok | partial | failed
  stats_json  TEXT
);
CREATE INDEX runs_recent ON runs(started_at DESC);

-- Structured logging envelope ported from daily-brief lib/core/logging.ts.
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT REFERENCES runs(id) ON DELETE CASCADE,
  at            INTEGER NOT NULL,
  event         TEXT NOT NULL,
  stage         TEXT,
  phase         TEXT,
  entity_type   TEXT,
  entity_id     TEXT,
  outcome       TEXT,
  reason_code   TEXT,
  reason_detail TEXT,
  elapsed_ms    INTEGER,
  attrs_json    TEXT
);
CREATE INDEX events_run ON events(run_id, at);

-- Circuit breakers for rate-limited upstreams (GDELT especially).
-- Community testing shows exponential BACKOFF makes GDELT worse; the correct
-- pattern is to open a circuit and fail fast. See docs/SPIKES.zh-CN.md §3.
CREATE TABLE circuit_breakers (
  endpoint      TEXT PRIMARY KEY,
  state         TEXT NOT NULL DEFAULT 'closed',   -- closed | open
  opened_at     INTEGER,
  reopen_at     INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_reason   TEXT
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** Separate because it requires the sqlite-vec extension to be loaded first. */
const M002_VECTORS = `-- Requires the sqlite-vec extension to be loaded first.
-- 768 dims matches gemini-embedding-2 as used by daily-brief.
--
-- NOTE (docs/SPIKES.zh-CN.md §1): each vector costs ~3224 bytes on disk,
-- i.e. ~2.3 GB/year at 2000 items/day. Mitigation is a retention policy
-- (see prune_vectors) plus optional Matryoshka truncation to 256 dims.
CREATE VIRTUAL TABLE embeddings USING vec0(
  item_id   TEXT PRIMARY KEY,
  embedding float[768]
);

CREATE VIRTUAL TABLE watch_vectors USING vec0(
  watch_id  TEXT PRIMARY KEY,
  embedding float[768]
);
`;

const M003_ESTIMATED_DATES = `-- Some upstreams (several RSSHub routes, a few sitemaps) publish items with no
-- date at all. Dropping those silently loses whole sources; inventing a date
-- would be worse. So the item is kept with the time we first saw it, and this
-- flag records that the timestamp is a discovery time, not a publication time.
-- The reader shows "发现于" rather than "发布于" for these.
ALTER TABLE items ADD COLUMN date_estimated INTEGER NOT NULL DEFAULT 0;
`;

const M004_FEED_CACHE = `-- HTTP cache validators from the last successful download of each source.
-- Sent back as If-None-Match / If-Modified-Since so an unchanged feed costs a
-- 304 instead of a full download and parse.
ALTER TABLE sources ADD COLUMN etag TEXT;
ALTER TABLE sources ADD COLUMN last_modified TEXT;
`;

const M005_WATCH_OUTPUTS = `-- Open questions a progress pass left without an answer, carried to the next
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
`;

const M006_AI_RUNTIME = `-- Vendor-neutral AI runtime and vector identity.
CREATE TABLE ai_runtime (
  id INTEGER PRIMARY KEY CHECK (id = 1), vector_profile TEXT,
  vector_generation INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
INSERT INTO ai_runtime (id, vector_generation, updated_at) VALUES (1, 0, 0);
CREATE TABLE embedding_cache_meta (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  vector_profile TEXT NOT NULL, vector_generation INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE watch_vector_meta (
  watch_id TEXT PRIMARY KEY REFERENCES watches(id) ON DELETE CASCADE,
  vector_profile TEXT NOT NULL, vector_generation INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE ai_requests (
  id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, operation TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, search_calls INTEGER, cost_usd REAL,
  cost_known INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX ai_requests_run ON ai_requests(run_id, created_at);
`;

const M007_SEARCH_FILL = `CREATE TABLE search_materials (
  id TEXT PRIMARY KEY, target_item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  event_title TEXT NOT NULL, event_time INTEGER NOT NULL, date_estimated INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL, model TEXT NOT NULL, search_text TEXT NOT NULL, filled_text TEXT,
  publishable INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX search_materials_item ON search_materials(target_item_id, created_at DESC);
CREATE TABLE search_material_sources (
  material_id TEXT NOT NULL REFERENCES search_materials(id) ON DELETE CASCADE,
  ref_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT, publisher TEXT,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL, accessible INTEGER NOT NULL DEFAULT 0,
  relevant INTEGER NOT NULL DEFAULT 0, supported INTEGER NOT NULL DEFAULT 0, evidence_text TEXT,
  PRIMARY KEY (material_id, ref_id)
);
ALTER TABLE flashes ADD COLUMN search_material_id TEXT REFERENCES search_materials(id) ON DELETE SET NULL;
`;

const M008_REPORT_CONVERSATIONS = `ALTER TABLE deep_summaries RENAME TO legacy_deep_summaries;
CREATE TABLE conversations (id TEXT PRIMARY KEY, anchor_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, lang TEXT NOT NULL, topic TEXT NOT NULL, initial_item_ids_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX conversations_anchor ON conversations(anchor_item_id, lang, updated_at DESC);
CREATE TABLE conversation_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, role TEXT NOT NULL, question TEXT, answer_json TEXT, status TEXT NOT NULL, model TEXT, request_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(conversation_id, sequence));
CREATE INDEX conversation_messages_order ON conversation_messages(conversation_id, sequence);
CREATE TABLE conversation_sources (conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, ref_id TEXT NOT NULL, item_id TEXT REFERENCES items(id) ON DELETE SET NULL, basis TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, publisher TEXT, published_at INTEGER, material_text TEXT NOT NULL, search_material_id TEXT REFERENCES search_materials(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, ref_id), UNIQUE(conversation_id, item_id));
`;

const M009_OUTSIDE_PICKS = `CREATE TABLE outside_picks (id TEXT PRIMARY KEY, edition_date TEXT NOT NULL, lang TEXT NOT NULL, mode TEXT NOT NULL, event_title TEXT NOT NULL, importance_reason TEXT NOT NULL, item_ids_json TEXT NOT NULL, suggestion_json TEXT NOT NULL, config_fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX outside_picks_current ON outside_picks(edition_date, lang, config_fingerprint, created_at DESC);`;

export const MIGRATIONS: Migration[] = [
  { name: '001_init', sql: M001_INIT },
  { name: '002_vectors', sql: M002_VECTORS },
  { name: '003_estimated_dates', sql: M003_ESTIMATED_DATES },
  { name: '004_feed_cache', sql: M004_FEED_CACHE },
  { name: '005_watch_outputs', sql: M005_WATCH_OUTPUTS },
  { name: '006_ai_runtime', sql: M006_AI_RUNTIME },
  { name: '007_search_fill', sql: M007_SEARCH_FILL },
  { name: '008_report_conversations', sql: M008_REPORT_CONVERSATIONS },
  { name: '009_outside_picks', sql: M009_OUTSIDE_PICKS }
];
