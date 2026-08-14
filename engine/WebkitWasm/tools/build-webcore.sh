#!/usr/bin/env bash
# Build WebCore (PORT=Emscripten, CLoop, Skia CPU raster) to wasm.
# Resumable: configure is skipped if build.ninja exists; ninja is incremental.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Build STATE (third_party/, build/, sysroot — absolute paths baked in) and
# the SOURCE checkout being compiled are separable: BIB_TREE is the shared
# WebkitWasm tree that owns the 12 GB build state, BIB_SRC is the checkout
# whose src/embedder gets compiled into the embedder.
# Both default to this script's own tree, so standalone use is unchanged;
# tools/build-engine.sh sets them when building a worktree's sources against
# the main checkout's build tree (notes/worktrees.md).
TREE="${BIB_TREE:-$ROOT}"
SRC="${BIB_SRC:-$ROOT}"
TP="$TREE/third_party"
SYSROOT="$TP/wasm-sysroot"
BUILD="$TREE/build/webcore"

source "$TP/emsdk/emsdk_env.sh" > /dev/null 2>&1
cd "$TREE"

# --- Embedder wasm-FS staging (fonts are load-bearing: no TTF = no text) ---
# The sysroot's etc/fonts/conf.d entries are DESTDIR-relative symlinks that
# are broken on the host, and emcc's file packager dereferences symlinks —
# stage a clean tree of REAL files for --embed-file.
FSROOT="$TREE/build/embedder-fs"
# Guard checks ALL artifacts, not just the TTF — a partial staging (TTF
# present, configs missing) must re-stage, and staging that produces an
# empty conf.d must FAIL, not print OK (Codex review).
if [ ! -f "$FSROOT/fonts/DejaVuSans.ttf" ] \
   || [ ! -f "$FSROOT/fonts/DejaVuSansMono.ttf" ] \
   || [ ! -f "$FSROOT/etc-fonts/fonts.conf" ] \
   || [ -z "$(ls "$FSROOT/etc-fonts/conf.d" 2>/dev/null)" ]; then
  rm -rf "$FSROOT"
  mkdir -p "$FSROOT/etc-fonts/conf.d" "$FSROOT/fonts"
  cp -f "$SYSROOT/etc/fonts/fonts.conf" "$FSROOT/etc-fonts/"
  for link in "$SYSROOT/etc/fonts/conf.d/"*.conf; do
    cp -f "$SYSROOT/share/fontconfig/conf.avail/$(basename "$link")" \
      "$FSROOT/etc-fonts/conf.d/" 2>/dev/null || true
  done
  # Full text-fidelity set (2026-06-10): sans alone meant fake bold/italic,
  # serif mapped to sans, and code blocks rendered proportional. ~3.7MB of
  # MEMFS for real bold/italic faces + serif + monospace.
  for face in DejaVuSans DejaVuSans-Bold DejaVuSans-Oblique DejaVuSans-BoldOblique \
              DejaVuSerif DejaVuSerif-Bold DejaVuSerif-Italic \
              DejaVuSansMono DejaVuSansMono-Bold; do
    cp -f "/usr/share/fonts/truetype/dejavu/$face.ttf" "$FSROOT/fonts/"
  done
  CONFD_COUNT=$(ls "$FSROOT/etc-fonts/conf.d" | wc -l)
  if [ "$CONFD_COUNT" -lt 1 ]; then
    echo "FONT STAGING FAILED: conf.d is empty (sysroot fontconfig broken?)"
    exit 1
  fi
  echo "FONT STAGING: OK ($CONFD_COUNT conf.d files)"
fi

# BIB_PTHREAD=0: single-threaded engine build for deployments that cannot
# ship SharedArrayBuffer (no COOP/COEP header control — static/edge hosts).
# Trade-off: the W-B1 win reverses — heavy pages peg the host tab again.
# Default ON (the daily-driver mode).
BIB_PTHREAD="${BIB_PTHREAD:-1}"
WASM_FLAGS="-msimd128"
BIB_PTHREAD_CMAKE=OFF
if [ "$BIB_PTHREAD" = 1 ]; then
  WASM_FLAGS="-msimd128 -pthread"
  BIB_PTHREAD_CMAKE=ON
fi

