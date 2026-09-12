# Dynamic rcap budget throttles rAF-driven apps the engine could run at full rate

`main.cpp` caps WebCore's rendering-update pass: interval = EMA pass cost / `kRcapUpdateBudget`
(0.33), floored at `kRcapMaxIntervalMs` (33 ms, "30/s"). It exists for Discord-class pages
(700-890 ms/s in updateRendering → freeze). `?rcap=0` disables, `?rcap=N` fixes N/s.

Measured 2026-09-11 (bench `app-update`: Preact re-rendering a 240-row table per rAF, 1600x900,
3 reps, engine 6c8022a, load 4.5-6.9):

| viewer param | updates/s | presented fps | engine busy% |
|---|---|---|---|
| dynamic (default) | 26.9 | 26.8 | 43 |
| `rcap=0` (uncapped) | 60.7 | 32.4 | 87 |
| `rcap=30` (fixed) | 21.5 | 21.6 | 36 |

Findings:

1. **The budget throttles a page with headroom.** Uncapped, the same page runs 60 updates/s at
   87% busy. The cap prices only the update pass and knows nothing about the rest of the tick,
   so a ~10 ms pass is throttled to ~27/s whether or not anything else needs the thread. The
   presented rate rises much less than the update rate (paint can't keep up at 87% busy), so
   the visible win is smaller than updates/s suggests — that trade is what the budget is for.
2. **Tick quantization.** The interval is compared start-to-start against rAF-cadence ticks
   (~16.7 ms), so a 33 ms interval needs 2 ticks about half the time and 3 the other half: the
   "30/s floor" delivers ~27/s dynamic and fixed `rcap=30` delivers 21.5/s. Cheap fix: compare
   against the interval minus half a tick period (or count ticks).
3. **Input latency is unaffected** (2026-08-14 table: click/key ~16 ms at `rcap=5` and even
   `rcap=1`) — input-response repaints and the scroll blit go out at frame cadence regardless.
   Only rAF-driven guest rendering sees this knob, so scroll/latency A/Bs cannot see it;
   `app-update` is the workload that prices it.

Dropped: the earlier claim that this shape measured "5.2× worse on MotionMark than fixed
`rcap=30`". Nothing in the repo reproduces it, the floor makes dynamic ≥ fixed-30 on heavy
pages by construction, and fixed 30 measured worse above. Also dropped: "push the dirty frame
before the rendering update in `bib_tick`" — the update's own damage paints in the same tick
(update, then `bibPushFrameIfDirty`); reordering would cost it a tick.

Fix direction, when this matters: (a) the quantization fix; (b) a budget that throttles on
whole-tick overrun (tick time vs host frame period) rather than on the pass alone, verified on
Discord — the page the cap exists for and the one the bench cannot stand in for — with
`app-update` as the regression guard. Not urgent: light pages (≤1 ms passes) are uncapped.
