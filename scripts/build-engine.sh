#!/usr/bin/env bash
# Reproducible engine build. Wraps the engine's own idempotent scripts
# (engine/WebkitWasm/tools/) with the fixes a fresh checkout on a current
# Arch host needs. See notes/engine-build.md for the full story.
#
# Builds THIS checkout's engine sources (engine/WebkitWasm/src) against the MAIN
# checkout's shared build tree — so a worktree branch can carry a coupled
# engine+JS change and build it. Everything else (third_party/, the 7.4k
# WebCore objects, the ninja graph) stays shared: repointing sources rebuilds only
# the 5 embedder TUs + link. See notes/worktrees.md.
#
# Produces: engine/WebkitWasm/build/webcore/bin/embedder.{js,wasm} (~103 MB;
# the shipping plain link — bin/proxy/ with --proxy) and an immutable
# snapshot under engine/artifacts/<stamp>/ (kept: newest 12) that
# stage-engine.mjs hardlinks into checkouts.
# Cost: ~9 GB WebKit clone (blobless) + ~3 GB deps/toolchain; ~12 GB total in
# third_party/. Dep tier ~40 min, WebCore ~7.4k ninja targets (~40-60 min on
# 24 threads at BIB_JOBS=12). Incremental embedder-only change: ~2-3 min;
# "nothing changed here" (source hash matches a snapshot): seconds.
#
# The shared third_party/WebKit tree holds ONE checkout's patch at a time.
# A build that needs it takes it over automatically and losslessly: the
# previous owner's live tree edits are first captured into that owner's
# src/patches/webkit-emscripten.patch (their branch keeps their work), then
# the tree is reloaded with this checkout's patch. No coordination needed;
# two branches with divergent patches just pay ~1.5 min per switch.
#
# Flags:
#   --snapshot-only  skip the build, just snapshot the current build output
#   --sync-webkit    take over the shared WebKit tree NOW even if no build is
#                    needed — run before live-editing third_party/WebKit
#   --force          skip the "already built" fast path and run ninja anyway
#   --proxy          build + snapshot the -sPROXY_TO_PTHREAD link
#                    (bin/proxy/) instead of the shipping plain link.
#                    Snapshot stamps end in -proxy and meta.json says
#                    "link": "proxy"; stage-engine refuses them for the
#                    extension unless told otherwise.
set -euo pipefail

# Engine sources are tracked in this repo, but the build state (third_party/,
# build/ — absolute paths baked in) lives ONLY in the main checkout. Resolve
# it through the shared .git so running this from an ephemeral worktree
# builds against the one shared engine tree instead of rebuilding 12 GB.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECKOUT_ROOT="$(dirname "$SCRIPT_DIR")"
MAIN_ROOT="$(dirname "$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$SCRIPT_DIR/../.git")")"
HERE="$MAIN_ROOT/engine"
mkdir -p "$HERE"
W="$HERE/WebkitWasm"                 # shared BUILD TREE (third_party/, build/)
SRC="$CHECKOUT_ROOT/engine/WebkitWasm" # SOURCES to compile (this checkout)
JOBS="${BIB_JOBS:-12}"

SNAPSHOT_ONLY=0; SYNC_WEBKIT=0; FORCE=0; LINK=plain
for arg in "$@"; do
  case "$arg" in
    --snapshot-only) SNAPSHOT_ONLY=1 ;;
    --sync-webkit)   SYNC_WEBKIT=1 ;;
    --force)         FORCE=1 ;;
    --proxy)         LINK=proxy ;;
    *) echo "unknown flag: $arg (see the header of $0)"; exit 2 ;;
  esac
done

[ -f "$W/src/embedder/main.cpp" ] || { echo "ERROR: engine sources missing at $W"; exit 1; }
[ -f "$SRC/src/embedder/main.cpp" ] || { echo "ERROR: engine sources missing at $SRC"; exit 1; }
# This checkout's build-webcore.sh does the compiling; older copies ignore
# BIB_TREE/BIB_SRC and would try to build a 12 GB tree inside the worktree.
grep -q 'BIB_TREE' "$SRC/tools/build-webcore.sh" || {
  echo "ERROR: $SRC/tools/build-webcore.sh predates the BIB_TREE/BIB_SRC split —"
  echo "       rebase this branch onto main before building from it."; exit 1; }