EMBEDDER_FLAGS=(
  -DEMSCRIPTEN_EMBEDDER_CMAKE="$SRC/src/embedder/embedder.cmake"
  -DBIB_FONTCONFIG_ETC_DIR="$FSROOT/etc-fonts"
  -DBIB_FONTS_DIR="$FSROOT/fonts"
  # Threading mode (BIB_PTHREAD=0 -> single-threaded engine for hosts that
  # cannot serve COOP/COEP, i.e. no SharedArrayBuffer). These live in the
  # cache-sync list so flipping the env var RECONFIGURES the existing cache
  # — pre-W-B1 the -pthread flags were only applied by hand, so a fresh
  # checkout silently built a tree that could not link the pthread embedder.
  # Flag change => ninja rebuilds the whole tree (~1.5-2h); use a separate
  # build dir per mode if toggling often.
  "-DCMAKE_C_FLAGS=$WASM_FLAGS"
  "-DCMAKE_CXX_FLAGS=$WASM_FLAGS"
  "-DBIB_PTHREAD=$BIB_PTHREAD_CMAKE"
)

if [ ! -f "$BUILD/build.ninja" ]; then
  emcmake cmake -S "$TP/WebKit" -B "$BUILD" -GNinja \
    -DPORT=Emscripten \
    -DCMAKE_BUILD_TYPE=Release \
    -DENABLE_JIT=OFF \
    -DENABLE_C_LOOP=ON \
    -DENABLE_STATIC_JSC=ON \
    -DUSE_SYSTEM_MALLOC=ON \
    -DICU_ROOT="$SYSROOT" \
    -DCMAKE_FIND_ROOT_PATH="$SYSROOT" \
    -DJSC_EMBED_ICU_DATA_FILE="$SYSROOT/share/icu/77.1/icudt77l.dat" \
    "${EMBEDDER_FLAGS[@]}" \
    > "$TREE/build/webcore-configure.log" 2>&1
  echo "CONFIGURE: OK"
else
  # Re-sync the embedder cache vars whenever any cached VALUE differs from
  # what this script would pass — a stale path must not survive in the
  # cache just because the variable exists (Codex review).
  NEED_RECONFIG=0
  for flag in "${EMBEDDER_FLAGS[@]}"; do
    entry="${flag#-D}" # NAME=VALUE
    name="${entry%%=*}"
    want="${entry#*=}"
    # `|| true`: a flag NEW to the cache makes rg exit 1 on no-match, which
    # set -e + pipefail would turn into a silent script death.
    have=$(rg -m1 "^${name}:" "$BUILD/CMakeCache.txt" 2>/dev/null | sed 's/^[^=]*=//' || true)
    if [ "$have" != "$want" ]; then
      NEED_RECONFIG=1
      break
    fi
  done
  if [ "$NEED_RECONFIG" = 1 ]; then
    cmake -S "$TP/WebKit" -B "$BUILD" "${EMBEDDER_FLAGS[@]}" \
      > "$TREE/build/webcore-reconfigure.log" 2>&1
    echo "RECONFIGURE (embedder vars): OK"
  fi
fi

# -k 50: keep building past failures so each run surfaces a BATCH of
# errors to fix, not just the first one.
# BIB_JOBS caps parallelism: WebCore's unified-sources TUs at -O3 -msimd128
# need ~1.2GB+ of clang RSS EACH — full nproc parallelism (~16) livelocks
# the 12G/no-swap scope in reclaim (observed 2026-06-11: 28min wall, 3min
# CPU per job, counter frozen). BIB_JOBS=6 fits comfortably.
ninja -C "$BUILD" -k 50 ${BIB_JOBS:+-j "$BIB_JOBS"} WebCore BibEmbedder > "$TREE/build/webcore-ninja.log" 2>&1 || {
  echo "NINJA FAILED — unique errors:"
  rg -n 'error:' "$TREE/build/webcore-ninja.log" | sort -t: -k4 -u | head -25
  exit 1
}
echo "NINJA: OK"
# The project package.json is "type":"module"; node must treat the
# non-modularized Emscripten output as CommonJS (tools/run-embedder.cjs).
printf '{"type":"commonjs"}\n' > "$BUILD/bin/package.json"
ls -la "$BUILD/lib/" "$BUILD/bin/" 2>/dev/null || true
