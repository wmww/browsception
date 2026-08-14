# Rendering, input, and browser-chrome plumbing

## Rendering path

Engine paints via **Skia CPU raster** into a BGRA/RGBA framebuffer in shared memory (pthread
build) or in the wasm heap (single-thread build). The viewer blits to a canvas.

Blit options, fastest first:
1. **WebGL `texSubImage2D` upload + fixed textured quad** — the plan of record. One static shader
   pair compiled once from trusted shim code; per frame, upload the (dirty region of the)
   framebuffer and draw. GPU handles scaling/DPR. Reuse the texture; consider double-buffering to
   hide upload latency.
2. **OffscreenCanvas in a worker** — pairs with the pthread build (render worker uploads straight
   from SAB without bouncing through the main thread). Resize of OffscreenCanvas is heavy →
   debounce resizes.
3. **2D canvas `putImageData`** — simplest correct fallback; CPU-bound, marginal at 1080p60. Keep
   as a debug/compat path.

Attack-surface note ("blit-only WebGL"): WebGL always uses shaders — blit-only means *we* author
one trivial fixed shader; the nested site supplies only pixel *data*, never shader source or GL
calls. Exercised native surface ≈ texture upload + one static program through ANGLE — narrow and
well-tested. 2D canvas is GPU-accelerated (Skia) under the hood anyway, so the 2D path is not
meaningfully "GPU-free"; choose by performance. What stays banned: exposing WebGL/WebGPU *to the
nested engine* (attacker-controlled shaders/API sequences → driver).

Frame scheduling: engine signals `frame_ready` (+ dirty rects if we get them out of WebKit);
viewer rAF loop uploads latest complete frame; drop intermediate frames rather than queueing.
Vsync/throttle inside the engine driven by a host rAF-derived tick so the engine doesn't paint
faster than display.

DPR & resize (implemented): the canvas fills the window (viewer.html flex column);
`ResizeObserver` (device-pixel-content-box, dpr fallback) → 100 ms trailing debounce →
`bib_set_viewport(w, h, dpr)`; the engine reallocates the framebuffer, resizes the frame view, and
answers with a full frame whose fbW/fbH resize the canvas backing store (raster only — GPU mode
ignores resize; engine clamps to 1–8192 px, dpr 0.25–8). Input coords scale by the live
backing/CSS ratio so clicks stay aligned while the engine catches up. Tier-2 scenario 14 covers
boot-size, grow, shrink, and post-resize input.

## Input forwarding

### Input coordinates (three spaces, one contract)
- **CSS px** (host page) → **DEVICE px** (framebuffer) → **LOGICAL px** (WebCore's view, events
  and damage). Device px is the *only* unit that crosses the ABI, in either direction.
- The **viewer** does CSS→device with the live `canvas.width / canvas.clientWidth` ratio, not
  `devicePixelRatio`: the two agree except mid-resize, and the ratio is what the blit is actually
  showing, so clicks stay aligned while the engine catches up.
- The **engine** does device→logical (`bibLogicalPoint`, ÷ `g_dpr`), because only it knows the
  dpr in force — it clamps viewport requests (1–8192 px, dpr 0.25–8), ignores them in GPU mode,
  and adopts them asynchronously. WebCore's `PlatformMouseEvent`/`PlatformWheelEvent` positions
  are logical; the device scale factor is applied at *paint* time, not to event coordinates.
- **Wheel deltas are the exception**: logical (CSS) px, forwarded unscaled — that is what the DOM
  reports and what WebCore wants.
- History: this step was missing until 2026-08-13 — the ABI said device px, the engine used the
  numbers as logical, and at dpr 1 (all our tests, the engine dev harness, the harness the code
  was ported from) those are the same number. On a HiDPI screen every click landed dpr times too
  far down and right: at dpr 2 a click 150 px into the page hit whatever was at 300,300. The
  rendering path had been converted carefully when resize/dpr support landed (1.3) and input was
  simply never revisited. Guarded now by tier-2 `hidpi.test.mjs` at dpr 2 + 1.5; the durable
  lesson is in testing.md § dpr != 1 is a coverage axis.