# The engine build tree (ninja graph + WebKit working tree) is a shared
# singleton — serialize builds across checkouts. Waits (with a note) if
# another build holds it.
exec 9>"$HERE/.build.lock"
if ! flock -n 9; then
  echo "==> engine busy [$(cat "$HERE/.build.owner" 2>/dev/null || echo '?')] — waiting for lock..."
  flock 9
fi
printf '%s pid=%s %s\n' "$CHECKOUT_ROOT" "$$" "$(date -u +%FT%TZ)" > "$HERE/.build.owner"

# Empty (not fatal) for a missing file: pipefail + set -e would otherwise kill
# the script silently from inside a $() assignment.
sha_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || true; }

# Copy (not link) build output into an immutable, stamped snapshot dir; a
# later relink can rewrite build output in place, snapshots never change.
# meta.json identifies WHAT was built (source_hash) and from WHERE, so
# stage-engine.mjs can match an artifact to a checkout.
# The plain link lands in bin/, the proxy link in bin/proxy/ (same file
# names: the glue hard-codes the .wasm it fetches); a snapshot always holds
# embedder.{js,wasm} + bib-build-config.js, so consumers never care which.
snapshot() {
  local BIN="$W/build/webcore/bin" SHA DIRTY STAMP DEST LATEST
  [ "$LINK" = proxy ] && BIN="$BIN/proxy"
  [ -f "$BIN/embedder.wasm" ] || { echo "nothing to snapshot ($BIN/embedder.wasm)"; return 1; }
  LATEST="$HERE/artifacts/latest"
  # Dedupe on BOTH files — a pre-js-only change leaves the wasm identical.
  if cmp -s "$BIN/embedder.wasm" "$LATEST/embedder.wasm" 2>/dev/null \
     && cmp -s "$BIN/embedder.js" "$LATEST/embedder.js" 2>/dev/null; then
    echo "snapshot unchanged — keeping $(readlink "$LATEST")"
    # Same bits, different sources (comment/whitespace-only edits): record
    # this checkout's hash on the existing snapshot so staging matches it.
    node -e '
      const fs = require("node:fs"), p = process.argv[1] + "/meta.json";
      const m = JSON.parse(fs.readFileSync(p, "utf8")), h = process.argv[2];
      if (m.source_hash === h || (m.also_source_hashes ?? []).includes(h)) process.exit(0);
      m.also_source_hashes = [...(m.also_source_hashes ?? []), h];
      fs.writeFileSync(p + ".tmp", JSON.stringify(m, null, 2) + "\n");
      fs.renameSync(p + ".tmp", p); // atomic: stage-engine may be reading it
      console.log("    (also matches source_hash " + h + ")");
    ' "$(readlink -f "$LATEST")" "$SRC_HASH" 2>/dev/null || true
    return 0
  fi
  SHA="$(git -C "$CHECKOUT_ROOT" log -1 --format=%h -- engine/ 2>/dev/null || echo nogit)"
  DIRTY=""
  [ -n "$(git -C "$CHECKOUT_ROOT" status --porcelain -- engine/ 2>/dev/null)" ] && DIRTY="-dirty"
  # The checkout token makes stamps self-identifying: two worktrees on the same
  # sha with dirty sources used to produce indistinguishable names, and an A/B
  # run staged a neighbour's engine by recency (2026-08-14).
  local TOKEN; TOKEN="$(basename "$CHECKOUT_ROOT")"
  [ "$CHECKOUT_ROOT" = "$MAIN_ROOT" ] && TOKEN="main"
  STAMP="$(date -u +%Y%m%d-%H%M%S)-$SHA$DIRTY-$TOKEN"
  [ "$LINK" = proxy ] && STAMP="$STAMP-proxy"
  DEST="$HERE/artifacts/$STAMP"
  mkdir -p "$DEST"
  cp "$BIN/embedder.js" "$BIN/embedder.wasm" "$DEST/"
  # Link-mode stamp (embedder.cmake): stage-engine and the dev harness read
  # it, so it belongs in the snapshot.
  cp "$BIN/bib-build-config.js" "$DEST/" 2>/dev/null || true
  cat > "$DEST/meta.json" <<EOF
{
  "stamp": "$STAMP",
  "source_hash": "$SRC_HASH",
  "checkout": "$CHECKOUT_ROOT",
  "branch": "$(git -C "$CHECKOUT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')",
  "sha": "$SHA",
  "dirty": $([ -n "$DIRTY" ] && echo true || echo false),
  "link": "$LINK",
  "pthread": ${BIB_PTHREAD:-1},
  "webkit_patch": "$(cat "$HERE/.webkit-patch.applied" 2>/dev/null || echo unknown)"
}
EOF
  ln -sfn "$STAMP" "$LATEST"
  # Retention sized for several checkouts building in parallel; a staged copy
  # survives pruning anyway (hardlinks), and stage-engine keeps a still-matching
  # staged copy even after its snapshot is gone.
  ls -1d "$HERE/artifacts"/2* 2>/dev/null | head -n -12 | xargs -r rm -rf
  echo "OK — snapshot $DEST"
}

