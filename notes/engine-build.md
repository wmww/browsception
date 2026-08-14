# Engine build reproduction (spike 0.1, 2026-08-10)

**Result: reproduced.** WebkitWasm's pthread engine builds from a fresh clone on our host
and runs: hello-demo gate PASS (exact pixel counts) in headless Chromium, and
https://example.com renders through the engine (`crossOriginIsolated: true`, rAF alive).
Answers open-questions #3. (Networking at the time was Wisp with TLS in-engine; that whole
tier was deleted 2026-08-13 — the engine's only transport is now the host-fetch bridge.)

## How to build

`tools/build-engine.sh` — wraps the engine's idempotent scripts (`engine/WebkitWasm/tools/`)
with the five fixes a fresh checkout needs (below). Output:
`engine/WebkitWasm/build/webcore/bin/embedder.{js,wasm}`, snapshotted into
`engine/artifacts/<stamp>/` (newest 5 kept; meta.json stamped with `source_hash` — the hash of
the engine sources built, `tools/lib/engine-src-hash.mjs` — plus the invoking checkout, branch,
sha, dirty, pthread) for staging. Worktree-safe: it compiles **the invoking checkout's**
`engine/WebkitWasm/{src,web/engine-pre.js}` against the main checkout's shared build tree
(`BIB_TREE`/`BIB_SRC` split in build-webcore.sh + export-webkit-patches.sh), resolves that tree
via the git common dir, and serializes concurrent builds with `engine/.build.lock`. A snapshot
whose `source_hash` already matches exits in ~0.7 s. Before building it exports
`src/patches/webkit-emscripten.patch` from the WebKit working tree (warning if it had untracked
edits) and refuses to build when another checkout's patch is loaded there (`--sync-webkit`
switches). See notes/worktrees.md § Engine work.

Dev harness (headless drivers: `tools/smoke-{browse,bridge,leak,fixtures}.mjs`):
```sh
cd engine/WebkitWasm
PORT=8090 node tools/dev-server.mjs web --mount /engine=build/webcore/bin
# open http://127.0.0.1:8090/browser.html?url=https://example.com
```

## Pins & shape

| Thing | Value |
|---|---|
| WebkitWasm | in-repo (`engine/WebkitWasm/`, hard fork of github.com/theogbob/WebkitWasm @ `825c260`, pthread build) |
| WebKit | branch `webkitglib/2.52` @ `aec9d2ad958e716ab4bca4bf03007e6edac7323f` (blobless clone; pin lives in `engine/WebkitWasm/tools/bootstrap.sh`) |
| Emscripten | 6.0.0 via emsdk (installed into `third_party/emsdk`) |
| Host CMake | **must be < 4.0** — we pin 3.31.7 locally (`engine/cmake-3.31.7-linux-x86_64/`) |
| Build config | `PORT=Emscripten`, CLoop (`ENABLE_JIT=OFF`), static JSC, pthread + `-msimd128`, Skia; networking = host-fetch bridge only (no libcurl/libssl/nghttp2; `USE_CURL=ON` still selects the port's platform types + CookieJarDB, and libcrypto stays for PAL's digests) |

Sizes/times on our box (24 threads, `BIB_JOBS=12`): `third_party/` 12 GB (WebKit clone
~9 GB of it), `build/` 0.5 GB; dep tier ~40 min, WebCore 7,444 ninja targets ≈ 45 min,
`embedder.wasm` **100 MB** / 104,110,338 B (uncompressed, includes embedded ICU data +
fonts). Was 107,490,338 B before the curl/wisp cut (2026-08-13) — **−3.38 MB / −3.1%**
from dropping libcurl + libssl + nghttp2 + the embedded CA bundle.

Rebuild-cost warning learned in that cut: `platform/network/curl/ResourceResponse.h` and
`ResourceError.h` are not transport files — under `USE(CURL)` they ARE the port's
`<WebCore/ResourceResponse.h>`/`ResourceError.h`, copied into `build/webcore/WebCore/
PrivateHeaders/` and included by most of WebCore. Editing either costs ~876 TUs (~2 h),
not the ~90 s embedder loop. Same for `NetworkStorageSession.h`, `CertificateInfo.h`,
`AuthenticationChallenge.h`.

