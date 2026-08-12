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
