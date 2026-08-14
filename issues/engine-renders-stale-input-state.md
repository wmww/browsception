# The engine applies input one event at a time, rendering states it knows are stale

**Reported** 2026-08-13 (user: "scroll is smoothish until I start scrolling faster, then it really
slows down… if it can scroll at many fps it should not drop to ~1fps"). Reproduced, measured, and
re-framed: **this is not a slow-scrolling problem, it is an input-handling design defect.**

## The defect

`bib_wheel` posts one proxied task per event to the engine thread and each is applied
independently (`main.cpp:1752`), unlike `bib_tick`, which collapses a burst into one pending task
(`g_tickQueued`, `main.cpp:886`). The engine therefore walks the framebuffer through *every*
intermediate scroll position, even when the events that supersede them are **already sitting in
the queue behind them**.

Concretely, with a paint in progress and three wheel events queued behind it, the engine shifts
the framebuffer to position 1, then to position 2, then to position 3. Positions 1 and 2 are
computed from input the engine already knows is stale, and are overwritten before anything can
observe them. Measured on a plain text page at 3200x1760: **43 wheel events/s produced 10.3
presented frames/s with zero blit fallbacks — ~4 full-framebuffer shifts per frame the user sees,
3 of them discarded by construction.**

The rule this violates: *never render a state you already know is superseded.* Input that
describes a **position** (wheel, mouse move, resize) must collapse to the latest known value
before rendering; only input that is inherently **discrete** (keys, clicks) must be replayed one
by one. The engine currently makes no such distinction — `bib_mouse_move` has the same shape
(`main.cpp:1698`) and is saved only by being cheap.

The viewer already gets this right on its side (it coalesces wheel deltas per rAF — verified:
1288 dispatched events reached the engine as 161). The bug is that nothing coalesces below that
boundary, so the engine faithfully re-runs work for input the host has already superseded.

## Why it surfaces as "fast scrolling is slow"

The per-event constant is large, so the wasted repetitions are visible rather than merely
wasteful. `bibScrollBlit` costs ~15 ms per event at 5.6 Mpx:

1. row-walk `memmove` shifting `g_blitPixels` (~1.4 ms), then
2. `SkCanvas::writePixels` mirroring that shift onto the SkSurface — **~13 ms**, ~9x (1) for
   identical bytes, because `g_blitPixels` is `kUnpremul_SkAlphaType` and the surface is
   `kPremul_SkAlphaType`: a per-pixel alpha conversion of nearly the whole framebuffer, not a
   memcpy.

Scrolling faster means more events/s (up to the ~60/s the viewer's rAF coalescing allows), so
~900 ms of every second goes into blitting whatever the frame rate is. HiDPI multiplies the
constant by ~4, which is why a 1600x880@2 window collapses at a scroll speed a 1600x880@1 window
shrugs off. There is no backpressure either, so a saturated engine falls further behind — queue
depth reached 70, and the page kept scrolling for seconds after the wheel stopped.

Note that (2) is worth fixing on its own merits, but fixing it alone would only make the
redundant work cheaper, not correct.

## Measurements

`tools/scroll-speed-probe.mjs` (fixture `https://scroll.bstest/`, plain text page, dpr 1,
`--nosample`; px/frame × 60 = px/s):

| fb | px/frame | fps | busy | paint ms/s | wheel ms/s (n/s) | blit ms/s (memmove / writePixels) |
|---|---|---|---|---|---|---|
| 1600x860 (1.4 Mpx) | 15 | 58 | 37% | 104 | 268 (60) | 210 (23 / **186**) |
| | 60 | 59 | 41% | 173 | 239 (57) | 188 (20 / **168**) |
| | 240 | 60 | 66% | 460 | 207 (60) | 159 (15 / **144**) |
| | 960 | 38 | 93% | 910 | 34 (57) | 0 (all fell back to full repaint) |
| 3200x1760 (5.6 Mpx) | 15 | **15** | 85% | 79 | **787** (47) | 749 (84 / **664**) |
| | 60 | **11** | 82% | 172 | **661** (43) | 624 (59 / **565**) |
| | 240 | **11** | 79% | 356 | 466 (31) | 435 (71 / **364**) |
| | 960 | **6.6** | 96% | 606 | 442 (55) | 399 (64 / **334**) |

At 5.6 Mpx and 900 px/s — a slow scroll — the blit costs **10x** the painting.

**What collapsing to the latest state is worth** (5.6 Mpx, same 3600 px/s, delivered as
fewer/larger steps via `--stride 6`):

| wheel events/s | blit ms/s | engine busy | paint ms/s |
|---|---|---|---|
| 56 | 831 | **96%** | 185 |
| 9 | 110 | **28%** | 167 |

Identical scroll distance, identical paint work, identical pixels on screen — 7.5x less engine
work purely from not re-deriving superseded states. Real sites match:
`en.wikipedia.org/wiki/Web_browser` at 1600x860, 3600 px/s → 10 fps at 96% busy (its article is
too short to sweep faster without bottoming out).

## Fix

**Collapse pending positional input to the latest known state before rendering.** Accumulate
queued wheel deltas into a single pending scroll (an engine-thread accumulator drained at the top
of `bib_tick`, or the `g_tickQueued` collapse pattern extended to sum rather than drop) and apply
it once per render. This bounds the blit at ~1 per painted frame, gives backpressure for free, and
makes the frame rate a function of paint cost alone. Constraints for whoever implements it:

- The guest sees one wheel event instead of N. That is what real browsers do (Chrome coalesces
  wheel into rAF-aligned batches), but it is a semantic change, not a pure optimisation — a page
  counting wheel events or reading `deltaY` per event observes the difference.
- A batch must break on anything that changes the meaning of the sum: sign or axis change,
  modifier change (ctrl+wheel is zoom, not scroll), and a `preventDefault()`ing guest handler.
- Discrete input (`bib_key`, `bib_mouse_button`) must **not** be collapsed. `bib_mouse_move`
  should be, on the same "latest position wins" rule.

Secondary, independently worth doing:

- **Shift the surface in place instead of `writePixels`.** The surface is raster in the extension
  (`bibGPU: false` permanently), so `surface->peekPixels()` gives its pixmap and the same row-walk
  memmove costs ~1.4 ms instead of ~13 ms with no alpha conversion. ~5x off whatever blits remain.
- **Or drop the second mirror entirely** — wrap the SkSurface over `g_blitPixels`
  (`SkSurfaces::WrapPixels`) so paint and host upload share one buffer, removing both the blit
  mirror *and* the per-paint `readPixels` unpremultiply. Blocked on the premul/unpremul split: the
  host presenter wants unpremultiplied RGBA.

## Not the cause (ruled out)

- Viewer-side coalescing is working (`--epf 8` → 8 wheel events per rAF still reached the engine
  as 1).
- Damage-rect merging is not collapsing strips into full repaints at ordinary speeds
  (`blitFallback` 0 until the per-event delta exceeds the viewport).
- Paint area scales as expected: ~4 ms fixed cost + ~0.023 ms per scrolled row at 1.4 Mpx.
- Rendering is *correct* throughout — damage accumulates across merged wheels (each blit
  translates the previous pending damage by its own delta), so the eventual paint covers the whole
  distance travelled. The redundant states are wasted, not wrong.
