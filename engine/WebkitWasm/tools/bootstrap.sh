#!/usr/bin/env bash
# bootstrap.sh — recreate third_party/ for a fresh clone of BrowserInBrowser.
#
# A clone of this repo ships only our ~15 MB of source; the 11 GB engine tree
# (WebKit + emsdk + built wasm deps) is gitignored and recreated here:
#   1. clone the pinned WebKit, apply our port patch
#   2. install the pinned emsdk (Emscripten 6.0.0)
#   3. build all wasm deps into third_party/wasm-sysroot  (icu -> webcore -> curl)
# After this, tools/build-webcore.sh produces the engine.
#
# Cost: ~30-90 min (mostly the dep + WebKit fetch) and ~15 GB disk.
# Idempotent: every stage skips work that is already present, so re-running
# after an interruption resumes.  The pins below are the source of truth.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TP="$ROOT/third_party"
mkdir -p "$TP"

# --- pins ---------------------------------------------------------------
WEBKIT_URL="https://github.com/WebKit/WebKit.git"
WEBKIT_BRANCH="webkitglib/2.52"
WEBKIT_PIN="aec9d2ad958e716ab4bca4bf03007e6edac7323f"
EMSDK_URL="https://github.com/emscripten-core/emsdk.git"
EMSDK_VERSION="6.0.0"

# --- prereqs ------------------------------------------------------------
echo "==> checking host prerequisites"
missing=""
for t in git curl cmake ninja make python3 pkg-config tar xz unzip cc c++; do
  command -v "$t" >/dev/null 2>&1 || missing="$missing $t"
done
if [ -n "$missing" ]; then
  echo "ERROR: missing host tools:$missing" >&2
  echo "Install them (build-essential, cmake, ninja-build, pkg-config, xz-utils, unzip, python3) and re-run." >&2
  exit 1
fi

# --- 1. WebKit (pinned) + our port patch --------------------------------
if [ ! -d "$TP/WebKit/.git" ]; then
  echo "==> cloning WebKit ($WEBKIT_BRANCH, blobless — large, several minutes)"
  git clone --branch "$WEBKIT_BRANCH" --filter=blob:none "$WEBKIT_URL" "$TP/WebKit"
fi
echo "==> pinning WebKit @ ${WEBKIT_PIN:0:10}"
git -C "$TP/WebKit" fetch --filter=blob:none origin "$WEBKIT_PIN" >/dev/null 2>&1 || true
git -C "$TP/WebKit" checkout -q "$WEBKIT_PIN"
if git -C "$TP/WebKit" apply --check "$ROOT/src/patches/webkit-emscripten.patch" >/dev/null 2>&1; then
  git -C "$TP/WebKit" apply "$ROOT/src/patches/webkit-emscripten.patch"
  echo "    port patch applied"
else
  echo "    port patch already applied (or needs manual reconcile — see BUILD.md)"
fi

# --- 2. emsdk / Emscripten 6.0.0 ---------------------------------------
if [ ! -d "$TP/emsdk/.git" ]; then
  echo "==> cloning emsdk"
  git clone "$EMSDK_URL" "$TP/emsdk"
fi
echo "==> installing + activating Emscripten $EMSDK_VERSION"
( cd "$TP/emsdk" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION" )

# --- 3. wasm dependency tier -> third_party/wasm-sysroot ----------------
# ORDER IS LOAD-BEARING: harfbuzz/WebCore need ICU; ssl-tier's fontconfig
# needs freetype/libxml2/zlib/icu already in the sysroot (ssl-tier.sh).
echo "==> building wasm deps  (icu -> webcore-deps -> ssl-tier; each idempotent)"
bash "$ROOT/tools/build-deps/icu.sh"
bash "$ROOT/tools/build-deps/webcore-deps.sh"
bash "$ROOT/tools/build-deps/ssl-tier.sh"

# --- done ---------------------------------------------------------------
echo
echo "==> bootstrap complete. third_party/ is ready:"
echo "      WebKit  @ ${WEBKIT_PIN:0:10} (+ port patch)"
echo "      emsdk   Emscripten $EMSDK_VERSION"
echo "      sysroot $(ls "$TP/wasm-sysroot/lib"/*.a 2>/dev/null | wc -l) static libs"
echo
echo "Next — build the engine:"
echo "      bash tools/build-webcore.sh                  # engine on its own pthread (default)"
echo "      BIB_PTHREAD=0 bash tools/build-webcore.sh    # single-threaded (no SAB) build"
echo "Then serve + open: see BUILD.md"
