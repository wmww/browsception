# Measuring engine performance

How to get trustworthy numbers out of the nested engine, and the traps that produced *untrustworthy*
ones. Written up from the 2026-08-13 scroll investigation, which turned out to be an input-handling
design defect rather than a perf problem (fixed 2026-08-14; rendering-input.md § scrolling).

## BIBPERF (`?perflog=1`)

One `WTFLogAlways` line per second from `bib_tick`, forwarded to the host console. Fields:
`ticks/painted/busy%/heap/jsc | runloop renderUpd layout paint pushOther persist |
pump(max,n) | wheel(n,q) blit(mv,wr,n,fb,rows) | avgPaintedFrame`. (Engines built before
2026-08-15 also report a `present` phase — the GPU present, now gone; the parser keeps it
optional so old artifacts still read.)

**busy% only covers what runs inside `bib_tick`.** Anything the host proxies to the engine thread as
its own task (`bib_wheel`, `bib_mouse_*`, `bib_key`) runs in the same queue but *outside* the tick
body, so it used to be invisible: a thread saturated by wheel handling reported ~50% idle. `wheelMs`
is now folded into busy%; **any new proxied entry point needs the same treatment or busy% lies.**

Counters added 2026-08-14: `paintRects=<n>(<total>Mpx, <X>Mpx/frame)` — rects painted and their
device-px area. **Mpx/frame ≈ framebuffer size means damage has degenerated to full-viewport
repaints** no matter what the blit saved — this single number is what separated "blit broken"
from "page dirties everything" on Wikipedia. `?dmglog=1` (probe `--dmglog`) additionally logs
every `addDamage` rect with the engine phase that issued it (`BIBDMG [wheel|runloop|renderUpd|
layout|paint|pump] x,y wxh`) — very chatty, diagnosis runs only, and **hundreds of WTFLogAlways/s
inflate wheel/paint costs 3-10x**, so never take timing numbers from a dmglog (or any chatty
diagnostic) run/build.

Counters added 2026-08-13 (all `g_perfLog`-gated, engine-thread-only, no atomics):
- `wheel=<ms>(n<applied> ev<hostevents> q<maxdepth>)` — time inside `handleWheelEvent`, events
  actually applied, host events they carry (`ev > n` = batches merged), and the high-water depth
  of the **wheel batch queue**. `q` is the backlog gauge: it hit 74 when every event got its own
  task, and sits at 1-3 now that merging supplies the backpressure.