- **Pointer**: `pointerdown/move/up/cancel` + `wheel` (listener `passive:false`, preventDefault)
  on the canvas; capture pointer on down. Translate CSS→device px (above). `contextmenu` prevented; right
  click forwarded (nested page may show its own menu; a host-side nested-browser context menu is
  viewer chrome, post-MVP).
- **Scrolling lives inside the engine** — wheel/touch deltas are forwarded as input; the host page
  never scrolls. Smooth scrolling, overscroll, scrollbars: all engine-drawn. This is the only way
  it stays coherent (fixed elements, iframes, JS scroll handlers).
- **Fast-scroll blit works at any dpr** (2026-08-11; was dpr==1-only → full-viewport repaint per
  scroll ≈ 1fps on HiDPI). `bibScrollBlit` shifts in device px, snapping to whole pixels with a
  carried sub-pixel residual (bounded ±0.5, never accumulates); damage stays logical with
  axis-only 1px inflation (both-axes inflation merges strip+scrollbar damage into a
  frame-covering rect → full-repaint chain). After fractional-dpr scrolling goes quiet, a latched
  settle flag triggers one full repaint (bib_tick, 200ms) landing exactly on truth.
  `paintFrameRect` culls 1 logical px wider at fractional dpr so partial paints compose
  boundary-straddling device rows identically to full paints. Wheel deltas coalesce per rAF tick
  in the viewer (like mousemove) — smooth trackpads fire hundreds of float-delta events/s and
  each engine wheel event costs a blit. WebCore snaps float wheel deltas to integer logical
  scrolls (ChromeClient::scroll delta is IntSize), so floats never reach the blit. Note WebCore
  skips invisible fixed layers in scrollContentsFastPath (NotCompositedForNoVisibleContent), so
  an opacity:0 100vw/100vh fixed overlay doesn't force slow scrolling. Probes:
  `tools/perf-scroll-probe.mjs` (BIBPERF/BIBSCROLL via `?perflog=1`),
  `tools/scroll-speed-probe.mjs` (speed / framebuffer / event-rate sweeps),
  `tools/scroll-roundtrip.mjs` (pixel-exactness); see notes/perf-measurement.md.
  loginasroot.net @1600x860: 2-5ms strip repaints / ~12% busy at any dpr (was ~100ms/98% at dpr≠1).
  Shadow-heavy full paints remain ~3x a text page (~100ms vs ~30ms per 1.4Mpx) — matters for
  load/resize/settle only; Skia blur caching is the lead if it ever hurts.