## Five fixes a fresh clone needs (all encoded in tools/build-engine.sh)

1. **brotli ordering**: bootstrap runs webcore-deps → ssl-tier, but freetype
   (webcore-deps) now `FT_REQUIRE_BROTLI=ON` while brotli is built by ssl-tier.
   Fix: run ssl-tier.sh once first (dies at fontconfig, expected), then bootstrap.
2. **libbrotlidec.pc**: declares libbrotlicommon only in `Requires.private` → dropped by
   non-static pkg-config → fc-cache link failure in a static-only sysroot. Promote to
   `Requires:`.
3. **DejaVu font paths**: build-webcore.sh hardcodes Debian's
   `/usr/share/fonts/truetype/dejavu/`; pre-stage `build/embedder-fs/` from the host's
   actual font dir (Arch: `/usr/share/fonts/TTF`).
4. **CMake 4 incompatibility**: `WebKitMacros.cmake:311` unquoted empty `${_linked_into}`
   — only the Emscripten port leaves that property unset; CMake ≤3.x tolerated it.
   Use CMake 3.31.
5. **ruby erb**: Arch's ruby 3.4 unbundles `erb`; WebCore generators need it →
   `gem install --user-install erb`.

1–2 are upstream fresh-bootstrap bugs (their tree predates freetype-with-brotli);
3–5 are host-environment assumptions. All worth reporting upstream.

## Divergences from upstream WebKit

Single patch `src/patches/webkit-emscripten.patch`: 68 files, ~3.2k lines (was 68/~3.5k
before the curl cut — deleting the transport files took their patch hunks with them).
Breakdown: 31 files in `Source/WebCore/platform` (the port's platform glue), 7 `Source/WTF`,
7 `Source/JavaScriptCore`, 5 loader (three of them behavioural: the relaxed
`Empty*Client` finals, plus the two "a refused navigation tells nobody" notifications in
FrameLoader/DocumentLoader — networking.md), 4 workers, 3 accessibility, 2 Modules, plus the
port pattern (`OptionsEmscripten.cmake`/`PlatformEmscripten.cmake` additions) and small
editing/crypto/bindings/fileapi touches. The real port logic (embedder, net bridge, host
page) lives in WebkitWasm's own `src/`, outside the WebKit tree. Tracks a WebKit
**release branch** (webkitglib/2.52), consistent with our rebase-on-tags policy.

## Fork state

engine/WebkitWasm is a squashed hard-fork import into this repo (2026-08-12; provenance
in engine/WebkitWasm/LICENSING.md — upstream base `825c260`, our pre-import head
`af6f559`, no inner git anymore). The host-fetch bridge is the only transport — the curl/wisp
tier was deleted from the code, the link and the dep tier on 2026-08-13; dev harness =
web/browser.html + web/bib-net.js + dev-server `/__bibproxy`.
Rebuilds: `tools/build-engine.sh` (embedder-only changes are a ~1.5 min compile+relink, from
any checkout — engine work belongs on the branch that needs it; worktrees.md).
Milestone smoke: `node tools/smoke-bridge.mjs` (real sites — not CI); its cookie case rides
dev-server `/cookie-test/redirect-set` → 302 + `Set-Cookie` → `/cookie-test/echo`, which echoes
the `Cookie` it received (green 2026-08-13). All smokes run THIS checkout's harness and engine
(`tools/lib/dev-harness.mjs`; worktrees.md § Smokes). Build RAM is mild on this box: 12 jobs
fine; unified TUs ~1.2 GB clang RSS each.

## Build traps & pin rationale (distilled from fork docs at import)

- **Pins' source of truth is `engine/WebkitWasm/tools/bootstrap.sh`** (`WEBKIT_BRANCH`,
  `WEBKIT_PIN`, `EMSDK_VERSION`).
