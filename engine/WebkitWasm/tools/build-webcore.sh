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
# scripts/build-engine.sh sets them when building a worktree's sources against
# the main checkout's build tree (notes/worktrees.md).
TREE="$(cd "${BIB_TREE:-$ROOT}" && pwd -P)" # canonical: -ffile-prefix-map matches it literally
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
# The faces come from the pinned upstream DejaVu release, never the host:
# distros rebuild or patch DejaVu (Arch ships a git snapshot, Ubuntu splits
# the obliques into -extra), and these bytes land in embedder.wasm, so a
# host copy makes the build unreproducible elsewhere.
FSROOT="$TREE/build/embedder-fs"
DEJAVU_URL="https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2"
DEJAVU_SHA256="fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7"
# Guard checks ALL artifacts, not just the TTF — a partial staging (TTF
# present, configs missing) must re-stage, and staging that produces an
# empty conf.d must FAIL, not print OK (Codex review). The stamp re-stages
# trees staged from host fonts before the pin.
if [ "$(cat "$FSROOT/.fonts-sha256" 2>/dev/null)" != "$DEJAVU_SHA256" ] \
   || [ ! -f "$FSROOT/fonts/DejaVuSansMono.ttf" ] \
   || [ ! -f "$FSROOT/etc-fonts/fonts.conf" ] \
   || [ -z "$(ls "$FSROOT/etc-fonts/conf.d" 2>/dev/null)" ]; then
  DEJAVU_TAR="$TP/build-deps/$(basename "$DEJAVU_URL")"
  mkdir -p "$TP/build-deps"
  [ -f "$DEJAVU_TAR" ] || curl -fL --retry 3 -o "$DEJAVU_TAR" "$DEJAVU_URL"
  echo "$DEJAVU_SHA256  $DEJAVU_TAR" | sha256sum -c --quiet - \
    || { echo "FONT STAGING FAILED: $DEJAVU_TAR checksum mismatch"; exit 1; }
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
  FACES=()
  for face in DejaVuSans DejaVuSans-Bold DejaVuSans-Oblique DejaVuSans-BoldOblique \
              DejaVuSerif DejaVuSerif-Bold DejaVuSerif-Italic \
              DejaVuSansMono DejaVuSansMono-Bold; do
    FACES+=("dejavu-fonts-ttf-2.37/ttf/$face.ttf")
  done
  tar -xjf "$DEJAVU_TAR" -C "$FSROOT/fonts" --strip-components=2 "${FACES[@]}"
  CONFD_COUNT=$(ls "$FSROOT/etc-fonts/conf.d" | wc -l)
  if [ "$CONFD_COUNT" -lt 1 ]; then
    echo "FONT STAGING FAILED: conf.d is empty (sysroot fontconfig broken?)"
    exit 1
  fi
  echo "$DEJAVU_SHA256" > "$FSROOT/.fonts-sha256"
  # --embed-file inputs are not link dependencies: drop the link outputs so
  # ninja relinks with the new tree.
  rm -f "$BUILD"/bin/embedder.{js,wasm} "$BUILD"/bin/proxy/embedder.{js,wasm}
  echo "FONT STAGING: OK ($CONFD_COUNT conf.d files)"
fi

# BIB_PTHREAD: whether the TREE compiles -pthread. Stays 1: the shipping
# (plain, no-SAB) link and the proxy link are both produced from a
# -pthread-compiled tree — link mode is a per-target property in
# src/embedder/embedder.cmake, not a compile flag. Flipping this is a full
# recompile (~1.5-2h) for nothing.
BIB_PTHREAD="${BIB_PTHREAD:-1}"
# -ffile-prefix-map: __FILE__ and __PRETTY_FUNCTION__'s "(lambda at …)"
# otherwise embed ~1.4k absolute paths, so the wasm depends on where the
# tree lives. Paths become tree-relative.
WASM_FLAGS="-msimd128 -ffile-prefix-map=$TREE/="
BIB_PTHREAD_CMAKE=OFF
if [ "$BIB_PTHREAD" = 1 ]; then
  WASM_FLAGS="$WASM_FLAGS -pthread"
  BIB_PTHREAD_CMAKE=ON
fi

EMBEDDER_FLAGS=(
  -DEMSCRIPTEN_EMBEDDER_CMAKE="$SRC/src/embedder/embedder.cmake"
  -DBIB_FONTCONFIG_ETC_DIR="$FSROOT/etc-fonts"
  -DBIB_FONTS_DIR="$FSROOT/fonts"
  # Tree compile flags. These live in the cache-sync list so flipping the
  # env var RECONFIGURES the existing cache — pre-W-B1 the -pthread flags
  # were only applied by hand, so a fresh checkout silently built a tree
  # that could not link the proxy embedder. Flag change => ninja rebuilds
  # the whole tree (~1.5-2h).
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
# Link targets (embedder.cmake): BibEmbedder is the shipping plain link;
# BIB_PROXY=1 builds the -sPROXY_TO_PTHREAD link instead (bin/proxy/,
# EXCLUDE_FROM_ALL — never built by accident).
TARGET=BibEmbedder
[ "${BIB_PROXY:-0}" = 1 ] && TARGET=BibEmbedderProxy
# Pins __DATE__/__TIME__/__TIMESTAMP__ (clang honors it): JSC's bytecode
# cache version hashes __TIMESTAMP__, the source file's mtime, which differs
# per clone. Env isn't a ninja input: touch a TU to apply a change to it.
export SOURCE_DATE_EPOCH=0
ninja -C "$BUILD" -k 50 ${BIB_JOBS:+-j "$BIB_JOBS"} WebCore "$TARGET" > "$TREE/build/webcore-ninja.log" 2>&1 || {
  echo "NINJA FAILED — unique errors:"
  rg -n 'error:' "$TREE/build/webcore-ninja.log" | sort -t: -k4 -u | head -25
  exit 1
}
echo "NINJA: OK"
# The project package.json is "type":"module"; node must treat the
# non-modularized Emscripten output as CommonJS (tools/run-embedder.cjs).
printf '{"type":"commonjs"}\n' > "$BUILD/bin/package.json"
ls -la "$BUILD/lib/" "$BUILD/bin/" 2>/dev/null || true
