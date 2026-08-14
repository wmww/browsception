#!/usr/bin/env bash
# Reproducible engine build. Wraps the engine's own idempotent scripts
# (engine/WebkitWasm/tools/) with the fixes a fresh checkout on a current
# Arch host needs. See notes/engine-build.md for the full story.
#
# Produces: engine/WebkitWasm/build/webcore/bin/embedder.{js,wasm} (~103 MB)
# and an immutable snapshot under engine/artifacts/<stamp>/ (kept: newest 5)
# that stage-engine.mjs hardlinks into checkouts. `--snapshot-only` skips the
# build and just snapshots the current build output.
# Cost: ~9 GB WebKit clone (blobless) + ~3 GB deps/toolchain; ~12 GB total in
# third_party/. Dep tier ~40 min, WebCore ~7.4k ninja targets (~40-60 min on
# 24 threads at BIB_JOBS=12). Incremental embedder-only change: ~2-3 min.
set -euo pipefail

# Engine sources are tracked in this repo, but the build state (third_party/,
# build/ — absolute paths baked in) lives ONLY in the main checkout. Resolve
# it through the shared .git so running this from an ephemeral worktree
# builds the one shared engine tree instead of rebuilding 12 GB.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECKOUT_ROOT="$(dirname "$SCRIPT_DIR")"
MAIN_ROOT="$(dirname "$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$SCRIPT_DIR/../.git")")"
HERE="$MAIN_ROOT/engine"
mkdir -p "$HERE"
W="$HERE/WebkitWasm"
JOBS="${BIB_JOBS:-12}"

[ -f "$W/src/embedder/main.cpp" ] || { echo "ERROR: engine sources missing at $W"; exit 1; }

# Builds always compile the MAIN checkout's engine sources. If a worktree has
# local engine/ edits, building from it would silently ignore them — abort.
if [ "$CHECKOUT_ROOT" != "$MAIN_ROOT" ] && [ "${1:-}" != "--main-sources" ]; then
  for d in src tools web; do
    if ! diff -rq "$CHECKOUT_ROOT/engine/WebkitWasm/$d" "$W/$d" >/dev/null 2>&1; then
      echo "ERROR: this worktree's engine/WebkitWasm/$d differs from the main checkout's."
      echo "Builds compile the main checkout's sources — edit engine/ there instead"
      echo "(notes/worktrees.md), or pass --main-sources to build main's sources anyway."
      exit 1
    fi
  done
fi
[ "${1:-}" = "--main-sources" ] && shift

# The engine tree (sources + ninja graph) is a shared singleton — serialize
# builds across worktrees. Waits (with a note) if another build holds it.
exec 9>"$HERE/.build.lock"
if ! flock -n 9; then
  echo "==> engine busy [$(cat "$HERE/.build.owner" 2>/dev/null || echo '?')] — waiting for lock..."
  flock 9
fi
printf '%s pid=%s %s\n' "$SCRIPT_DIR" "$$" "$(date -u +%FT%TZ)" > "$HERE/.build.owner"

# Copy (not link) build output into an immutable, stamped snapshot dir; a
# later relink can rewrite build output in place, snapshots never change.
snapshot() {
  local BIN="$W/build/webcore/bin" SHA DIRTY STAMP DEST
  [ -f "$BIN/embedder.wasm" ] || { echo "nothing to snapshot ($BIN)"; return 1; }
  if cmp -s "$BIN/embedder.wasm" "$HERE/artifacts/latest/embedder.wasm" 2>/dev/null; then
    echo "snapshot unchanged — keeping $(readlink "$HERE/artifacts/latest")"
    return 0
  fi
  SHA="$(git -C "$MAIN_ROOT" log -1 --format=%h -- engine/ 2>/dev/null || echo nogit)"
  DIRTY=""
  [ -n "$(git -C "$MAIN_ROOT" status --porcelain -- engine/ 2>/dev/null)" ] && DIRTY="-dirty"
  STAMP="$(date -u +%Y%m%d-%H%M%S)-$SHA$DIRTY"
  DEST="$HERE/artifacts/$STAMP"
  mkdir -p "$DEST"
  cp "$BIN/embedder.js" "$BIN/embedder.wasm" "$DEST/"
  printf '{ "stamp": "%s", "engine_branch": "%s", "engine_sha": "%s", "engine_dirty": %s }\n' \
    "$STAMP" "$(git -C "$MAIN_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')" "$SHA" \
    "$([ -n "$DIRTY" ] && echo true || echo false)" > "$DEST/meta.json"
  ln -sfn "$STAMP" "$HERE/artifacts/latest"
  ls -1d "$HERE/artifacts"/2* 2>/dev/null | head -n -5 | xargs -r rm -rf
  echo "OK — snapshot $DEST"
}

if [ "${1:-}" = "--snapshot-only" ]; then snapshot; exit; fi

# --- 1. host toolchain fixes --------------------------------------------
# (pins live in the engine's bootstrap: WebKit webkitglib/2.52 @ aec9d2ad95,
#  Emscripten 6.0.0)
# CMake >= 4 breaks the pin (WebKitMacros.cmake:311 unquoted empty var, only
# reachable in the Emscripten port). Pin CMake 3.31 locally.
CMAKE_DIR="$HERE/cmake-3.31.7-linux-x86_64"
if [ ! -x "$CMAKE_DIR/bin/cmake" ]; then
  curl -fsSL -o "$HERE/cmake331.tar.gz" \
    https://github.com/Kitware/CMake/releases/download/v3.31.7/cmake-3.31.7-linux-x86_64.tar.gz
  tar xf "$HERE/cmake331.tar.gz" -C "$HERE" && rm "$HERE/cmake331.tar.gz"
