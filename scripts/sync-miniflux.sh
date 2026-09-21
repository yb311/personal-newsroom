#!/bin/bash
# Copies Miniflux's feed-reading packages into native/reader/third_party/miniflux.
#
# Miniflux keeps them under internal/, which Go forbids importing from another
# module, so they are copied rather than depended on. Files are taken verbatim
# (tests included); only import paths are rewritten. The few Miniflux packages
# they reach into that we do not want (config, locale, mediaproxy) are replaced
# by small hand-written stand-ins that live next to the copies and are NOT
# touched by this script. Files under native/reader/_overlay/miniflux are copied
# on top afterwards: they add exports and are kept out of the synced tree.
#
#   scripts/sync-miniflux.sh <path-to-miniflux-checkout>
set -euo pipefail
SRC="${1:?path to a miniflux/v2 checkout}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/native/reader/third_party/miniflux"
MODULE="github.com/yb311/personal-newsroom/native/reader/third_party/miniflux"

READER_PKGS="parser rss atom rdf json xml date dublincore media itunes googleplay language
             encoding fetcher sanitizer scraper rewrite urlcleaner readability readingtime"
OTHER_PKGS="crypto urllib proxyrotator timezone"
MODEL_FILES="entry.go enclosure.go feed.go category.go icon.go user.go"

for p in $READER_PKGS; do rm -rf "$DEST/reader/$p"; mkdir -p "$DEST/reader"; cp -R "$SRC/internal/reader/$p" "$DEST/reader/$p"; done
for p in $OTHER_PKGS;  do rm -rf "$DEST/$p"; cp -R "$SRC/internal/$p" "$DEST/$p"; done
rm -rf "$DEST/model"; mkdir -p "$DEST/model"
for f in $MODEL_FILES; do cp "$SRC/internal/model/$f" "$DEST/model/$f"; done

# miniflux.app/v2/internal/x  ->  <our module>/third_party/miniflux/x
find "$DEST" -name '*.go' -print0 | xargs -0 sed -i '' \
  -e "s#\"miniflux.app/v2/internal/#\"$MODULE/#g" \
  -e "s#// import \"miniflux.app/v2/internal/[^\"]*\"##"

# Project additions that need Miniflux internals (see each file's header).
cp -R "$ROOT/native/reader/_overlay/miniflux/." "$DEST/"

cp "$SRC/LICENSE" "$DEST/LICENSE"
( cd "$SRC" && git log -1 --format='miniflux/v2 %H (%cd)' ) > "$DEST/UPSTREAM"
echo "synced from $(cat "$DEST/UPSTREAM")"
