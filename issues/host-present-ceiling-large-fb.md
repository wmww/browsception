# Host presentation caps scrolling at ~36 fps for large framebuffers

Found 2026-08-14 while verifying the sticky-scroll paint fixes: at `--size 2560x1330` the
scroll-speed probe tops out at 31-37 fps **even on the trivial scroll.bstest fixture with the
engine only ~20% busy** — the limit is the host side (viewer rAF → SAB texSubImage2D upload →
composite), not engine paint. At 1600x900 the same path holds 60-65 fps.

Wikipedia now sits at that same ceiling with 55-70% engine headroom (was pegged 99% busy), so
this is the next bottleneck for large windows / HiDPI.

Suspects, unmeasured: full-frame `g_uploadRect` per scroll tick means the WebGL presenter
uploads the whole 3.3 Mpx (13 MB) band every frame even when the repaint was a strip
(bib_render reports one merged dirty box; the upload band is its full row span); frame-credit
pacing (`present pacing` notes in engine-internals.md § Perf) interacting with slower uploads;
headless SwiftShader texture upload cost (real GPUs may not hit this — check headed).

First measurement: instrument viewer-side present (upload ms, rAF-to-rAF) at 1600x900 vs
2560x1330, fixture page, headed vs headless. If upload dominates, split the dirty box into
strip + moved-region uploads or move present to an OffscreenCanvas worker (rendering-input.md
blit option 2).

2026-08-15: the present now uploads from `g_presentPixels` (engine-thread snapshot, stable
while in flight — rendering-input.md § present snapshot); ceiling unchanged (bench: host
present ms/s flat). The stable buffer makes the worker-present option simpler if pursued.
