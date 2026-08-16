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
answers with a full frame whose fbW/fbH resize the canvas backing store (engine clamps to
1–8192 px, dpr 0.25–8). Input coords scale by the live
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
  dpr in force — it clamps viewport requests (1–8192 px, dpr 0.25–8) and adopts them
  asynchronously. WebCore's `PlatformMouseEvent`/`PlatformWheelEvent` positions
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
- **Positional input collapses below the viewer boundary too** (2026-08-14). *Never apply — and so
  never render — a state the pending input already supersedes.* `bib_wheel`/`bib_mouse_move` no
  longer post one proxied task per event: while a task is still queued its argument pack stays
  **open** and later events merge into it (wheel sums deltas, move keeps the latest position).
  Discrete input (keys, buttons) is never merged — each one means something on its own.
  - The merge window is "queued and nothing posted behind it": `bibProxyToEngine` **seals** the
    open batches whenever any other task is posted (the one place every cross-thread task goes
    through), so order is preserved against every other proxied task — a wheel arriving after a
    click can't be merged into a batch that runs before it. The viewer does the host half of the
    same rule (`flushPendingWheel()` before a mousedown).
  - **Collapse is proportional to how far behind the engine is**, for free: keeping up, the rAF
    tick posted between two wheels seals the first, so each event is still delivered on its own
    and the guest sees exactly what it saw before; saturated, `g_tickQueued` collapses ticks too,
    a frame's worth of wheels arrive as one event, and the blit is bounded at ~1 per painted
    frame. That is also the backpressure: batch backlog went 74 → 2 (below).
  - A batch breaks on anything that changes the meaning of the sum: modifier change (ctrl+wheel is
    zoom), direction reversal on either axis, dominant-axis change, or a guest handler that
    `preventDefault()`s wheels (`EventHandling::DefaultPrevented` from `handleWheelEvent` latches
    `g_wheelConsumed`, one event stale — the best a non-blocking answer can be). Dominance rather
    than an exact axis signature: trackpads put cross-axis noise on nearly every event.
  - Guest-visible semantics change under load only (fewer wheel events, larger deltas — what
    Chrome does with its rAF-aligned wheel batches). ABI documents it; tier-2 scenario 19 guards
    both invariants (distance conserved, nothing merged past a click).
- **The present is a coherent snapshot + one frame in flight** (2026-08-15). `bibPushFrameIfDirty`
  memcpys the dirty band `g_blitPixels → g_presentPixels` on the ENGINE thread, posts `bibFrame`
  pointing at the snapshot, and skips painting until the main thread signals consumption
  (`_bib_present_done`, called in the EM_ASM's finally; damage stays armed and coalesces). Before this, `bibFrame` pointed at the live
  framebuffer and the async `texSubImage2D` raced engine mutations — comment said "transient
  tearing, accepted, self-correcting", but it was the **scroll-up duplicated-band glitch**:
  scroll-up (dy>0) shifts rows with a BOTTOM-UP memmove while the upload reads top-down; they
  cross once, splicing the pre-shift frame (above) onto the post-shift frame (below) with a clean
  full-width seam offset by the scroll delta. Scroll-down walks top-down like the reader, so only
  UP produced the legible artifact; under continuous scroll-up every frame re-tore. Not
  reproducible with CDP-driven wheels or fast headless reads — needs in-page-dispatched
  trackpad-rate events + a multi-ms read window (tier-2 scenario 21 does exactly that; pre-fix it
  tore on ~13-60% of presents, post-fix 0). Cost: one band memcpy per PRESENTED frame — bench:
  fps unchanged everywhere, engine busy +3pp @1600x900 (+7pp @2560x1330, full-height scroll
  bands), boot/latency unchanged. `bib_set_viewport` retires the old present buffer to a list
  freed only when nothing is in flight. Forced readbacks (`__bs.probe`) also now re-arm
  `g_uploadRect` so the canvas can't silently miss the damage they consume.
- **The surface wraps the framebuffer** (2026-08-14, `SkSurfaces::WrapPixels` over `g_blitPixels`,
  boot + `bib_set_viewport`): paint lands directly in the shared buffer — the per-paint
  `readPixels` unpremultiply readback and the scroll blit's second row walk are both GONE
  (`bibScrollBlit` shifts the surface's own pixels once, `notifyContentWillChange` +
  `peekPixels`). The premul/unpremul "blocker" was a non-issue: the root frame is opaque
  (alpha 255 ⇒ premul == unpremul byte-for-byte) and the WebGL presenter ignores alpha anyway
  (`alpha:false` context, no blending). Host and probes now see premul bytes. (Historical: the blit mirror was once a `writePixels`
  unpremul→premul conversion, ~9x the memmove — 13 vs 1.4 ms at 5.6 Mpx.)
- **Damage merge is waste-based** (2026-08-14): `addDamage` used to unite ANY intersecting pair;
  on sticky-chrome pages (Wikipedia: full-width header band + tall sticky columns) the sidebar
  column intersects the full-width scroll strip, the 4-slot list collapsed to a frame-covering
  rect within a tick, and `bibScrollBlit`'s "pending damage contains scrollRect" guard then
  killed the blit — every wheel tick a full-viewport repaint (the "few fps on Wikipedia" bug).
  Now: 8 slots, merge only when union waste (union − a − b + overlap) ≤ ⅓ of the union, cascade
  re-fold, overflow unites min-waste. Sticky fixture: 0.4-0.55 Mpx painted/frame (~30-40% of
  viewport) at a steady 64-66 fps. BIBPERF now reports `paintRects=N(totalMpx, Mpx/frame)`.
- Measured on the real Wikipedia article (scroll-speed-probe, dpr 1, before → after):
  1600×860: 26-36 ms/painted frame @ ~30 fps → **5.2-5.7 ms @ 61 fps**; 2560×1290: 56-72 ms
  @ 15-16 fps → **~26 ms @ 31-32 fps**. Remaining gap at large sizes: Wikipedia's guest JS
  (TOC active-section tracker) dirties layout every scroll event and WebKit full-repaints every
  self-laid-out container even at identical geometry (`LayoutRepainter::repaintAfterLayout`:
  `selfNeedsLayout()` ⇒ `RequiresFullRepaint::Yes`) — so the page still paints 1.38 Mpx/frame
  (full viewport). WebKit keeps that conservatism for reflowed inline text (RenderText has no
  repaint pass of its own); refinement for block-level-children containers in progress.
- Measured (fixture, plain text, dpr 1, `tools/scroll-speed-probe.mjs`, before → after, same
  session): **5.6 Mpx** at 3600 px/s: 2 → 18 fps, wheel 968 → 111 ms/s, blit 913 → 90 ms/s, queue
  74 → 2, and the tail — how long the page keeps scrolling after input stops — 1.7 s → 0.16 s. At
  14400 px/s: 0.5 → 12 fps, tail 4.5 s → 0.3 s. **1.4 Mpx** was never backlogged, so it shows the
  cost, not the frame rate: at 3600 px/s busy 49% → 32%, blit 209 → 42 ms/s, fps ~59 either way.
  Scroll distance is conserved exactly (probe `efficiency` 1.0) in both.
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
