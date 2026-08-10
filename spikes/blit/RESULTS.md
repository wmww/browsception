# Spike 0.4 results — blit + input harness (no engine)

2026-08-09. Answers open-questions #10 (frame transport pick, dirty-rect wins).

## What was built

- `js/engine-worker.js` — fake engine worker: paints a moving gradient + binary frame counter
  into the SAB framebuffer (RGBA8888) at 60 fps, publishes `FRAME_SEQ`/dirty rows via Atomics,
  drains + acks the input ring (sleeps in `Atomics.wait`, woken early by input notify).
- `js/viewer.js` + `index.html` — viewer skeleton: rAF blit loop, ResizeObserver +
  devicePixelRatio handling, HUD (fps, blit avg/p95, copy ms, input round-trip latency),
  `globalThis.__blitStats` / `__injectTestInput` for programmatic measurement,
  res/path/mode switchable via UI selectors or URL params (`?res=1440&path=2d&mode=dirty`).
- Blit paths behind a common interface (`blit(fb8, dirty) -> {copyMs}`, `resize`, `dispose`):
  `js/blit/webgl2.js` (persistent RGBA8 texture, texSubImage2D, bufferless fullscreen-triangle
  shader) and `js/blit/canvas2d.js` (putImageData fallback, backing store pinned to fb size,
  CSS scales).
- `js/ring.js` — SPSC input ring in the SAB (256 × 40-byte records, main writes,
  worker drains, ack seq + original event timestamp echoed back for latency measurement).
- `server.mjs` — dep-free static server with COOP `same-origin` + COEP `require-corp`
  (crossOriginIsolated=true confirmed in both environments).
- `bench/bench.mjs` — dep-free CDP driver (node's built-in WebSocket): spawns server +
  headless Chromium (or `--connect PORT` for an existing windowed instance), runs every
  config, injects synthetic input, prints table + JSON. Raw outputs in `bench/data/`.

## Environment

- Chromium 150.0.7871.186, node v26.5.0, Linux (zen).
- **Headless** (`--headless=new`): WebGL renderer = `ANGLE (Google, Vulkan 1.3.0 (SwiftShader
  Device (Subzero)), SwiftShader driver)` — software rasterizer, so windowed was also measured.
- **Windowed** (guibox sway session, real GPU): `ANGLE (AMD, AMD Radeon 890M Graphics
  (radeonsi strix1 ACO), OpenGL ES 3.2)`.
- **SAB-direct upload works**: Chromium 150 accepts a SharedArrayBuffer-backed view in
  `texSubImage2D` directly — no scratch-copy fallback needed (`sabDirect=true` everywhere).
  The copy fallback is implemented and self-activates on the first thrown upload.
- Timings are CPU-side ms inside the blit call (copy + upload + draw). A `gl.finish()` variant
  (`sync`) was measured to bound hidden GPU cost — it changed nothing (see table), so upload
  submission is the real main-thread cost.

## Blit cost (ms per frame, avg / p95), 5 s per config, engine at 60 fps

"dirty" = ~10 % of rows repainted per frame, uploaded as one contiguous row band.
"copy" = SAB→ImageData copy, included in blit ms (2d path only; webgl2 uploads SAB-direct).

| config | headless (SwiftShader) | fps | windowed (Radeon 890M) | fps |
|---|---|---|---|---|
| 1080p webgl2 full | 0.65 / 0.75 | 59.0 | 0.68 / 1.45 | 56.1 |
| 1080p webgl2 dirty | 0.10 / 0.13 | 60.0 | 0.11 / 0.25 | 57.4 |
| 1080p 2d full (copy 0.7) | 1.30 / 1.50 | 60.0 | 1.40 / 2.78 | 55.9 |
| 1080p 2d dirty (copy 0.1) | 0.16 / 0.32 | 60.0 | 0.17 / 0.35 | 58.1 |
| 1440p webgl2 full | 1.31 / 1.95 | 59.0 | 1.02 / 1.33 | 56.2 |
| 1440p webgl2 dirty | 0.16 / 0.19 | 60.0 | 0.11 / 0.32 | 57.1 |
| 1440p 2d full (copy 1.4–2.0) | 2.64 / 3.41 | **45.2** | 3.21 / 3.95 | 57.6 |
| 1440p 2d dirty (copy 0.1) | 0.19 / 0.30 | 60.0 | 0.22 / 0.47 | 57.1 |
| 1080p webgl2 full **sync** | 0.67 / 0.76 | 60.0 | 0.70 / 1.25 | 55.8 |
| 1440p webgl2 full **sync** | 1.34 / 1.95 | 60.0 | 1.03 / 1.27 | 60.6 |

Windowed fps hovering at 56–58 is the guibox compositor's pacing, not blit cost (same fps at
0.1 ms and 3.2 ms blit). The one real fps casualty: **2d full-frame at 1440p headless drops to
45 fps** — putImageData + software compositing blows the frame budget outside the measured call.

Fake-engine paint cost for reference (worker-side, memcpy-based gradient): ~1.2–2.7 ms full
frame; irrelevant to blit but shows the SAB write side is cheap.

## Input round-trip latency (pointer event capture → worker drain+ack → observed on main)

Across configs: **avg ~5–14 ms, p95 ~19–31 ms, max ~34 ms** (headless slightly lower than
windowed). The dominant term is measurement quantization: acks are observed on the next rAF
tick (up to 16.7 ms), and the injector fires between frames. The worker itself wakes on
`Atomics.notify` within the same millisecond. Zero ring overflows/drops at 30 events/s; ring
capacity 256 gives huge headroom against real input rates.

## Recommendation (open-questions #10)

Default to **WebGL2 texSubImage2D straight from the SAB view** on the main thread: 0.7 ms per
full 1080p frame and ~1.0–1.3 ms at 1440p (p95 < 2 ms) on both a real GPU and SwiftShader, no
staging copy needed on Chromium 150, and cost is flat whether or not the GPU is real — worst
case (software WebGL) still leaves >90 % of the frame budget. Keep putImageData as the
compat/debug fallback only: it's 2–3× the cost, always pays a full SAB copy, and is the one
configuration that dropped frames (1440p full, headless). Dirty-rect upload is cheap to plumb
(a contiguous row-band is a single subarray + offset upload on both paths) and cuts blit cost
6–15× when ~10 % of rows change — worth carrying row-band dirty info out of the engine from
day one, but full-frame-every-frame is comfortably affordable, so dirty rects are an
optimization, not a requirement. A render-worker/OffscreenCanvas variant wasn't needed at
these numbers; revisit only if the main thread gets congested once the real engine lands.
