#!/bin/bash
# Builds the social-sources pack: RSSHub plus its dependency tree, as one
# versioned archive published alongside a release.
#
# It is distributed separately from the app rather than inside it — see
# packages/feed/src/rsshub-pack.ts for why — and this script is what produces
# the artifact that installPack() downloads.
set -euo pipefail
OUT="${1:-$PWD/build/rsshub-pack}"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

echo "→ 安装 rsshub 到临时目录"
mkdir -p "$STAGE"
(cd "$STAGE" && npm init -y >/dev/null && npm i rsshub --omit=dev --no-audit --no-fund >/dev/null 2>&1)

VERSION=$(node -p "require('$STAGE/node_modules/rsshub/package.json').version")
echo "→ rsshub@$VERSION"

echo "→ 剔除遥测"
# @sentry is pure telemetry: nothing in RSSHub needs it to work, and shipping
# crash reporting inside a local-first app contradicts the whole premise.
#
# Nothing else is removed, verified by measurement rather than by guessing:
#   @opentelemetry  required — init() throws without it
#   youtubei.js     init() survives, but YouTube routes then fail at call time
#   patchright      init() survives, but browser-backed routes fail at call time
# The last two would turn a route's real problem ("this one needs a browser")
# into "module not found", which is a worse thing to show someone.
rm -rf "$STAGE/node_modules/@sentry" 2>/dev/null || true
BEFORE=$(du -sk "$STAGE/node_modules" | cut -f1)

mkdir -p "$OUT"
TARBALL="$OUT/rsshub-pack-$VERSION.tar.gz"
echo "→ 打包"
(cd "$STAGE" && /usr/bin/tar -czf "$TARBALL" node_modules)

SHA=$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)
SIZE=$(wc -c < "$TARBALL" | tr -d ' ')
cat > "$OUT/manifest.json" <<JSON
{
  "version": "$VERSION",
  "url": "https://github.com/yb311/personal-newsroom/releases/download/rsshub-pack-$VERSION/rsshub-pack-$VERSION.tar.gz",
  "sha256": "$SHA",
  "bytes": $((BEFORE * 1024))
}
JSON

echo
echo "  归档   $TARBALL"
echo "  压缩后 $((SIZE / 1024 / 1024)) MB · 解压后 $((BEFORE / 1024)) MB"
echo "  sha256 $SHA"
echo "  清单   $OUT/manifest.json"
echo
echo "把归档上传到 GitHub Release（tag: rsshub-pack-$VERSION），manifest.json 随应用发布。"