- `blit=<ms>(mv<ms> wr<ms> n<count> fb<fallbacks> rows<devrows>)` — `bibScrollBlit` split into its
  two mirrors (`g_blitPixels` row walk vs the surface's), plus how often it bailed to a plain
  repaint. The mv/wr split is what identified the premultiply conversion when `wr` was a
  `writePixels`; the two are within ~1.5x of each other now that both are memmoves.

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

- **`?url=` must be RAW in probe/viewer URLs** (the DNR `\0` contract): an
  `encodeURIComponent`ed url makes the SW sweep `tabs.update` the viewer tab to a relative
  garbage URL and the probe times out on boot (issues/encoded-viewer-url-breaks-sweep.md).
- **`--sweep` is px per HOST FRAME, not px/s** (×~60 for px/s). Wikipedia articles bottom out
  above ~120 px/frame × 4 s — trailing seconds show wheels applied with `painted=0`, and the
  run's summary fps is then an artifact.
- **The guest's `console.log` forwards only its first argument** — join diagnostics into one
  string before logging from `__bs.eval` code.
- **`WTFLogAlways` from the engine worker reaches the page console; `emscripten_log` does not**
  — stack captures must go through WTFLogAlways (or the abort hook) to be visible to probes.

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

## Bench suite (`scripts/bench/run.mjs`)

The repeatable instrument built on everything above: same measurement protocol, fixed workloads,
saved results, delta tables. **Report-only** — nothing here gates anything, results are
per-machine and never committed. Free-form questions still belong in the probes below; the suite
answers "did this change make things better or worse, and where".

```sh
node scripts/bench/run.mjs --save baseline           # headline matrix, 3 reps, ~4 min
#   ... change the engine, rebuild, node scripts/stage-engine.mjs ...
node scripts/bench/run.mjs --save after --compare baseline
node scripts/bench/run.mjs --only article-scroll --reps 5 --secs 6
node scripts/bench/run.mjs --diagnostic              # + the localization tier
node scripts/bench/run.mjs --viewer-params 'rcap=5'  # any viewer/engine param
node scripts/bench/run.mjs --list        # saved runs
node scripts/bench/run.mjs --diff a b    # compare two saved runs, run nothing
```

Results land in the **main checkout's** `bench/<name>.json` (gitignored, shared by every
worktree so cross-branch comparison doesn't mean hunting through worktrees); an unnamed run
overwrites `bench/last.json`. Each record embeds engine identity (`.staged-meta.json`), the
target checkout's rev/branch/dirty, the runner's rev, machine + chromium + load, fixture
hashes, config, every rep, and one raw BIBPERF line as evidence of what that engine reported.

### Scenarios

Few scenarios, wide spread, composite over purified: one realistic page exercising four
mechanisms at once is much harder to Goodhart than four synthetic pages each isolating one.
Headline runs at 1600x900, plus a 2560x1330 pass for the scroll pair.

| id | workload |
|---|---|
| `text-scroll` | plain long text, wheel at 60 px/host-frame — the **ratio denominator** |
| `article-scroll` | sticky header + fixed TOC sidebar measuring every chapter per scroll tick + inline images + shadowed cards (the shape that made real Wikipedia slow) |
| `text-scroll-2560`, `article-scroll-2560` | the same at a large framebuffer. **Headless SwiftShader caps these at ~30-35 fps** (13 MB texture upload + composite per frame); the real GPU holds 60 (experiment-log.md 2026-09-11). For any present-path question run with `--chromium-args '--use-angle=vulkan'` (headless, real GPU; `--compare` warns when runs differ in flags) |
| `app-update` | vendored Preact re-rendering a 240-row table every rAF: VDOM diff, GC pressure. The workload class for the rcap question (issues/rcap-dynamic-budget.md) |
| `input-latency` | click -> painted response, per-key latency, 10-key burst |
| `boot-trivial`, `boot-article` | navigation -> engine ready -> load complete -> first frame -> the page's own pixels |
| diagnostic tier (`--diagnostic`) | `paint-heavy-scroll` (Skia raster), `image-scroll` (decode/upload), `sticky-scroll` (sticky/fixed without the TOC handler), `js-churn` (rAF + timers, no framework) — for localizing which subsystem moved, never headline numbers |

### What comes out

Engine-side from BIBPERF (fps, busy%, paint/layout ms/s, avg painted frame, Mpx/frame when the
engine reports `paintRects`, wheel queue/merge ratio, blit fallbacks, heap/jsc growth) **plus
host-side, which is not optional**: busy% covers only the engine thread, so work moved across
the wasm boundary reads as a free win without `hostPresentMsPerSec` (time inside the
`Module.bibFrame` wrapper, where the canvas blit lives), longtask ms/s and rAF p95 jitter.

Every scenario verifies its output from pixels, so "faster because it stopped painting
correctly" reads as a failure, not a win:

- scroll: efficiency = decoded distance / dispatched distance, read after the backlog drains.
  Efficiency below ~1.0 is a **headline regression signal** (the engine dropped scroll), not an
  invalid rep. A rep is invalid only for harness reasons — the page bottomed out or the fixture
  hash changed. "Bottomed out" and "the engine stopped responding to input" look identical from
  the host (the offset just stops), so the runner nudges **down and then up**: responsive-but-
  at-the-end moves back up, a wedged engine moves neither way and the rep stays VALID.
- scroll/boot: a deterministic end-state checksum (scroll: back at offset 0; boot: the loaded
  page at rest). Same pixels, same hash, any machine — `--compare` calls out a change.
- input: the response colour is matched **exactly**; the click zone's colours differ by 1
  between clicks, so any tolerance turns the pixel already on screen into a 0 ms false hit.
  Latency is timestamped on the frame that carried the pixel (read straight out of the
  framebuffer inside the `bibFrame` wrapper — no readback, no polling), so its floor is one
  frame: this engine answers a click or a keystroke in ~16 ms on the input fixture, and stays
  there even at a 4K framebuffer or with the rendering update throttled to 1/s
  (issues/rcap-dynamic-budget.md). A regression that costs whole frames is what it can see.

Output is `median ± rep spread` per metric, plus each scenario's ratio to text-scroll from the
same run (ratios transfer across machines much better than absolute numbers). `--compare` flags
a delta only when it clears `max(fixed floor, rep spread of both runs)` — floors are ~10% fps,
5 points busy, 15% latency; smaller deltas print as `~`. Three reps is a weak spread estimate,
so the floors carry most of the weight. Comparisons also warn when the two runs saw different
machine load, viewer params, window lengths, fixture hashes or end-state checksums — **the load
one matters**: a run started under load 20 measured `app-update` 20% slower than the same engine
under load 8, which is bigger than most changes worth chasing.

### The contract with the code under test

Retro-benchmarking is a design goal: new scenarios must be runnable against old versions. The
suite's entire contract with the target is these four things, and **breaking one must be a
visible decision**, not a side effect:

1. **Viewer URL scheme**: `viewer.html?<our params>url=<RAW target>` — params before `url=`, the
   target never percent-encoded (the DNR `\0` contract, top of notes/README.md); `perflog=1`,
   `persist=0`, `rcap=N`.
2. **Host API**: `__bs.ready`, `__bs.state.progress`, `__bs.probe/readback`, `__bs.fb`, and one
   of two frame/wheel hook generations, feature-detected by `lib/page.mjs`: `__bs.onFrame(cb)`
   (band + geometry per presented frame; a watched pixel can only change in a frame whose band
   covers it) + `__bs.link.call` (wrappable, every export call) — worker-hosted viewer,
   2026-09-09 on; or the page-side `Module.bibFrame` (wrappable, framebuffer readable from
   `ptr`/stride) + `Module._bib_wheel` of older artifacts. `presentMs` is 0 on the new path (the
   present happens inside the link's handler, not separable from the page).
3. **BIBPERF console-line format**, parsed defensively — every field optional.
4. **Target = an unpacked extension directory with a staged engine.**

What keeps it decoupled: `--ext <dir>` names the extension under test (default: this checkout's
`src/`), while fixtures, harness, parsing and metrics always come from the **runner's own**
checkout — nothing is ever path-joined off `--ext` except the extension dir itself. Bench
fixtures are served by the bench checkout's own server on its own port lane
(`test/harness/ports.mjs` +10/+11, `*.bsbench`), independent of the tier-1/2 fixture server and
its oracle. Missing hooks or fields are **feature-detected**: the metric records as absent and
the run completes.

**Fixtures under `scripts/bench/fixtures/` are append-only.** Changing one silently invalidates
every saved result that used it; a changed workload gets a **new scenario id**. Each record
stores a hash of every fixture file it used and `--compare` warns when they differ.

### Retro-running an old commit

```sh
git worktree add /tmp/bs-old <sha>
cd /tmp/bs-old && node scripts/stage-engine.mjs            # or --from <stamp> to pin a snapshot
cd -    # back to the bench checkout
node scripts/bench/run.mjs --ext /tmp/bs-old/src --save old --compare baseline
```

The old engine pairs with its contemporaneous extension JS automatically, which matters because
perf is engine + host JS together. Retro depth is bounded by **artifact availability**, not by
the runner: snapshots get pruned (newest 12) and old builds are not reproducible through the
drifting shared build tree, so a notable stamp worth keeping should be copied into the
pruning-exempt `engine/artifacts/keep/` before it ages out (`cp -a
engine/artifacts/<stamp> engine/artifacts/keep/`, then `node scripts/stage-engine.mjs --from
keep/<stamp>`).

### Protocol details the runner already handles

Everything in § Traps, plus:

- Each rep resets to a known state, drives a **1 s warm-up that is thrown away**, then measures.
- **No readback inside a measured window** (a full-frame readback per sample was once 70% of
  the signal): offsets and counters are sampled just before and just after, and backlog drain
  is detected from the presented-frame counter, which costs nothing.
- Boot scenarios get a **fresh browser session and a throwaway first boot**: after a full
  headline pass the same boot costs 2-3x more, which is the harness's memory pressure, not the
  engine's startup. Boot numbers are therefore *warm*-boot numbers.
- Scroll offsets decode at 120 px granularity, so efficiency carries about ±1% quantization.
- A running engine build is detected and recorded **into the result file**, loudly: a concurrent
  ninja skews every number in the run.

## Probes

| Script | What it measures |
|---|---|
| `scripts/scroll-speed-probe.mjs` | scroll fps / engine busy / wheel+blit breakdown vs scroll speed, framebuffer size, event rate (`--sweep --stride --epf --size --dpr --nosample --url`) |
| `scripts/perf-scroll-probe.mjs` | original dpr-focused scroll probe (2026-08-11 dpr!=1 fix) |
| `scripts/scroll-roundtrip.mjs` | pixel-exactness of the scroll blit vs a full repaint |

The probes stay free-form exploration tools (sweeps, one-off questions); the bench suite above
is the repeatable one. Both share the same measurement rules — the suite just codifies them.

## JS speed (`scripts/js-speed-probe.mjs`)

Ten small bodies (property mono/poly, call, int/float arith, dense array, alloc, string scan/build,
JSON) run in the engine and in the host page, each as ONE eval, timed by the host wall clock around
that eval with the guest's own `Date.now()` printed as a cross-check on the guest clock (best-of-2).
Prints native/engine/ratio. Two traps it exists to avoid: (a) timing a batch of benchmarks from
inside one long eval hides per-bench engine stalls and can hit state-dependent CLoop bugs
(issues/cloop-join-returned-nonstring.md); (b) a native baseline whose result is unused gets
optimised away — every body returns a checksum that the harness compares across engines.

Current numbers and the cross-engine comparison against firefox-wasm's PBL: experiment-log.md
2026-08-14.