- **Input below the viewer boundary is applied one event at a time, so the engine renders scroll
  positions it already knows are stale** (2026-08-13). `bib_wheel` posts one proxied task per event
  with no collapse (unlike `bib_tick`'s `g_tickQueued`) and no backpressure, so with events queued
  behind a paint the engine shifts the framebuffer through every intermediate position — measured
  ~4 full-framebuffer shifts per presented frame, 3 discarded by construction. The rule: positional
  input (wheel, mouse move, resize) must collapse to the latest known value before rendering; only
  discrete input (keys, clicks) replays one by one. `bib_mouse_move` has the same shape and is
  saved only by being cheap.
- What makes that visible rather than merely wasteful: `bibScrollBlit` costs ~15 ms per event at
  5.6 Mpx, ~90% of it `SkCanvas::writePixels` mirroring the shift onto the SkSurface — a per-pixel
  unpremul→premul conversion of nearly the whole framebuffer, not a memcpy. The 08-11 numbers above
  only ever timed the paint. Write-up + fix: issues/engine-renders-stale-input-state.md.
- **Keyboard**: `keydown/keyup` with code/key/modifiers forwarded; prevent default for keys the
  page consumes, but pass through browser-level combos (Cmd/Ctrl+L jumps to our fake URL bar;
  Cmd/Ctrl+T/W, Alt+←/→, F5 etc. left to the real browser). Maintain a small routing table.
- **IME/composition — the known-hard one.** A canvas can't host the platform IME. Standard trick
  (Figma/VS Code lineage): keep a hidden 1px `<input>`/contenteditable positioned at the engine's
  caret (engine reports caret rect), focused whenever the nested page has an editable focused;
  consume `beforeinput` + `compositionstart/update/end` from it and feed text/composition state
  into the engine; mirror the engine's composition string back. Dead keys and CJK candidate
  windows follow the hidden input's position — hence the caret-rect plumbing. Budget real time;
  ship US-ASCII typing first, IME correctness as a fast-follow.
- **Touch**: forward as touch events post-MVP; MVP maps primary touch to pointer.
- **Cursor**: engine reports CSS cursor → set `canvas.style.cursor`.
- **Focus**: canvas is a focus sink (`tabindex=0`); engine-internal focus is engine business.
  Viewer chrome (URL bar, find bar) participates in normal DOM focus.

## Browser-chrome features (viewer-side UI, engine-side machinery)

- **Fake URL bar**: shows engine's current URL + TLS-ish state (we know scheme; real cert info
  unavailable — display honestly). Edit → navigate engine. This is our substitute for the omnibox
  (which permanently shows the extension URL — see extension-platform.md).
- **Find-in-page**: intercept Ctrl/Cmd+F → viewer find bar UI → engine's own find machinery
  (WebCore `findString` / FindController: search, highlight, scroll-to-match all happen inside the
  pixmap, like every WebKit embedder). We build UI only.
- **Navigation**: no buttons — the *host* browser's back/forward/reload drive the engine's
  BackForwardList, via the tab-history mirror (ui.md § Viewer chrome & native history). The
  canvas therefore passes Alt+←/→, F5 and mouse buttons 3/4 straight through. History
  persistence (profile OPFS) post-MVP.
- **Downloads**: engine signals download (navigation policy decision) → bytes stream through the
  bridge to a Blob → `chrome.downloads.download({url: blobUrl, filename})`.
- **File upload**: engine requests file picker → viewer opens real `<input type=file>` (needs the
  user gesture we already have from the click) → File bytes copied into engine, engine fakes the
  FileList. MVP: single files, no directories.
- **Clipboard**: viewer uses async Clipboard API (`clipboardRead`/`clipboardWrite` permissions;
  gesture-gated reads). Engine copy → host clipboard write. Host paste → inject into engine on
  Ctrl/Cmd+V. Rich-text/image clipboard post-MVP.
- **Popups / window.open / target=_blank**: engine policy delegate → viewer opens a new
  `viewer.html?url=…` tab via `chrome.tabs.create`. Popup blocking = engine's own logic + a
  viewer-side allowlist. `window.opener` relationships across viewer tabs: unsupported initially
  (document as limitation).
- **Dialogs** (alert/confirm/prompt/beforeunload, HTTP auth): engine delegate → viewer-drawn modal
  (never native `window.alert` — it would look like the extension talking).
- **Audio**: engine PCM → SAB ring buffer → `AudioWorklet` in the viewer. Post-MVP. Video: further
  out (decode via engine's software paths where feasible; no DRM/EME ever — Netflix-class sites are
  permanently out of scope).
- **Printing**: out of scope (project decision).
- **Zoom**: Ctrl/Cmd+± → engine page-zoom (WebKit supports it natively). Host pinch-zoom left alone.
- **Status/progress**: favicon (engine bytes → data URL → `<link rel=icon>` of viewer page — also
  gives the real tab a per-site icon), title → `document.title` (tab strip shows nested page
  titles), load progress bar, hover-link status text.