# --- WebKit working tree: a singleton whose only tracked record is the
#     invoking checkout's src/patches/webkit-emscripten.patch. -------------
WK="$W/third_party/WebKit"
PATCH="$SRC/src/patches/webkit-emscripten.patch"
APPLIED_F="$HERE/.webkit-patch.applied"
OWNER_F="$HERE/.webkit-patch.owner"
WK_OK=0; [ -d "$WK/.git" ] && WK_OK=1
WANT="$(sha_of "$PATCH")"
HAVE="$(cat "$APPLIED_F" 2>/dev/null || true)"

sync_webkit_tree() { # reload the shared WebKit tree with this checkout's patch
  # `git checkout` rewrites every patched file, and a bumped mtime on one
  # widely-included header costs ~1000 ninja edges even when the CONTENT is
  # unchanged (measured: 13 min for a no-op switch). So snapshot hash+mtime
  # for every file either patch touches and restore the mtimes of those that
  # come out byte-identical — a switch then costs only the patch DELTA.
  local STATE FILES RESTORED=0 TOTAL
  echo "==> reloading $WK with this checkout's patch"
  STATE="$(mktemp)"; FILES="$(mktemp)"
  { git -C "$WK" diff --name-only
    git -C "$WK" ls-files --others --exclude-standard
    sed -n 's|^+++ b/||p' "$PATCH"
  } | sort -u > "$FILES"
  while IFS= read -r f; do
    [ -f "$WK/$f" ] || continue
    printf '%s %s %s\n' "$(sha_of "$WK/$f")" "$(stat -c %Y "$WK/$f")" "$f"
  done < "$FILES" > "$STATE"

  # Mark the tree state unknown for the duration: if the patch fails to apply
  # we leave a sentinel that matches no checkout, so every build refuses (and
  # says how to recover) instead of silently compiling an unpatched tree.
  echo "sync-in-progress" > "$APPLIED_F"
  git -C "$WK" reset -q
  git -C "$WK" checkout -q -- .
  git -C "$WK" clean -qfd
  if ! git -C "$WK" apply "$PATCH"; then
    echo "ERROR: $PATCH does not apply to the pinned WebKit checkout."
    echo "       The tree is now clean/unpatched and marked broken in $APPLIED_F;"
    echo "       fix the patch and re-run with --sync-webkit."
    exit 1
  fi

  while read -r h m f; do
    [ -f "$WK/$f" ] || continue
    if [ "$(sha_of "$WK/$f")" = "$h" ]; then touch -d "@$m" "$WK/$f"; RESTORED=$((RESTORED + 1)); fi
  done < "$STATE"
  TOTAL="$(wc -l < "$STATE")"
  rm -f "$STATE" "$FILES"

  echo "$WANT" > "$APPLIED_F"
  printf '%s %s\n' "$CHECKOUT_ROOT" "$(date -u +%FT%TZ)" > "$OWNER_F"
  HAVE="$WANT"
  echo "    applied ${WANT:0:12} ($(wc -l < "$PATCH") lines, $RESTORED/$TOTAL files unchanged)"
}

