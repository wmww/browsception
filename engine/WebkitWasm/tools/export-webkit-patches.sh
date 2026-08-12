#!/usr/bin/env bash
# Export all local modifications to the pinned WebKit checkout as one
# cumulative patch in src/patches/. Run after every WebKit source fix.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/src/patches"
# intent-to-add so NEW files (e.g. the PORT=Emscripten port files) appear in
# the diff; plain `git diff` only shows modifications to tracked files.
git -C "$ROOT/third_party/WebKit" add --intent-to-add --all
git -C "$ROOT/third_party/WebKit" diff > "$ROOT/src/patches/webkit-emscripten.patch"
wc -l "$ROOT/src/patches/webkit-emscripten.patch"
