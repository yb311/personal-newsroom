-- Some upstreams (several RSSHub routes, a few sitemaps) publish items with no
-- date at all. Dropping those silently loses whole sources; inventing a date
-- would be worse. So the item is kept with the time we first saw it, and this
-- flag records that the timestamp is a discovery time, not a publication time.
-- The reader shows "发现于" rather than "发布于" for these.
ALTER TABLE items ADD COLUMN date_estimated INTEGER NOT NULL DEFAULT 0;
