-- HTTP cache validators from the last successful download of each source.
-- Sent back as If-None-Match / If-Modified-Since so an unchanged feed costs a
-- 304 instead of a full download and parse.
ALTER TABLE sources ADD COLUMN etag TEXT;
ALTER TABLE sources ADD COLUMN last_modified TEXT;
