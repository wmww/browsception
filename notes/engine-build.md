# Engine build reproduction (spike 0.1, 2026-08-10)

**Result: reproduced.** WebkitWasm's pthread engine builds from a fresh clone on our host
and runs: hello-demo gate PASS (exact pixel counts) in headless Chromium, and
https://example.com renders through the engine (Wisp networking, TLS in-engine,
`crossOriginIsolated: true`, rAF alive). Answers open-questions #3.

## How to build

`tools/build-engine.sh` — wraps upstream's idempotent scripts with the five fixes a
fresh checkout needs (below). Output: `engine/WebkitWasm/build/webcore/bin/embedder.{js,wasm}`.

To run their demo:
```sh
cd engine/WebkitWasm
npm run wisp &                                                  # 127.0.0.1:5001
PORT=8090 node tools/dev-server.mjs web --mount /engine=build/webcore/bin
# open http://127.0.0.1:8090/browser.html?url=https://example.com
# (headless verification: engine/gate-demo.mjs, engine/smoke-example.mjs)
```

## Pins & shape

| Thing | Value |
|---|---|
| WebkitWasm | github.com/theogbob/WebkitWasm `main` (= pthread branch; `wb1-pthread` is a stale snapshot — plans/mvp.md's reference was outdated) |
| WebKit | branch `webkitglib/2.52` @ `aec9d2ad95` (blobless clone) |
| Emscripten | 6.0.0 via emsdk (installed into `third_party/emsdk`) |
| Host CMake | **must be < 4.0** — we pin 3.31.7 locally (`engine/cmake-3.31.7-linux-x86_64/`) |
| Build config | `PORT=Emscripten`, CLoop (`ENABLE_JIT=OFF`), static JSC, pthread + `-msimd128`, Skia, curl+OpenSSL+Wisp networking |

Sizes/times on our box (24 threads, `BIB_JOBS=12`): `third_party/` 12 GB (WebKit clone
~9 GB of it), `build/` 0.5 GB; dep tier ~40 min, WebCore 7,444 ninja targets ≈ 45 min,
`embedder.wasm` **103 MB** (uncompressed, includes embedded ICU data + fonts + CA bundle).

## Five fixes a fresh clone needs (all encoded in tools/build-engine.sh)

1. **brotli ordering**: bootstrap runs webcore-deps → curl-tier, but freetype
   (webcore-deps) now `FT_REQUIRE_BROTLI=ON` while brotli is built by curl-tier.
   Fix: run curl-tier.sh once first (dies at fontconfig, expected), then bootstrap.
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

Single patch `src/patches/webkit-emscripten.patch`: 68 files, ~3.5k lines. Breakdown:
~32 files in `Source/WebCore/platform` (the port's platform glue), 7 `WTF/wtf`,
4 loader, 4 workers, 4 JSC runtime, plus the 3-file port pattern
(`OptionsEmscripten.cmake`/`PlatformEmscripten.cmake` additions) and small
accessibility/editing/crypto touches. The real port logic (embedder, Wisp bridge, host
page) lives in WebkitWasm's own `src/`, outside the WebKit tree. Tracks a WebKit
**release branch** (webkitglib/2.52), consistent with our rebase-on-tags policy.

## Our fork state

Engine changes live on branch **`browsception`** in the local engine/WebkitWasm clone
(local git only; upstream remains `main`). 1.2b (a221986): host-fetch bridge replaces
curl/wisp for resource loads; dev harness = web/browser.html + web/bib-net.js +
dev-server `/__bibproxy`. Rebuilds: `tools/build-engine.sh` (embedder-only changes are
a ~2 min compile+relink). Milestone smoke: `node tools/smoke-bridge.mjs` (real sites —
not CI).

## Relevant to Phase 1 (what we'll change)

- Networking to delete: curl 8.17 + OpenSSL 3.5 + nghttp2 + SOCKFS + wisp-js (bridge
  replaces all of it — see notes/networking.md, bridge-probe.md).
- Rendering: currently presents via WebGL2/Ganesh (`?gpu=0` forces raster — useful for
  1.3 experiments without rebuilds).
- `bib-build-config.js` stamps threading mode; host page reads it.
- Their gate/test scripts (`tools/gate*-browser-test.mjs`, `smoke-modern-site.mjs`,
  `site-diagnose.mjs`, `memwatch.mjs`) are a ready-made engine-side debug toolkit.
- RAM warning from BUILD.md is real but mild on this box: 12 jobs peaked well under
  limits; unified TUs ~1.2 GB clang RSS each.
