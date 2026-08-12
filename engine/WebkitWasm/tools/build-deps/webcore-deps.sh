#!/usr/bin/env bash
# Build WebCore's dependency tier for wasm32-emscripten into wasm-sysroot.
# Static libs, -O2 -pthread everywhere (pthread ABI must match the engine).
# Idempotent per-dep: skips anything already installed in the sysroot.
# Versions are deliberately conservative pins; bump later if needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TP="$ROOT/third_party"
SYSROOT="$TP/wasm-sysroot"
DEPS="$TP/build-deps"
JOBS="$(nproc)"

source "$TP/emsdk/emsdk_env.sh" > /dev/null 2>&1
export CFLAGS="-O2 -pthread" CXXFLAGS="-O2 -pthread"
mkdir -p "$DEPS" "$SYSROOT"
cd "$DEPS"

fetch() { # fetch <url> <tarball-name>
  [ -f "$2" ] || curl -fL --retry 3 -o "$2" "$1"
}

unpack() { # unpack <tarball> <dir>
  if [ ! -d "$2" ]; then mkdir "$2" && tar xf "$1" -C "$2" --strip-components=1; fi
}

cmake_build() { # cmake_build <srcdir> <builddir> [extra cmake args...]
  local src="$1" bld="$2"; shift 2
  emcmake cmake -S "$src" -B "$bld" -GNinja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
    -DCMAKE_FIND_ROOT_PATH="$SYSROOT" \
    -DBUILD_SHARED_LIBS=OFF \
    "$@" > "$bld-configure.log" 2>&1
  ninja -C "$bld" install > "$bld-build.log" 2>&1
}

echo "=== zlib ==="
if [ ! -f "$SYSROOT/lib/libz.a" ]; then
  fetch https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz zlib.tar.gz
  unpack zlib.tar.gz zlib
  cmake_build zlib zlib-build -DZLIB_BUILD_EXAMPLES=OFF
  rm -f "$SYSROOT"/lib/libz.so* 2>/dev/null || true
fi

echo "=== libpng ==="
if [ ! -f "$SYSROOT/lib/libpng.a" ] && [ ! -f "$SYSROOT/lib/libpng16.a" ]; then
  fetch https://github.com/pnggroup/libpng/archive/refs/tags/v1.6.43.tar.gz libpng.tar.gz
  unpack libpng.tar.gz libpng
  cmake_build libpng libpng-build \
    -DPNG_SHARED=OFF -DPNG_STATIC=ON -DPNG_TESTS=OFF -DPNG_TOOLS=OFF \
    -DZLIB_ROOT="$SYSROOT"
fi

echo "=== libjpeg-turbo ==="
if [ ! -f "$SYSROOT/lib/libjpeg.a" ]; then
  fetch https://github.com/libjpeg-turbo/libjpeg-turbo/archive/refs/tags/3.0.4.tar.gz libjpeg-turbo.tar.gz
  unpack libjpeg-turbo.tar.gz libjpeg-turbo
  cmake_build libjpeg-turbo libjpeg-turbo-build \
    -DWITH_SIMD=0 -DENABLE_SHARED=0 -DENABLE_STATIC=1 -DWITH_TURBOJPEG=0
fi

echo "=== libwebp ==="
if [ ! -f "$SYSROOT/lib/libwebp.a" ]; then
  fetch https://github.com/webmproject/libwebp/archive/refs/tags/v1.4.0.tar.gz libwebp.tar.gz
  unpack libwebp.tar.gz libwebp
  cmake_build libwebp libwebp-build \
    -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF -DWEBP_BUILD_DWEBP=OFF \
    -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF \
    -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=OFF -DWEBP_BUILD_EXTRAS=OFF
fi

echo "=== freetype (no harfbuzz first pass) ==="
# Brotli REQUIRED (2026-06-10): FT_CONFIG_OPTION_USE_BROTLI gives FreeType
# native WOFF2 decoding, which WebKit's WOFF2Checks detects and exposes as
# HAVE_WOFF_SUPPORT — that's how web fonts (woff2 = what every modern site
# serves) work on the Skia+FreeType font path. Brotli libs come from the
# curl tier; build order is safe because this script runs after it (and
# brotli is already in the sysroot of every existing checkout).
if [ ! -f "$SYSROOT/lib/libfreetype.a" ]; then
  fetch https://github.com/freetype/freetype/archive/refs/tags/VER-2-13-3.tar.gz freetype.tar.gz
  unpack freetype.tar.gz freetype
  # FT_DISABLE_BROTLI=OFF must be EXPLICIT: an existing freetype-build dir
  # carries the old ON in its CMakeCache, which silently wins over REQUIRE
  # and reinstalls a brotli-less library (cost one no-op rebuild to learn).
  rm -rf freetype-build
  cmake_build freetype freetype-build \
    -DFT_DISABLE_HARFBUZZ=ON -DFT_DISABLE_BZIP2=ON \
    -DFT_DISABLE_BROTLI=OFF -DFT_REQUIRE_BROTLI=ON \
    -DFT_REQUIRE_ZLIB=ON -DFT_REQUIRE_PNG=ON -DZLIB_ROOT="$SYSROOT" \
    -DBROTLIDEC_INCLUDE_DIRS="$SYSROOT/include" \
    -DBROTLIDEC_LIBRARIES="$SYSROOT/lib/libbrotlidec.a;$SYSROOT/lib/libbrotlicommon.a"
fi

echo "=== harfbuzz ==="
if [ ! -f "$SYSROOT/lib/libharfbuzz.a" ]; then
  fetch https://github.com/harfbuzz/harfbuzz/releases/download/9.0.0/harfbuzz-9.0.0.tar.xz harfbuzz.tar.xz
  unpack harfbuzz.tar.xz harfbuzz
  cmake_build harfbuzz harfbuzz-build \
    -DHB_HAVE_FREETYPE=ON -DHB_HAVE_ICU=ON -DHB_BUILD_UTILS=OFF \
    -DFREETYPE_DIR="$SYSROOT" -DICU_ROOT="$SYSROOT"
fi

echo "=== libxml2 ==="
if [ ! -f "$SYSROOT/lib/libxml2.a" ]; then
  fetch https://download.gnome.org/sources/libxml2/2.12/libxml2-2.12.9.tar.xz libxml2.tar.xz
  unpack libxml2.tar.xz libxml2
  cmake_build libxml2 libxml2-build \
    -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_LZMA=OFF -DLIBXML2_WITH_ZLIB=ON \
    -DLIBXML2_WITH_ICU=ON -DLIBXML2_WITH_TESTS=OFF -DLIBXML2_WITH_PROGRAMS=OFF \
    -DZLIB_ROOT="$SYSROOT" -DICU_ROOT="$SYSROOT"
fi

echo "=== sqlite3 ==="
if [ ! -f "$SYSROOT/lib/libsqlite3.a" ]; then
  fetch https://sqlite.org/2024/sqlite-amalgamation-3460100.zip sqlite.zip
  if [ ! -d sqlite ]; then mkdir sqlite && (cd sqlite && unzip -q ../sqlite.zip && mv sqlite-amalgamation-*/* .); fi
  (cd sqlite && emcc $CFLAGS -c sqlite3.c -o sqlite3.o \
     -DSQLITE_THREADSAFE=1 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_ENABLE_FTS5 \
   && emar rcs libsqlite3.a sqlite3.o \
   && cp libsqlite3.a "$SYSROOT/lib/" && cp sqlite3.h sqlite3ext.h "$SYSROOT/include/")
fi

echo "=== DONE — sysroot contents ==="
ls "$SYSROOT/lib/" | sort
