-- Requires the sqlite-vec extension to be loaded first.
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
