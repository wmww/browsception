#!/usr/bin/env bash
# Reproducible WebkitWasm engine build (spike 0.1 deliverable, 2026-08-10).
# Wraps upstream's own idempotent scripts with the fixes a fresh checkout on a
# current Arch host needs. See notes/engine-build.md for the full story.
#
# Produces: engine/WebkitWasm/build/webcore/bin/embedder.{js,wasm} (~103 MB)
# Cost: ~9 GB WebKit clone (blobless) + ~3 GB deps/toolchain; ~12 GB total in
# third_party/. Dep tier ~40 min, WebCore ~7.4k ninja targets (~40-60 min on
# 24 threads at BIB_JOBS=12).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/../engine" && pwd)"
W="$HERE/WebkitWasm"
JOBS="${BIB_JOBS:-12}"

# --- 0. clone (pins live in upstream's bootstrap: WebKit webkitglib/2.52
#        @ aec9d2ad95, Emscripten 6.0.0) ---------------------------------
[ -d "$W/.git" ] || git clone https://github.com/theogbob/WebkitWasm "$W"

# --- 1. host toolchain fixes --------------------------------------------
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
for lib in libicuuc.a libbrotlidec.a libcurl.a libfontconfig.a libwebp.a; do
  [ -f "$W/third_party/wasm-sysroot/lib/$lib" ] || READY=0
done

if [ "$READY" != 1 ]; then
  # --- 2a. dep-order workaround: brotli lives in curl-tier but freetype
  #        (webcore-deps, which bootstrap runs FIRST) requires it. Run
  #        curl-tier once up front; it builds openssl->nghttp2->brotli->libpsl
  #        ->curl and dies at fontconfig (missing freetype) — expected. ------
  if [ ! -f "$W/third_party/wasm-sysroot/lib/libbrotlidec.a" ]; then
    bash "$W/tools/bootstrap.sh" || true # gets WebKit+emsdk cloned first if needed
    bash "$W/tools/build-deps/curl-tier.sh" || true
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

[ -d "$W/node_modules" ] || npm --prefix "$W" install

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
