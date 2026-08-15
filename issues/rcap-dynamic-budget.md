# Dynamic rcap budget is the shape that measured 5.2× worse

`main.cpp` still carries `kRcapUpdateBudget = 0.33` — capping `updateRendering` to a
fraction of the engine thread. The fork's perf work measured this exact shape at a
**5.2× MotionMark regression** (109.87 → 18.32) vs a fixed `rcap=30`, invisible to A/Bs
that only test light/vsync-capped pages: the cap budgets only the updateRendering EMA
and ignores runloop/pump/net/layout/paint/present/ack time.

Related pacing facts (notes/engine-internals.md § Perf): `bib_tick` runs
`updateRendering()` *before* `bibPushFrameIfDirty()` (a finished dirty frame waits one
tick), and `bib_pump`/`bib_pump_network` cycle the runloop with no paint at all, so
timer/network bursts starve painting.

Fix direction: re-measure on a heavy page (MotionMark or Discord-class), likely replace
the dynamic budget with fixed `rcap`, and consider pushing the dirty frame before the
rendering update in `bib_tick`.

## Measured 2026-08-14 (bench suite, engine 20260815-024910-d1ff7e9)

`node tools/bench/run.mjs --viewer-params 'rcap=N'` vs baseline, 1600x900, 3 reps:

| workload | baseline | `rcap=5` | `rcap=1` |
|---|---|---|---|
| app-update (Preact re-render per rAF) | 24.8 fps / 24.0 updates/s | 5.0 / 5.0 | 1.0 / 1.0 |
| text-scroll, article-scroll | 60 fps | 60 fps | — |
| input-latency (click, key) | 16.0 / 16.4 ms | 16.4 / 16.2 ms | 16.2 / 16.6 ms |

So the cap prices **only the rendering-update pass**: rAF-driven guest rendering tracks the cap
exactly (5/s at rcap=5, 1/s at rcap=1), while the scroll blit path and input-response repaints
go out at the normal frame cadence regardless — a click still answers in one frame with the
rendering update throttled to once per second. Two consequences for the fix:

- A/Bs that only watch scroll or input latency **cannot see this knob at all**; the workload
  that prices it is a framework app re-rendering every frame (`app-update`, the MotionMark
  class). That is exactly why the dynamic budget's 5.2x regression stayed invisible.
- Fixed `rcap` costs nothing in perceived input latency here, which weakens the main argument
  for the dynamic budget.
