# Architecture

## Invariant

**No bytes from the target site are ever parsed or executed by the top-level browser.** Target
HTML/CSS/JS/wasm exists in the top-level browser only as opaque `ArrayBuffer`s passing through the
fetch bridge into the nested engine's memory. Everything that interprets those bytes runs inside the
wasm module.

## Components

```
┌─ top-level browser ──────────────────────────────────────────────────────┐
│                                                                          │
│  ┌─ extension service worker ──────────────┐                             │
│  │ DNR rules: main_frame redirect,         │                             │
│  │ header rewrite (UA/Cookie), CSP strip   │                             │
│  └─────────────────────────────────────────┘                             │
│                                                                          │
│  ┌─ viewer page (extension origin) ────────────────────────────────────┐ │
│  │                                                                     │ │
│  │  chrome UI: fake URL bar, status, tab-history mirror                │ │
│  │  canvas (display) ◄─ blit ─ transferred frame band (ArrayBuffer)    │ │
│  │  input capture: pointer/wheel/key → EngineLink.call → postMessage   │ │
│  │                                                                     │ │
│  │  ┌─ engine worker (one dedicated Worker, no SAB) ─────────────┐     │ │
│  │  │  engine.wasm  (WebCore + JSC-CLoop + Skia CPU, one thread) │     │ │
│  │  │  ▲ resource requests        ▼ pixels, title, URL, cursor,  │     │ │
│  │  │  │ (URL, method, headers)     favicon, persist snapshot    │     │ │
│  │  └──┼─────────────────────────────────────────────────────────┘     │ │
│  │     │ (messages; bytes transferred)                                 │ │
│  │  fetch bridge (trusted JS shim): guards → fetch(credentials:omit)   │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Extension service worker (untrusting, tiny)
Reconciles state into DNR rules and sweeps tabs; otherwise inert. The engine does **not** live
here (MV3 SW lifetime is ~30s idle; irrelevant to the viewer tab, which has normal document
lifetime). Keep interception in rules that persist (static on Chrome; dynamic on Firefox, whose
per-profile UUID rules out a static one) so nothing depends on it being awake. On Firefox the same
module runs as an event page (`ext/background.html`).

### Viewer page ("browser chrome")
One extension page per nested tab (`viewer.html?url=...`). Owns:
- The **fake URL bar** (address bar spoofing of the real omnibox is impossible by design — see
  extension-platform.md) and the **tab-history mirror** that lets the browser's own
  back/forward/reload drive the engine (ui.md).
- The display canvas and blit loop (see rendering-input.md).
- Input capture and the hidden-input IME trick.
- The **fetch bridge** (see networking.md) — the only component with real network authority.
- Session-level state: per-tab engine instance, engine lifecycle, crash/reload handling.

### Engine (wasm, untrusted-ish)
WebKit built for Emscripten (see engine.md). Runs single-threaded inside one dedicated Worker
(src/ext/engine-worker.js; no SharedArrayBuffer anywhere) and talks to the viewer only by
postMessage (src/ext/engine-link.mjs). Treats the
shim as its platform: network, display, input, clock, storage all come through explicit imports.
The engine is *inside* our trust boundary in the sense that we compiled it, but *outside* in the
sense that it processes attacker bytes — assume it can be owned, and design the shim's imports so an
owned engine gains as little as possible (see security.md).

## Data flows

**Navigation**: user types/clicks URL → DNR redirects the `main_frame` request to
`viewer.html?url=<original>` before any target bytes are fetched → viewer boots (or reuses) an
engine instance → engine "loads" the URL through the fetch bridge.

**Resource load**: engine's loader (WebKit's CachedResourceLoader → our network backend) emits
(URL, method, headers, body) → the worker forwards it to the bridge on the main thread → shim
guard list (scheme, private-network, ports, size; see networking.md) → `fetch()` with
`credentials:'omit'` on the extension origin (CORS-exempt via host permissions) → response headers
+ streamed body chunks transferred to the worker and copied into engine memory (one copy). WebKit's own
SOP/CORS/CSP/mixed-content checks all still run inside the engine, above this layer.

**Frame out**: engine paints with Skia CPU raster into its heap framebuffer → the worker copies the
dirty band into a transferable buffer → viewer uploads it (WebGL2 `texSubImage2D`) and hands the
buffer back; the engine holds the next paint until then (rendering-input.md).

**Input in**: viewer captures DOM events on the canvas, converts CSS px to framebuffer device px,
coalesces move/wheel per rAF, and posts each export call to the worker → engine dispatches through
its normal event pipeline. Scrolling is handled *inside* the engine (wheel deltas forwarded; the host
page never scrolls).

**Chrome signals out**: engine surfaces title, current URL, favicon bytes, cursor style, load
progress, console logs (dev), and requests like window.open / file-picker / download — each mapped
to a viewer-side handler.

## Hosting mode

One: the **extension-page viewer** — DNR redirects every intercepted `main_frame` to
`viewer.html?url=…` (raw target), on Chrome and Firefox alike. The URL bar shows the extension
URL with our in-page URL bar underneath (extension-platform.md § address-bar constraint); the
viewer origin is the extension origin (strong isolation); the bridge fetches directly from the
page. The only per-browser divergence is manifest generation (scripts/lib/manifest.mjs).

*Rejected (2026-09-09)*: a "mode B" stay-on-origin viewer (Firefox StreamFilter rewriting the
response body, real URL in the bar). It cost isolation — the viewer would run in the target
origin with its service workers, other extensions' content scripts and ambient credentials in
play — and only existed to get Firefox threads, which the no-SAB worker-hosted engine no longer
needs.

## Multi-tab / windows

- One viewer tab = one engine instance. `window.open`/`target=_blank` inside the engine → viewer
  opens another `viewer.html?url=…` tab. No shared state between instances except via the
  (engine-internal, OPFS-backed) cookie jar/storage, which is shared per-profile by design.
- Nested iframes are entirely the engine's business (they're just part of the page it renders).

## Performance posture

- Engine in a dedicated Worker: engine main loop off the viewer main thread; UI stays
  responsive even when nested JS spins. No SharedArrayBuffer, so the same build runs on Firefox
  (whose extension pages are never cross-origin isolated).
- Interpreter JS (CLoop) is the floor: ~10x below JIT. Acceptable; see engine.md for the
  possible weval-style AOT direction later.
- wasm32 (4 GB) is sufficient per instance; Memory64 exists but costs 10–100% on loads/stores —
  don't use it without evidence we need >4 GB.
- Ship size: engine wasm likely 50–250 MB; fetch+`WebAssembly.compileStreaming` from the extension
  package, cache compiled module in IndexedDB (structured-cloneable in Chrome) / OPFS.
