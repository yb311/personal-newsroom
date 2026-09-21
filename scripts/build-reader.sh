#!/bin/bash
# Builds the reader core (native/reader) into native/reader/bin/pnr-reader.
#
# The app finds it there during development; packaging copies it into the
# app bundle's Resources/bin. Only the Go toolchain is needed, not Xcode.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/native/reader"
# Built for the Mac it runs on; the packaged app is arm64-only (see package:mac).
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o bin/pnr-reader ./cmd/pnr-reader
echo "built $(du -h bin/pnr-reader | cut -f1) native/reader/bin/pnr-reader"
