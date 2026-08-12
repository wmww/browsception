#!/usr/bin/env bash
# Build ICU for wasm32-emscripten (static libs, ARCHIVE data packaging —
# static packaging is impossible: genccode needs ELF objects to emit
# matching assembly, and wasm objects are not ELF. The icudt*.dat archive
# gets preloaded into the Emscripten FS at runtime instead).
# ICU cross-builds need host tools first; this does host pass then wasm pass.
# Idempotent: completed stages are skipped on rerun.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TP="$ROOT/third_party"
SYSROOT="$TP/wasm-sysroot"
DEPS="$TP/build-deps"

ICU_RELEASE="release-77-1"
ICU_TGZ="icu4c-77_1-src.tgz"
ICU_URL="https://github.com/unicode-org/icu/releases/download/$ICU_RELEASE/$ICU_TGZ"

source "$TP/emsdk/emsdk_env.sh" > /dev/null 2>&1
mkdir -p "$DEPS" "$SYSROOT"
cd "$DEPS"

echo "=== stage: fetch ==="
if [ ! -f "$ICU_TGZ" ]; then
  curl -fL --retry 3 -o "$ICU_TGZ" "$ICU_URL"
fi
if [ ! -d icu ]; then
  mkdir icu && tar xzf "$ICU_TGZ" -C icu --strip-components=1
fi
# ICU has no real platform fragment for wasm32-emscripten; it ships
# mh-unknown as a stub whose recipe just errors out. mh-linux works as-is
# under emconfigure/emmake, so force-overwrite the stub.
cp -f icu/source/config/mh-linux icu/source/config/mh-unknown

echo "=== stage: host build (tools for cross-compile) ==="
mkdir -p icu-host
cd icu-host
if [ ! -f bin/pkgdata ]; then
  ../icu/source/runConfigureICU Linux \
    --disable-tests --disable-samples > configure-host.log 2>&1
  make -j"$(nproc)" > make-host.log 2>&1
fi
cd ..

echo "=== stage: wasm build ==="
mkdir -p icu-wasm
cd icu-wasm
if [ ! -f Makefile ]; then
  # -pthread everywhere: objects linked into a pthread app must share the ABI
  CFLAGS="-O2 -pthread" CXXFLAGS="-O2 -pthread" \
  emconfigure ../icu/source/configure \
    --host=wasm32-unknown-emscripten \
    --with-cross-build="$DEPS/icu-host" \
    --enable-static --disable-shared \
    --disable-tests --disable-samples --disable-extras --disable-tools \
    --disable-dyload \
    --with-data-packaging=archive \
    --prefix="$SYSROOT" > configure-wasm.log 2>&1
fi
emmake make -j"$(nproc)" > make-wasm.log 2>&1
emmake make install > install-wasm.log 2>&1
cd ..

echo "=== done ==="
ls -la "$SYSROOT/lib/" | rg 'icu' || ls -la "$SYSROOT/lib/"
echo "ICU $ICU_RELEASE installed to $SYSROOT"
