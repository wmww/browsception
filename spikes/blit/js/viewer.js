// Viewer skeleton: owns the SAB + fake-engine worker, blits each rAF via the
// selected blit path, captures input, runs the HUD, and exposes
// globalThis.__blitStats / __injectTestInput for programmatic measurement.

import { CTRL, F64, RESOLUTIONS, sabByteLength, makeViews } from './layout.js';
import { createWebGL2Blitter } from './blit/webgl2.js';
import { createCanvas2DBlitter } from './blit/canvas2d.js';
import { attachInput } from './input.js';
import { Rolling, FpsCounter } from './stats.js';
import { createHud } from './hud.js';

const params = new URLSearchParams(location.search);
const config = {
  res: RESOLUTIONS[params.get('res')] ? params.get('res') : '1080',
  path: params.get('path') === '2d' ? '2d' : 'webgl2',
  mode: params.get('mode') === 'dirty' ? 'dirty' : 'full',
  sync: params.get('sync') === '1', // webgl2: gl.finish() each blit (measurement)
};

const container = document.getElementById('view');
const hud = createHud(document.getElementById('hud'));

// Reflect config in the UI selectors; changing one reloads with new params.
for (const key of ['res', 'path', 'mode']) {
  const sel = document.getElementById('sel-' + key);
  sel.value = config[key];
  sel.onchange = () => {
    params.set(key, sel.value);
    location.search = params.toString();
  };
}

if (!crossOriginIsolated) {
  document.getElementById('hud').textContent =
    'crossOriginIsolated is false - SharedArrayBuffer unavailable. Serve via server.mjs.';
  throw new Error('not crossOriginIsolated');
}

// --- engine + framebuffer -------------------------------------------------

const { width, height } = RESOLUTIONS[config.res];
const sab = new SharedArrayBuffer(sabByteLength(width, height));
const views = makeViews(sab, width, height);
const { ctrl } = views;

const worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
worker.postMessage({ cmd: 'start', sab, width, height, mode: config.mode });

// --- canvas + blit path ---------------------------------------------------

const canvas = document.createElement('canvas');
canvas.tabIndex = 0;
container.appendChild(canvas);

const blitter = config.path === '2d'
  ? createCanvas2DBlitter(canvas, width, height)
  : createWebGL2Blitter(canvas, width, height, { sync: config.sync });

// Backing-store size tracks CSS box x devicePixelRatio (webgl2 path only; the
// 2d path's backing store is pinned to framebuffer size, CSS scales it).
new ResizeObserver((entries) => {
  const box = entries[0].devicePixelContentBoxSize?.[0];
  const w = box ? box.inlineSize : Math.round(canvas.clientWidth * devicePixelRatio);
  const h = box ? box.blockSize : Math.round(canvas.clientHeight * devicePixelRatio);
  if (w && h) blitter.resize(w, h);
}).observe(canvas);

const inputWriter = attachInput(canvas, sab, ctrl, () => ({ width, height }));

// --- rAF blit loop + metrics ----------------------------------------------

const blitStats = new Rolling(240);
const copyStats = new Rolling(240);
const latencyStats = new Rolling(240);
const fps = new FpsCounter();
let lastSeq = 0;
let lastAckSeq = 0;

function frame(now) {
  const seq = Atomics.load(ctrl, CTRL.FRAME_SEQ);
  if (seq !== lastSeq) {
    lastSeq = seq;
    const dirty = config.mode === 'dirty'
      ? { y0: Atomics.load(ctrl, CTRL.DIRTY_Y0), y1: Atomics.load(ctrl, CTRL.DIRTY_Y1) }
      : null;
    const t0 = performance.now();
    const { copyMs } = blitter.blit(views.fb8, dirty);
    blitStats.push(performance.now() - t0);
    copyStats.push(copyMs);
    fps.frame(now);
  }
  // Input round-trip: event capture (timestamp) -> worker drained+acked -> seen here.
  const ackSeq = Atomics.load(ctrl, CTRL.ACK_SEQ);
  if (ackSeq !== lastAckSeq) {
    lastAckSeq = ackSeq;
    latencyStats.push(performance.now() - views.f64[F64.ACK_TS]);
  }
  hud.update(now, snapshot());
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function snapshot() {
  return {
    resolution: `${width}x${height}`,
    path: blitter.name,
    mode: config.mode,
    sync: config.sync,
    sabDirect: blitter.sabDirect,
    renderer: blitter.renderer,
    crossOriginIsolated,
    dpr: devicePixelRatio,
    fps: fps.fps,
    blit: blitStats.summary(),
    copy: copyStats.summary(),
    latency: latencyStats.summary(),
    engineFrameMs: Atomics.load(ctrl, CTRL.ENGINE_FRAME_US) / 1000,
    events: {
      pointer: Atomics.load(ctrl, CTRL.EV_POINTER),
      wheel: Atomics.load(ctrl, CTRL.EV_WHEEL),
      key: Atomics.load(ctrl, CTRL.EV_KEY),
      acked: Atomics.load(ctrl, CTRL.ACK_COUNT),
      dropped: inputWriter.dropped,
    },
  };
}

// --- programmatic measurement API -----------------------------------------

globalThis.__blitStats = {
  snapshot,
  reset() {
    blitStats.reset();
    copyStats.reset();
    latencyStats.reset();
    fps.reset();
  },
};

// Dispatch n synthetic pointermove events through the real capture path.
globalThis.__injectTestInput = (n = 1) => {
  const rect = canvas.getBoundingClientRect();
  for (let i = 0; i < n; i++) {
    canvas.dispatchEvent(new PointerEvent('pointermove', {
      clientX: rect.left + Math.random() * rect.width,
      clientY: rect.top + Math.random() * rect.height,
      bubbles: true,
    }));
  }
};

globalThis.__benchReady = true;