take_webkit_tree() { # lossless takeover: capture the owner's work, then sync
  # The tree's live edits belong to the recorded owner. If the tree drifted
  # since that owner's last export, write the drift into the owner's patch
  # file so their branch keeps their work; if no checkout accounts for the
  # content, save a rescue patch. Only then reload with our patch.
  local LIVE LIVE_SHA OWNER_ROOT OWNER_PATCH ACCOUNTED p
  LIVE="$(mktemp)"
  git -C "$WK" add --intent-to-add --all
  git -C "$WK" diff > "$LIVE"
  LIVE_SHA="$(sha_of "$LIVE")"
  if [ -n "$HAVE" ] && [ "$LIVE_SHA" != "$HAVE" ] && [ -s "$LIVE" ]; then
    ACCOUNTED=""
    for p in "$MAIN_ROOT/engine/WebkitWasm/src/patches/webkit-emscripten.patch" \
             "$MAIN_ROOT"/.worktrees/*/engine/WebkitWasm/src/patches/webkit-emscripten.patch; do
      [ "$(sha_of "$p")" = "$LIVE_SHA" ] && ACCOUNTED=1 && break
    done
    OWNER_ROOT="$(cut -d' ' -f1 "$OWNER_F" 2>/dev/null || true)"
    OWNER_PATCH="$OWNER_ROOT/engine/WebkitWasm/src/patches/webkit-emscripten.patch"
    if [ -n "$ACCOUNTED" ]; then
      : # live content already tracked by some checkout's patch — nothing to save
    elif [ -n "$OWNER_ROOT" ] && [ -f "$OWNER_PATCH" ] \
         && [ "$(sha_of "$OWNER_PATCH")" = "$HAVE" ]; then
      cp "$LIVE" "$OWNER_PATCH"
      echo "==> captured live WebKit-tree edits into $OWNER_PATCH"
    else
      local RESCUE="$HERE/webkit-rescue-$(date -u +%Y%m%d-%H%M%S).patch"
      cp "$LIVE" "$RESCUE"
      echo "WARNING: live WebKit-tree edits match no checkout's patch (owner:"
      echo "         $(cat "$OWNER_F" 2>/dev/null || echo '?')) — saved to $RESCUE"
    fi
  fi
  rm -f "$LIVE"
  sync_webkit_tree
}

# Do we own the tree's WebKit state? (Equal patch = live edits there are ours.)
OWNED=0
if [ "$WK_OK" = 1 ]; then
  if [ -z "$HAVE" ]; then
    echo "note: no $APPLIED_F — assuming third_party/WebKit matches this checkout's patch"
    OWNED=1
  elif [ "$HAVE" = "$WANT" ]; then
    OWNED=1
  elif [ "$SYNC_WEBKIT" = 1 ]; then
    take_webkit_tree; OWNED=1
  fi
elif [ "$SYNC_WEBKIT" = 1 ]; then
  echo "note: --sync-webkit ignored — no WebKit checkout yet (bootstrap will clone + patch)"
fi

# Owning the tree means live WebKit edits are ours: capture them into THIS
# checkout's patch before hashing, so the branch carries what it builds.
if [ "$OWNED" = 1 ] && [ "$SNAPSHOT_ONLY" = 0 ]; then
  BEFORE="$WANT"
  BIB_TREE="$W" BIB_SRC="$SRC" bash "$SRC/tools/export-webkit-patches.sh" >/dev/null
  WANT="$(sha_of "$PATCH")"
  if [ -n "$BEFORE" ] && [ "$BEFORE" != "$WANT" ]; then
    echo "WARNING: third_party/WebKit has edits that were NOT in the tracked patch."
    echo "         $PATCH has been re-exported — review and"
    echo "         commit it, or WebKit-tree changes exist only in the 12 GB build state."
  fi
  echo "$WANT" > "$APPLIED_F"
  printf '%s %s\n' "$CHECKOUT_ROOT" "$(date -u +%FT%TZ)" > "$OWNER_F"
fi

SRC_HASH="$(node "$CHECKOUT_ROOT/scripts/lib/engine-src-hash.mjs" "$CHECKOUT_ROOT")"

if [ "$SNAPSHOT_ONLY" = 1 ]; then
  # The bin/ output was produced by whichever checkout built last; stamping it
  # with OUR source hash is only honest if the tree state is ours.
  [ "$OWNED" = 1 ] || { echo "ERROR: --snapshot-only but the last build was another checkout's (WebKit tree ${HAVE:0:12}); it would be stamped with this checkout's source hash. Run a real build instead."; exit 1; }
  snapshot; exit
fi

# --- fast path: an existing snapshot of THIS link mode already matches
#     these sources (meta.json without "link" predates the split: proxy) ---
MATCH=""
for d in $(ls -1d "$HERE/artifacts"/2* 2>/dev/null | sort -r); do
  [ -f "$d/embedder.wasm" ] || continue
  grep -q "\"$SRC_HASH\"" "$d/meta.json" 2>/dev/null || continue
  L="$(sed -n 's/.*"link": *"\([a-z]*\)".*/\1/p' "$d/meta.json" 2>/dev/null)"
  [ "${L:-proxy}" = "$LINK" ] || continue
  MATCH="$d"; break
done
if [ -n "$MATCH" ] && [ "$FORCE" = 0 ]; then
  echo "==> already built — snapshot $MATCH matches this checkout (source_hash $SRC_HASH)"
  if [ "$OWNED" = 0 ] && [ "$WK_OK" = 1 ]; then
    echo "    (the shared WebKit tree holds another branch's patch; harmless — nothing was built.)"
  fi
  echo "    stage into this checkout with: node scripts/stage-engine.mjs"
  echo "    (--force rebuilds anyway)"
  exit 0
fi

# A build compiles against the shared WebKit tree, so its state must be ours.
# Not ours -> take it over (lossless: the owner's work is captured first).
if [ "$WK_OK" = 1 ] && [ "$OWNED" = 0 ]; then
  echo "==> shared WebKit tree holds another checkout's patch (${HAVE:0:12}," \
       "loaded by $(cut -d' ' -f1 "$OWNER_F" 2>/dev/null || echo '?')) — taking it over"
  take_webkit_tree
  OWNED=1
fi

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
#        Bootstrap + dep scripts are the MAIN checkout's copies: they only
#        touch third_party/, so dep-tier edits are main-checkout work.
READY=1
[ -d "$WK/.git" ] || READY=0
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

  # Bootstrap applies the MAIN checkout's patch. If this checkout's differs,
  # take the fresh tree over so we build our own WebKit sources.
  if [ "$WANT" != "$(sha_of "$W/src/patches/webkit-emscripten.patch")" ]; then
    sync_webkit_tree
  else
    echo "$WANT" > "$APPLIED_F"
  fi
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

# --- 5. pick the source path to configure with ---------------------------
# Repointing EMSCRIPTEN_EMBEDDER_CMAKE at this checkout costs a reconfigure +
# the 5 embedder TUs + link (nothing in WebCore includes our src/). But if the
# cached path's checkout is still around and its sources are byte-identical to
# ours, keep it: a JS-only worktree that runs a build shouldn't churn the cache.
BUILD_SRC="$SRC"
CACHED="$(rg -m1 '^EMSCRIPTEN_EMBEDDER_CMAKE:' "$W/build/webcore/CMakeCache.txt" 2>/dev/null | sed 's/^[^=]*=//' || true)"
CACHED_ROOT="${CACHED%/engine/WebkitWasm/src/embedder/embedder.cmake}"
if [ -n "$CACHED" ] && [ "$CACHED_ROOT" != "$CACHED" ] && [ "$CACHED_ROOT" != "$CHECKOUT_ROOT" ] \
   && [ -f "$CACHED_ROOT/engine/WebkitWasm/src/embedder/main.cpp" ] \
   && [ "$SRC_HASH" = "$(node "$CHECKOUT_ROOT/scripts/lib/engine-src-hash.mjs" "$CACHED_ROOT" 2>/dev/null || true)" ]; then
  BUILD_SRC="$CACHED_ROOT/engine/WebkitWasm"
  echo "==> sources identical to the cached checkout ($CACHED_ROOT) — keeping the CMake cache"
fi

# cmake does not track --pre-js inputs (embedder.cmake caveat): stamp the
# pre-js next to the build tree and touch main.cpp when it changes, so a
# pre-js-only edit still relinks.
PRE_STAMP="$W/build/.engine-pre.sha"
PRE_NOW="$(sha_of "$BUILD_SRC/src/embedder/engine-pre.js")"
if [ "$PRE_NOW" != "$(cat "$PRE_STAMP" 2>/dev/null || true)" ]; then
  echo "==> engine-pre.js changed — touching main.cpp to force a relink"
  touch "$BUILD_SRC/src/embedder/main.cpp"
fi

# --- 6. build the engine ------------------------------------------------
BIB_PROXY="$([ "$LINK" = proxy ] && echo 1 || echo 0)" \
  BIB_JOBS="$JOBS" BIB_TREE="$W" BIB_SRC="$BUILD_SRC" bash "$SRC/tools/build-webcore.sh"
printf '%s' "$PRE_NOW" > "$PRE_STAMP"
ls -lh "$W/build/webcore/bin/$([ "$LINK" = proxy ] && echo proxy/)embedder.wasm"
echo "OK — engine at $W/build/webcore/bin/ (sources: $BUILD_SRC)"
snapshot
echo "    stage into a checkout with: node scripts/stage-engine.mjs"
