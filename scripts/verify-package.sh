#!/bin/bash
# Checks a packaged 所闻.app beyond what codesign sees: the reader core answers,
# the wake daemon plans a wake,
# every launch agent points at a program that exists, and the background worker
# ( 所闻 后台更新 ) starts as Node and finds worker.cjs inside the app archive.
# Used by CI on the unsigned build and by the release workflow on the signed one.
#
#   scripts/verify-package.sh "release/mac-arm64/所闻.app"
set -euo pipefail
shopt -s nullglob
app="${1:?usage: verify-package.sh <path to 所闻.app>}"
contents="$app/Contents"

reader="$contents/Resources/bin/pnr-reader"
printf '%s\n' '{"id":1,"method":"ping","params":{}}' | "$reader" | grep -q '"result":"pong"'
echo "reader core: ok"

# The wake daemon: one plist, pointing at pnr-wake, which plans without booking.
daemons=("$contents/Library/LaunchDaemons/"*.plist)
[[ ${#daemons[@]} -eq 1 ]] || { echo "::error::expected 1 launch daemon, found ${#daemons[@]}"; exit 1; }
wake="$app/$(/usr/bin/plutil -extract BundleProgram raw -o - "${daemons[0]}")"
[[ -x "$wake" ]] || { echo "::error::$(basename "${daemons[0]}"): BundleProgram is missing"; exit 1; }
conf="$(mktemp)"; printf '1 7\n' > "$conf"
[[ "$("$wake" --plan "$conf" "$(date +%s)")" =~ ^[0-9]+$ ]] || { echo "::error::pnr-wake does not plan a wake"; exit 1; }
rm -f "$conf"
echo "$(basename "${daemons[0]}"): ok"


agents=("$contents/Library/LaunchAgents/"*.plist)
[[ ${#agents[@]} -eq 1 ]] || { echo "::error::expected 1 launch agent, found ${#agents[@]}"; exit 1; }
for plist in "${agents[@]}"; do
  program="$(/usr/bin/plutil -extract BundleProgram raw -o - "$plist")"
  [[ -x "$app/$program" ]] || { echo "::error::$(basename "$plist"): BundleProgram $program is missing"; exit 1; }
  script="$(/usr/bin/plutil -extract ProgramArguments.2 raw -o - "$plist")"
  # Run the agent's own program and loader line, with the worker replaced by an
  # existence check: nothing is fetched or written.
  check="${script/require(/require('node:fs').accessSync(}"
  ELECTRON_RUN_AS_NODE=1 "$app/$program" -e "$check" \
    || { echo "::error::$(basename "$plist"): the worker does not start"; exit 1; }
  echo "$(basename "$plist"): ok ($program)"
done
