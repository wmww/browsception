# Plan: perf benchmark suite (report-only, own fixtures, per-machine baselines)

Status: not started. Self-contained — assumes no context beyond this repo.

## Goal

A repeatable benchmark runner that measures engine performance against **our own fixture
pages** (never live third-party sites — they change under us), saves results locally, and
compares runs. **Report-only**: benchmarks are a lab instrument, not pass/fail tests, and
results are per-machine so **no results are ever committed to git**.

Primary use: run a baseline, change the engine, run again, get a delta table. Secondary:
compare across branches via the engine-artifact provenance stamps (see below).

## Non-goals

- CI gating or flaky timing assertions (tier-2 scenario 13's generous startup budget stays the
  only automated perf assertion).
- Benchmarking live sites. Allow a manual `--url` escape hatch for ad-hoc runs, but no live
  site is part of the suite.

## What already exists — build on it, don't reinvent

- **`notes/perf-measurement.md` — read it first.** It documents the BIBPERF counter format and
  every measurement trap that produced wrong numbers before (warmup/backlog inheritance,
  sampling observer effect, wheel-position pitfalls, paint cost model). The runner mostly
  codifies that checklist.
- **`tools/scroll-speed-probe.mjs`** is the protocol reference: boots the extension viewer
  headless (`test/harness/launch.mjs`), drives synthetic wheel events from inside the page at
  exact rates, parses `BIBPERF` console lines, decodes scroll position from fixture pixels.
  Reuse its techniques (or refactor shared pieces out); the benchmark runner supersedes ad-hoc
  probe invocations for the standard suite.
- **Fixtures**: `test/fixtures/server.mjs` serves `test/fixtures/pages/*` on `*.bstest`
  domains. `scroll.html` (plain text scroll, pixel-encoded offsets: each 120px section's left
  border encodes its index, so `__bs.probe(4,4)` reads the scroll offset) and
  `scroll-sticky.html` (same + sticky header band and fixed sidebar column, Wikipedia-shaped)
  exist. If `scroll-sticky` is absent on your branch, check `git log --all -- '*scroll-sticky*'`.
- **Engine provenance**: `node tools/stage-engine.mjs` stages a hardlinked engine snapshot into
  `src/engine/` and writes `src/engine/.staged-meta.json` (stamp, branch, checkout,
  source_hash). Every result record must embed this — it is what makes cross-branch A/B
  trustworthy (`--from <stamp>` can pin older snapshots).
- **Ports are per-checkout** (`test/harness/ports.mjs`); fixture/dev servers identify
  themselves and clients must refuse strangers. Don't hardcode ports.

## Critical gotchas (each cost real debugging time; do not rediscover)

1. **`?url=` in viewer URLs must be RAW, never `encodeURIComponent`ed** — the DNR `\0`
   substitution contract; the SW sweep slices it un-decoded and an encoded URL gets
   `tabs.update`d into a garbage relative URL (viewer never boots). If the probe on your branch
   still encodes, that's the bug, not the example to copy.
2. **Wheel-rate knobs are px per HOST FRAME** (×~60 for px/s). Pages must be long enough that
   the run never bottoms out (bottoming out reads as "fast").
3. **The `__bs.probe`/readback sampler is expensive** (full-frame readback per sample): ≤5 Hz
   for position, and take fps/busy numbers from separate no-sample runs.
4. **Never take timing numbers from a chatty-diagnostics build/run** (e.g. `?dmglog=1` if the
   engine supports it): hundreds of WTFLogAlways/s inflate costs 3-10×.
5. **Warn (loudly, into the result record) if an engine build is running** — concurrent ninja
   skews timings. `stage-engine` already prints this warning; surface it.
6. Reset to top + wait for both offset 0 and a quiet frame counter between scenario runs;
   discard ≥1 s warmup per measured window. Dispatch wheel events at the canvas centre.
7. Guest `console.log` forwards only its first argument — join strings inside `__bs.eval` code.
8. BIBPERF fields vary by engine version: parse defensively, record what's present. Newer
   engines add `paintRects=N(<total>Mpx, <X>Mpx/frame)` (painted area per frame — the key
   "did damage degenerate to full-viewport" signal); older ones lack it.

## Design

### Runner

