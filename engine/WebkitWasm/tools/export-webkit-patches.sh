#!/usr/bin/env bash
# Export all local modifications to the pinned WebKit checkout as one
# cumulative patch in src/patches/. Run after every WebKit source fix.
#
# BIB_TREE = the checkout that owns third_party/WebKit (the build state);
# BIB_SRC  = the checkout whose src/patches/ receives the patch. Both default
# to this script's own tree, so standalone use is unchanged; build-engine.sh
# sets them so a worktree's branch carries the patch it built with.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TREE="${BIB_TREE:-$ROOT}"
SRC="${BIB_SRC:-$ROOT}"
mkdir -p "$SRC/src/patches"
# intent-to-add so NEW files (e.g. the PORT=Emscripten port files) appear in
# the diff; plain `git diff` only shows modifications to tracked files.
git -C "$TREE/third_party/WebKit" add --intent-to-add --all
git -C "$TREE/third_party/WebKit" diff > "$SRC/src/patches/webkit-emscripten.patch"
wc -l "$SRC/src/patches/webkit-emscripten.patch"
