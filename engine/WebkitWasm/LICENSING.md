# Licensing notes

## Provenance / license status of this directory (browsception)

This directory is a squashed hard-fork import of
[theogbob/WebkitWasm](https://github.com/theogbob/WebkitWasm):

- Upstream base: `825c260c03bb2bd84f10fd1ebcda63660d9200ec` (upstream `main`).
- Imported 2026-08-12 from our fork branch head `af6f559fa3bd334c89df03ef191714db57fbe932`
  (8 fork commits, history not preserved).
- Rewritten since the fork: networking (curl/wisp transport replaced by the host-fetch
  bridge, `BibNetBridge`), presentation (runtime-sized shared-heap framebuffer /
  `bibFrame`), history/back-forward, input, crash & heartbeat recovery, plus pruning of
  upstream docs/spikes/gates at import time.

**Upstream never published a LICENSE**, so webkitwasm-derived files here (the embedder
skeleton, build scripts, `web/` harness, and the WebKit patch's upstream-authored hunks)
are **ambiguously licensed** until the author clarifies — tracked in
[theogbob/WebkitWasm#1](https://github.com/theogbob/WebkitWasm/issues/1). Revisit this
file when that resolves. Do not redistribute this directory publicly before then.

The rest of this file is upstream's original licensing analysis, kept as the base; it
predates the fork (e.g. its `docs/` references) but the component analysis still holds.

---

This is a research prototype. Licensing isn't finalized — this file lays out the
situation so it can be settled before the repo goes fully public. (For a private
repo with invited collaborators it's lower-stakes, but read this first.)

## What this repo actually contains

- **Original work** (ours): `src/embedder/`, `web/`, `tools/`, `docs/`. You
  choose the license for these.
- **`src/patches/webkit-emscripten.patch`** — a diff against WebKit source. It
  is a **derivative of WebKit** and inherits the license of each file it modifies.
- It does **not** contain WebKit, Skia, curl, ICU, OpenSSL, etc. Those are
  fetched from upstream by `tools/bootstrap.sh` and never committed here.

## Upstream licenses (fetched, not redistributed by us)

| Component | License |
|---|---|
| WebCore | **LGPL-2.1** |
| JavaScriptCore, WTF, bmalloc | **BSD-2-Clause** |
| Skia | BSD-3-Clause |
| curl | curl (MIT-like) · OpenSSL | Apache-2.0 · ICU | Unicode/ICU |
| zlib, libpng, libjpeg-turbo, libwebp, freetype, harfbuzz, libxml2, sqlite, nghttp2, brotli, libpsl, fontconfig | individual permissive licenses |

All permissive and mutually compatible. The one with copyleft reach is **WebCore
(LGPL-2.1)** — the embedder statically links it.

## The thing to decide before going fully public

The embedder statically links LGPL-2.1 WebCore. LGPL static linking obliges you
to let recipients relink against a modified WebCore (e.g. ship the embedder
object files, or document the build well enough to rebuild — which `bootstrap.sh`
largely already does). The patch hunks themselves remain LGPL/BSD.

Until the upstream question above is settled and a `LICENSE` exists, default
copyright applies (all rights reserved) — fine for a private repo, **not** for
public distribution.