`node tools/bench/run.mjs [--save <name>] [--compare <name>] [--only a,b] [--size WxH]
[--secs N] [--reps N] [--headed]`

- Runs the scenario matrix (below), N reps each (default 3), reports **median + spread**.
- Always prints the engine provenance line and machine info first.
- `--save` writes a JSON result file; `--compare` loads a saved file and prints a delta table,
  flagging metrics whose delta exceeds a per-metric noise threshold (derive thresholds from the
  observed spread across reps — a delta smaller than run-to-run noise is reported as "~").
- Also report **ratios vs the plain-text scroll scenario from the same run** — ratios transfer
  across machines better than absolute numbers.

### Result storage (never in git)

- `bench/` directory at repo root, added to `.gitignore`.
- Files: `bench/<name>.json` (`--save baseline` → `bench/baseline.json`); unnamed runs go to
  `bench/last.json`. Record shape: `{ savedAt, machine: {hostname, cpu, cores}, engine:
  <staged-meta>, harness: {headless, viewport}, scenarios: { <id>: {reps: [...], median: {...}} } }`.

### Scenario matrix

Each scenario = fixture + drive pattern + metrics. Sizes: 1600×900 default; the suite also runs
one large-frame pass (2560×1330) for the scroll scenarios (large frames are where perf dies
first). New fixtures go in `test/fixtures/pages/`, mapped in server.mjs, pixel-instrumented
with the scroll.html border-encoding scheme wherever scroll position matters.

1. **text-scroll** — existing `scroll.bstest`. Wheel at fixed px/frame (e.g. 60), 4 s.
2. **sticky-scroll** — existing `scroll-sticky.bstest` (sticky header + fixed sidebar).
3. **layout-dirty-scroll** — NEW fixture reproducing the mechanism that made real Wikipedia
   slow: a scroll handler that toggles an `-active` class on nav-list items as sections pass
   (like Vector 2022's TOC tracker). This dirties layout every scroll tick and historically
   triggered full-viewport repaints. Same pixel encoding + sticky sidebar containing the nav.
4. **image-scroll** — NEW: long page dense with decoded images (generate deterministic images
   server-side or data-URIs; no network variance).
5. **paint-heavy-scroll** — NEW: box-shadow/blur/gradient-heavy cards (shadow paints measured
   ~3× text cost; exercises Skia raster worst case).
6. **js-churn** — NEW: rAF loop + timer churn mutating DOM at a fixed rate (no scrolling).
   Metrics: presented fps, busy%, rendering-update cost. This is the workload class for the
   rcap throttle question (issues/rcap-dynamic-budget.md).
7. **boot** — time from viewer navigation to `__bs.ready`, to `progress >= 1`, and to first
   painted frame, on a simple fixture. Cold-ish only (fresh page each rep).

### Metrics (per scenario, from BIBPERF + page-side counters, medians over reps)

- presented fps (page-side, like the probe counts), engine busy%
- paint ms/s and avgPaintedFrame ms; Mpx/frame when the engine reports `paintRects`
- wheel queue high-water, wheel events merged ratio, blit fallbacks (scroll scenarios)
- scroll-distance efficiency (decoded end offset ÷ dispatched distance — must be ~1.0; if not,
  the measurement is invalid, mark the rep bad)
- boot: the three boot timestamps
- js-churn: rendering updates/s

### Suggested structure

`tools/bench/run.mjs` (CLI + orchestration), `tools/bench/scenarios.mjs` (matrix), reuse or
extract probe helpers rather than duplicating (`tools/lib/` is the existing shared spot).
Keep the existing probes working — they're still the free-form exploration tools.

## Acceptance

1. Two back-to-back runs on the same staged engine: every headline metric's delta is within
   the reported noise band (target: fps within ~10%, busy within ~5 points).
2. Synthetic-regression check: a run with a deliberate slowdown (e.g. viewer URL param
   `?rcap=5`, which throttles rendering updates to 5/s) compared against baseline clearly
   flags the affected scenarios.
3. `--compare` output is readable in a terminal: one row per scenario/metric, before → after,
   delta, noise flag.
4. Docs: short section in `notes/perf-measurement.md` (how to run, where results live, what
   the thresholds mean) + index line in `notes/README.md`. Delete this plan when done.
