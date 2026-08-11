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
│  ┌─ viewer page (extension origin, crossOriginIsolated) ───────────────┐ │
│  │                                                                     │ │
│  │  chrome UI: fake URL bar, back/forward, find bar, status            │ │
│  │  canvas (display) ◄─ blit ─ framebuffer (SharedArrayBuffer)         │ │
│  │  input capture: pointer/wheel/key/IME → event queue →               │ │
│  │                                                                     │ │
│  │  ┌─ worker(s) ────────────────────────────────────────────────┐     │ │
│  │  │  engine.wasm  (WebCore + JSC-CLoop + Skia CPU, pthreads)   │     │ │
│  │  │  ▲ resource requests        ▼ pixels, title, URL, cursor,  │     │ │
│  │  │  │ (URL, method, headers)     favicon, audio, clipboard    │     │ │
│  │  └──┼─────────────────────────────────────────────────────────┘     │ │
│  │     │                                                               │ │
│  │  fetch bridge (trusted JS shim): guards → fetch(credentials:omit)   │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Extension service worker (untrusting, tiny)
Registers static DNR rules; otherwise inert. The engine does **not** live here (MV3 SW lifetime is
~30s idle; irrelevant to the viewer tab, which has normal document lifetime). Keep interception in
**static** DNR rules so nothing depends on the SW being awake.

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
WebKit built for Emscripten (see engine.md). Runs in a worker pool (pthreads over SAB). Treats the
shim as its platform: network, display, input, clock, storage all come through explicit imports.
The engine is *inside* our trust boundary in the sense that we compiled it, but *outside* in the
sense that it processes attacker bytes — assume it can be owned, and design the shim's imports so an
owned engine gains as little as possible (see security.md).

## Data flows

**Navigation**: user types/clicks URL → DNR redirects the `main_frame` request to
`viewer.html?url=<original>` before any target bytes are fetched → viewer boots (or reuses) an
engine instance → engine "loads" the URL through the fetch bridge.

**Resource load**: engine's loader (WebKit's CachedResourceLoader → our network backend) emits
(URL, method, headers, body) → shim guard list (scheme, private-network, ports, size; see
networking.md) → `fetch()` with `credentials:'omit'` on the extension origin (CORS-exempt via host
permissions) → response headers + streamed body copied into engine memory. WebKit's own
SOP/CORS/CSP/mixed-content checks all still run inside the engine, above this layer.

**Frame out**: engine paints with Skia CPU raster into a framebuffer in shared memory → viewer
blits at rAF cadence (dirty-rect aware if available) → canvas.

**Input in**: viewer captures DOM events on the canvas, normalizes to an engine event struct
(coordinates scaled by DPR), pushes to a ring buffer / postMessage → engine dispatches through its
normal event pipeline. Scrolling is handled *inside* the engine (wheel deltas forwarded; the host
page never scrolls).

**Chrome signals out**: engine surfaces title, current URL, favicon bytes, cursor style, load
progress, console logs (dev), and requests like window.open / file-picker / download — each mapped
to a viewer-side handler.

## Hosting modes

Two ways to host the viewer; the engine and shim are identical in both. Keep the viewer code
agnostic to the mode.

| | A: extension-page viewer (MVP) | B: stay-on-origin viewer |
|---|---|---|
| Mechanism | DNR/webRequest redirect main_frame → `viewer.html` | Let navigation commit; rewrite response body to viewer HTML |
| URL bar shows | `chrome-extension://…?url=<live URL>` (fake in-page URL bar) | real `https://example.com` |
| Target bytes parsed top-level | none, guaranteed | Firefox: none, guaranteed (StreamFilter). Chrome: partial (document_start neuter; preload-scanner leaks) — degraded |
| SAB/threads | Chrome: yes (manifest COOP/COEP). Firefox: **no** (bug 1673477) | yes on Firefox (inject COOP/COEP headers); Chrome unverified |
| Origin of viewer | extension origin (strong isolation) | target origin — site's old service workers, other extensions' content scripts, ambient credentials all in play |
| CORS bypass for bridge | direct (extension page) | must relay through background (extra copy) |
| Verdict | **primary design** | Firefox-only future mode (also solves FF threads); needs SW-unregister + storage clearing on entry |

## Multi-tab / windows

- One viewer tab = one engine instance. `window.open`/`target=_blank` inside the engine → viewer
  opens another `viewer.html?url=…` tab. No shared state between instances except via the
  (engine-internal, OPFS-backed) cookie jar/storage, which is shared per-profile by design.
- Nested iframes are entirely the engine's business (they're just part of the page it renders).

## Performance posture

- pthread build + `PROXY_TO_PTHREAD`: engine main loop off the viewer main thread; UI stays
  responsive even when nested JS spins.
- Interpreter JS (CLoop) is the floor: ~10x below JIT. Acceptable; see engine.md for the
  possible weval-style AOT direction later.
- wasm32 (4 GB) is sufficient per instance; Memory64 exists but costs 10–100% on loads/stores —
  don't use it without evidence we need >4 GB.
- Ship size: engine wasm likely 50–250 MB; fetch+`WebAssembly.compileStreaming` from the extension
  package, cache compiled module in IndexedDB (structured-cloneable in Chrome) / OPFS.
