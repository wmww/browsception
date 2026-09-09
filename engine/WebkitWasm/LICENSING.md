# Licensing notes (engine/WebkitWasm)

## Provenance

Squashed hard-fork import of [theogbob/WebkitWasm](https://github.com/theogbob/WebkitWasm):

- Upstream base: `825c260c03bb2bd84f10fd1ebcda63660d9200ec` (upstream `main`).
- Imported 2026-08-12 from our fork branch head `af6f559fa3bd334c89df03ef191714db57fbe932`
  (8 fork commits, history not preserved).
- Rewritten since the fork: networking (curl/wisp transport deleted outright and replaced
  by the host-fetch bridge, `BibNetBridge`), presentation (runtime-sized shared-heap framebuffer /
  `bibFrame`), history/back-forward, input, crash & heartbeat recovery, plus pruning of
  upstream docs/spikes/gates at import time.

## Status: settled

Upstream published a **BSD-2-Clause** grant on 2026-08-18
([`68c6185`](https://github.com/theogbob/WebkitWasm/commit/68c61854), replacing their
`LICENSING.md`, in response to
[theogbob/WebkitWasm#1](https://github.com/theogbob/WebkitWasm/issues/1) — never answered
in-thread). It is a grant by the sole copyright holder on that repo's original code, so it
covers what we imported at `825c260` even though it landed after. Retained verbatim as
[`LICENSE`](LICENSE) in this directory; BSD-2 requires that notice to travel with source and
binary redistributions of these files. Do not delete it.

Who owns what here:

- **Upstream-authored, still recognizable** (embedder skeleton, `tools/bootstrap.sh` +
  build scripts, `web/` harness, upstream hunks of the WebKit patch) — BSD-2-Clause,
  © theogbob.
- **Our additions and rewrites** (everything in the list above; the whole `bib_*` ABI) —
  MIT, root [`LICENSE`](../../LICENSE). We don't track a per-file split: assume both notices
  apply to this directory as a whole.
- **`src/patches/webkit-emscripten.patch`** — a diff against WebKit source, so a derivative
  of WebKit that inherits each modified file's license (**LGPL-2.1** for WebCore,
  **BSD-2-Clause** for JSC/WTF/bmalloc). Not ours to relicense.

## Fetched, never redistributed by us

`tools/bootstrap.sh` pulls these into gitignored `third_party/`; none are committed, and
`dist/` is gitignored too.

| Component | License |
|---|---|
| WebCore | **LGPL-2.1** |
| JavaScriptCore, WTF, bmalloc | **BSD-2-Clause** |
| Skia | BSD-3-Clause |
| OpenSSL | Apache-2.0 |
| ICU | Unicode/ICU |
| zlib, libpng, libjpeg-turbo, libwebp, freetype, harfbuzz, libxml2, sqlite, brotli, libpsl, fontconfig | individual permissive licenses |
| Binaryen (npm `binaryen`, exact-pinned; dev harness only — `web/browser.html`'s guest-wasm wasm2js shim, served from `node_modules`, never shipped in the extension) | Apache-2.0 |

All permissive and mutually compatible with MIT. The one with copyleft reach is **WebCore
(LGPL-2.1)**, which the embedder links statically.

## The remaining obligation: shipping a built extension

Source distribution (this repo as it stands) is unencumbered — no WebKit here, just the patch.
The moment we ship `embedder.wasm` to anyone (extension store, release zip), LGPL-2.1 §6
attaches: recipients must be able to relink the embedder against a modified WebCore. Satisfy it
by publishing, alongside the binary, the WebKit pin + `webkit-emscripten.patch` +
`bootstrap.sh`/`build-engine.sh` (which is enough to rebuild) and this notice. That is close to
what we already have; the gap is that a truly fresh clone bootstrapping from nothing is
believed-but-unverified (roadmap).