fi
export PATH="$CMAKE_DIR/bin:$PATH"

# WebCore's generators need ruby erb; Arch's ruby no longer bundles it.
ruby -e "require 'erb'" 2>/dev/null || gem install --user-install erb

# --- 2. readiness probe: skip ALL bootstrap work once third_party is built.
#        Upstream's dep stages re-run `make install` on every invocation,
#        which freshens the mtimes of sysroot headers (ICU et al.) that every
#        WebCore object depends on — so a "no-op" bootstrap invalidates the
#        entire ninja graph (~7.4k objects, ~20 min) after a one-line
#        embedder change. Delete third_party/wasm-sysroot to force a re-run.
READY=1
[ -d "$W/third_party/WebKit/.git" ] || READY=0
[ -x "$W/third_party/emsdk/upstream/emscripten/emcc" ] || READY=0
for lib in libicuuc.a libbrotlidec.a libcrypto.a libfontconfig.a libwebp.a; do
  [ -f "$W/third_party/wasm-sysroot/lib/$lib" ] || READY=0
done

if [ "$READY" != 1 ]; then
  # --- 2a. dep-order workaround: brotli lives in ssl-tier but freetype
  #        (webcore-deps, which bootstrap runs FIRST) requires it. Run
  #        ssl-tier once up front; it builds openssl->brotli->libpsl and dies
  #        at fontconfig (missing freetype) — expected. --------------------
  if [ ! -f "$W/third_party/wasm-sysroot/lib/libbrotlidec.a" ]; then
    bash "$W/tools/bootstrap.sh" || true # gets WebKit+emsdk cloned first if needed
    bash "$W/tools/build-deps/ssl-tier.sh" || true
  fi

  # brotli's libbrotlidec.pc hides libbrotlicommon in Requires.private, which
  # non-static pkg-config resolution drops -> fontconfig fc-cache link fails in
  # a static-only sysroot. Promote it.
  PC="$W/third_party/wasm-sysroot/lib/pkgconfig/libbrotlidec.pc"
  [ -f "$PC" ] && sed -i 's/^Requires.private: libbrotlicommon/Requires: libbrotlicommon/' "$PC"

  # --- 3. full bootstrap (idempotent; now completes) --------------------
  bash "$W/tools/bootstrap.sh"
else
  echo "==> third_party ready — skipping bootstrap/dep stages (incremental build)"
fi

# --- 4. font staging for non-Debian hosts: build-webcore.sh hardcodes
#        /usr/share/fonts/truetype/dejavu/. Pre-stage from wherever the
#        DejaVu faces actually are; the script's guard then skips its copy. --
FSROOT="$W/build/embedder-fs"
SYSROOT="$W/third_party/wasm-sysroot"
if [ ! -f "$FSROOT/fonts/DejaVuSans.ttf" ]; then
  FONTDIR=""
  for d in /usr/share/fonts/truetype/dejavu /usr/share/fonts/TTF /usr/share/fonts/dejavu; do
    [ -f "$d/DejaVuSans.ttf" ] && FONTDIR="$d" && break
  done
  [ -n "$FONTDIR" ] || { echo "ERROR: DejaVu fonts not found (install ttf-dejavu)"; exit 1; }
  mkdir -p "$FSROOT/etc-fonts/conf.d" "$FSROOT/fonts"
  cp -f "$SYSROOT/etc/fonts/fonts.conf" "$FSROOT/etc-fonts/"
  for link in "$SYSROOT/etc/fonts/conf.d/"*.conf; do
    cp -f "$SYSROOT/share/fontconfig/conf.avail/$(basename "$link")" \
      "$FSROOT/etc-fonts/conf.d/" 2>/dev/null || true
  done
  for face in DejaVuSans DejaVuSans-Bold DejaVuSans-Oblique DejaVuSans-BoldOblique \
              DejaVuSerif DejaVuSerif-Bold DejaVuSerif-Italic \
              DejaVuSansMono DejaVuSansMono-Bold; do
    cp -f "$FONTDIR/$face.ttf" "$FSROOT/fonts/"
  done
fi

# --- 5. build the engine ------------------------------------------------
BIB_JOBS="$JOBS" bash "$W/tools/build-webcore.sh"
ls -lh "$W/build/webcore/bin/embedder.wasm"
echo "OK — engine at $W/build/webcore/bin/"
snapshot

# --- 6. WebKit-patch drift guard: the tracked patch is the ONLY record of
#        third_party/WebKit edits (the checkout is gitignored). Re-export and
#        warn loudly if the WebKit working tree had edits not yet captured. --
PATCH="$W/src/patches/webkit-emscripten.patch"
BEFORE="$(sha256sum "$PATCH" 2>/dev/null | cut -d' ' -f1)"
bash "$W/tools/export-webkit-patches.sh" >/dev/null
if [ "$BEFORE" != "$(sha256sum "$PATCH" | cut -d' ' -f1)" ]; then
  echo "WARNING: third_party/WebKit has edits that were NOT in the tracked patch."
  echo "         src/patches/webkit-emscripten.patch has been re-exported — review and"
  echo "         commit it, or WebKit-tree changes exist only in the 12 GB build state."
fi
echo "    stage into a checkout with: node tools/stage-engine.mjs"