- **Why we self-build all ~16 deps** instead of emscripten-ports: ports ship ICU 68.2 (WebKit
  hard floor is 70.1, enforced in OptionsJSCOnly.cmake), HarfBuzz 3.2.0 (2021), and IJG jpeg 9f
  instead of libjpeg-turbo.
- **Never use webkitgtk release tarballs** for WebKit source — GTK/WPE-filtered, they drop the
  Win/PlayStation/curl files the port pattern is modeled on. Full monorepo git checkout only.
- **Link flags**: `-sSTACK_SIZE=8MB` is mandatory (64 KB default = instant empty-message
  StackOverflowError on any JSC op). `INITIAL_MEMORY=256MB` vs ~531 MB actually used on heavy
  sites → growth lands mid-critical-path (consider raising). `MAXIMUM_MEMORY=4GB` + shared
  memory reserves the whole 4 GB SAB at instantiation — can fail; 2 GB fallback.
- **wasm32 is Darwin-like: `size_t` = `unsigned long`**, exposing gaps LP64 hides (missing
  `Coder<unsigned long>`, `parse<Size>`, roundeven, RawHex). Expect this error class on uprevs.
- **offlineasm offset extractor** must scan the `.wasm` (not the `.js` stub) and be linked `-O0`
  (Binaryen memory packing trims zero-tail segments and silently breaks extraction).
- **ICU cross-compile**: force-overwrite `mh-unknown` stub with `mh-linux`; static data packaging
  impossible under wasm (genccode emits ELF) → archive packaging, embed the `.dat` at ICU's
  compiled-in absolute path.
- **Fontconfig cannot be patched out** (FontCacheSkia + vendored skia CMake REQUIRE it). Runtime:
  `/etc/fonts` staged and `/var/cache/fontconfig` writable in MEMFS or no text paints. WOFF2 web
  fonts need FreeType built WITH brotli, or all web fonts silently fall back. brotli and
  fontconfig are why the dep tier outlived libcurl: `ssl-tier.sh` (ex `curl-tier.sh`) still
  builds openssl → brotli → libpsl → fontconfig, and that ordering vs freetype is load-bearing.
- **Silent traps**: `WEBKIT_OPTION_DEFAULT_PORT_VALUE` changes only apply to a *fresh* CMake
  cache (verify via cmakeconfig.h or pass `-D` explicitly); stale dep-build CMakeCaches likewise
  pin old options (remove the dep build dir). New embedder `.cpp` must `#include "config.h"`
  first (else FastMalloc mismatch). `-Wundefined-inline` in 2.52 = missing `*Inlines.h` include.
  Wide ninja rebuilds can OOM-kill em++ showing only warnings — re-run; the wasm link step
  transiently spikes multiple GB (worse with `-g`).
- **Flipping `BIB_PTHREAD` changes compile flags → full recompile (~1.5–2 h)**; keep a separate
  build dir per mode if the single-thread Firefox fallback comes back. Hard-reload the browser
  after rebuilds (the ~100 MB wasm caches aggressively).

## Incremental builds (fix 6, 2026-08-10)

Upstream bootstrap's dep stages `make install` unconditionally, freshening
wasm-sysroot header mtimes (ICU et al.) that every WebCore object depfile
references — so re-running build-engine.sh invalidated the whole ninja graph
(~7.4k objects, 15–20 min) after any one-line embedder change. build-engine.sh
now probes third_party readiness (WebKit checkout, emcc, five sysroot libs)
and skips bootstrap entirely when ready; a one-file embedder change is then
compile+relink (~1.5 min, 7 ninja edges). `rm -rf third_party/wasm-sysroot` forces the
full path. Caveat: headers under Source/WebCore (e.g. EmptyFrameLoaderClient.h)
are legitimately wide — touching one still costs a broad rebuild; so does anything that
freshens WebKit-tree mtimes (why `--sync-webkit` restores them for files the switch leaves
unchanged: 960 ninja edges / 13 min vs 9 edges / 1.5 min, measured 2026-08-13).

cmake does not track `--pre-js` inputs: build-engine.sh stamps `sha256(web/engine-pre.js)` at
`build/.engine-pre.sha` and touches `main.cpp` when it changes, so a pre-js-only edit relinks.
