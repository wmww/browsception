# Measuring engine performance

How to get trustworthy numbers out of the nested engine, and the traps that produced *untrustworthy*
ones. Written up from the 2026-08-13 scroll investigation, which turned out to be an input-handling
design defect rather than a perf problem (issues/engine-renders-stale-input-state.md).

## BIBPERF (`?perflog=1`)

One `WTFLogAlways` line per second from `bib_tick`, forwarded to the host console. Fields:
`ticks/painted/busy%/heap/jsc | runloop renderUpd layout paint present pushOther persist |
pump(max,n) | wheel(n,q) blit(mv,wr,n,fb,rows) | avgPaintedFrame`.

**busy% only covers what runs inside `bib_tick`.** Anything the host proxies to the engine thread as
its own task (`bib_wheel`, `bib_mouse_*`, `bib_key`) runs in the same queue but *outside* the tick
body, so it used to be invisible: a thread saturated by wheel handling reported ~50% idle. `wheelMs`
is now folded into busy%; **any new proxied entry point needs the same treatment or busy% lies.**

Counters added 2026-08-13 (all `g_perfLog`-gated, engine-thread-only, no atomics):
- `wheel=<ms>(n<count> q<maxdepth>)` — time inside `handleWheelEvent`, event count, and the
  high-water depth of the **wheel task queue**. `q` is the backlog gauge: there is no backpressure
  on proxied input, so a saturated engine shows q climbing into the tens.
- `blit=<ms>(mv<ms> wr<ms> n<count> fb<fallbacks> rows<devrows>)` — `bibScrollBlit` split into its
  two mirrors (`g_blitPixels` memmove vs `SkCanvas::writePixels` onto the surface), plus how often
  it bailed to a plain repaint. The mv/wr split is what identified the premultiply conversion.

Pattern worth reusing: **time the two halves of anything that copies the framebuffer twice.** A
single combined number hides which mirror is expensive, and here they differed by 9x.

## Pixel-encoded page state (`scroll.bstest`)

`test/fixtures/pages/scroll.html` is 4000 × 120 px sections, each with a 10 px left border whose
colour encodes its index (`r = i & 255`, `g = i >> 8`). `__bs.probe(4, 4)` therefore decodes the
engine's **scroll offset** — no guest JS, no `bib_eval`, no golden images. Generalizes: when you need
to read engine-internal state from the host, paint it into the framebuffer as colour.

Caveat: `__bs.probe`/`readback()` costs the engine a **full-frame readback + host dispatch per
sample**. At 5 Hz it moved a measured 2.7 fps to 10 fps — i.e. the instrument was 70% of the signal.
Sample at ≤5 Hz for *position*, and take fps/busy numbers from a separate `--nosample` run.

## Driving input at an exact rate

`page.mouse.wheel` / CDP dispatch cost a round trip each (~1-4 ms), which caps and jitters the rate.
Dispatching `new WheelEvent(...)` **inside the page** from a rAF loop gives exact
(events-per-frame × px-per-event) control in one `evaluate`. The viewer's handlers don't care that
the event is untrusted. Two knobs separate the two candidate cost models:

- `--epf N` — N events per host frame: tests the viewer's per-rAF coalescing (1288 dispatched → 161
  reached the engine ⇒ working).
- `--stride N` — one event of N× the delta every Nth frame: **same px/s, 1/N the events.** This is
  the discriminator between per-event and per-pixel cost, and it's what proved the scroll bug —
  96% busy → 28% busy for identical distance, identical paint work and identical pixels on screen,
  i.e. it prices the redundant work directly. Worth reaching for whenever you suspect a pipeline
  is doing work per *input* rather than per *output*.

## Traps that cost real time here

- **Inherited backlog.** Consecutive runs in one browser session differed 2-8x until each run reset
  to the top and waited for *both* offset 0 and a quiet frame counter. Queued input from the
  previous run was still draining into the next one.
- **The page must be long enough.** Bottoming out silently ends the workload mid-run and reads as
  "fast" (low busy, few frames). Wikipedia articles are too short to sweep above ~4000 px/s.
- **Wheel position matters.** Dispatching at a canvas corner landed on Wikipedia's sticky sidebar,
  which scrolled *itself* — 53 of 62 wheel events produced no document scroll at all. Dispatch at
  the canvas centre.
- **`Emulation.setDeviceMetricsOverride` width/height are device px here**, so `--dpr 2` shrank the
  CSS viewport and left the framebuffer the same size — the dpr sweep measured nothing. Framebuffer
  pixel count is what drives blit/paint cost, so vary it directly (`--size 3200x1800`) and **always
  print `__bs.fb`** to confirm what the engine actually got.
- Paint cost is not proportional to area alone: ~4 ms fixed per `paintFrameRect` + ~0.023 ms per
  logical row at 1.4 Mpx. Small strips are dominated by the fixed cost (a 60 px strip is 1/5 the
  time of a full frame, not 1/14).

## Probes

| Script | What it measures |
|---|---|
| `tools/scroll-speed-probe.mjs` | scroll fps / engine busy / wheel+blit breakdown vs scroll speed, framebuffer size, event rate (`--sweep --stride --epf --size --dpr --nosample --url`) |
| `tools/perf-scroll-probe.mjs` | original dpr-focused scroll probe (2026-08-11 dpr!=1 fix) |
| `tools/scroll-roundtrip.mjs` | pixel-exactness of the scroll blit vs a full repaint |
