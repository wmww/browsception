#!/usr/bin/env bash
# Build the release packages from a source tree (a clean clone or the source
# archive uploaded to AMO) on Ubuntu 24.04 with Node 24 — the environment AMO
# reviewers rebuild in. The Dockerfile at the repo root runs exactly this.
#
#   bash scripts/build-from-source.sh [--install-deps|--deps-only] [chrome|firefox|all]
#
# --install-deps  apt-get the host packages below first (needs root/sudo;
#                 Node 24 is assumed present — the Dockerfile installs it).
# --deps-only     just that, no build (the Dockerfile's image step).
#
# Output: dist/browsception-<v>-{chrome.zip,firefox.xpi} + their sha256.
# Cost: ~12 GB disk, network for the pinned fetches (WebKit, emsdk, cmake,
# dep tarballs — see notes/distribution.md § Channel 3), several hours at
# BIB_JOBS=6. BIB_JOBS (default 6 here) caps compile parallelism: each
# WebCore TU needs ~1.2 GB RSS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

INSTALL=0; TARGET=all
for arg in "$@"; do
  case "$arg" in
    --install-deps) INSTALL=1 ;;
    --deps-only)    INSTALL=2 ;;
    chrome|firefox|all) TARGET="$arg" ;;
    *) echo "usage: $0 [--install-deps|--deps-only] [chrome|firefox|all]"; exit 2 ;;
  esac
done

# Host tools. The wasm toolchain (Emscripten), CMake 3.31.7 and every wasm
# dependency are fetched at pinned versions by the build itself; these only
# run generators and the ICU host build.
PKGS=(ca-certificates git curl xz-utils unzip build-essential ninja-build
  pkg-config python3 perl ruby gperf unifdef ripgrep bzip2)
if [ "$INSTALL" != 0 ]; then
  SUDO=""; [ "$(id -u)" = 0 ] || SUDO=sudo
  $SUDO apt-get update
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y --no-install-recommends "${PKGS[@]}"
  [ "$INSTALL" = 2 ] && exit 0
fi

node -e 'if (+process.versions.node.split(".")[0] < 24) { console.error("Node >= 24 required, have " + process.version); process.exit(1); }'

npm ci
BIB_JOBS="${BIB_JOBS:-6}" node scripts/release.mjs "$TARGET"
echo
(cd dist && sha256sum browsception-*)
