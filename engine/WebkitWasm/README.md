# engine/WebkitWasm

Browsception's browser engine: WebKit (WebCore + JSC CLoop, Skia CPU raster) compiled to
wasm with Emscripten, embedded WebKit1-style against internal headers. Hard fork of
[theogbob/WebkitWasm](https://github.com/theogbob/WebkitWasm) (base `825c260`, imported
squashed 2026-08-12 — see `LICENSING.md` for provenance and license status). Core seams
are ours: networking rides the extension's host-fetch bridge (`BibNetBridge`), frames
present through a shared-heap framebuffer (`bibFrame`), history/input/crash-recovery are
wired to the `bib_*` ABI (`src/abi/bib_abi.h` at the repo root, versioned with this code).

Layout:

- `src/embedder/` — the C++ embedder (Bib* clients, `main.cpp`, `embedder.cmake`, plus
  `engine-pre.js`, linked into the embedder with `--pre-js`).
- `src/patches/webkit-emscripten.patch` — cumulative diff vs the pinned upstream WebKit;
  the only tracked record of WebKit-tree edits. Regenerate with
  `tools/export-webkit-patches.sh` after touching `third_party/WebKit`.
- `tools/` — `bootstrap.sh` (fetch + build pinned WebKit/emsdk/deps into `third_party/`,
  gitignored ~12 GB), `build-webcore.sh`, `dev-server.mjs` (COOP/COEP dev harness).
- `web/` — harness-only host-page files: the `browser.html` dev harness + `bib-net.js`
  page glue, served as-is (nothing here is a build input).

Build via `bash tools/build-engine.sh` **from the repo root** (wraps bootstrap + build +
artifact snapshotting; see `notes/engine-build.md`). Build state lives only in the main
checkout — never edit or build engine sources from a worktree (`notes/worktrees.md`).
