// Fake engine: paints an animated test pattern into the SAB framebuffer at ~60 fps
// and drains/acks the input ring. Stands in for wasm WebKit in spike 0.4.

import { CTRL, F64, makeViews } from './layout.js';
import { RingReader, EV } from './ring.js';

const FRAME_INTERVAL_MS = 1000 / 60;

let views, width, height, mode, reader;
let gradientRow;      // 2*width premade gradient pixels; rows copy a rotated window
let frame = 0;

onmessage = (e) => {
  const msg = e.data;
  if (msg.cmd !== 'start') return;
  ({ width, height, mode } = msg);
  views = makeViews(msg.sab, width, height);
  reader = new RingReader(msg.sab, views.ctrl);
  buildGradient();
  Atomics.store(views.ctrl, CTRL.RUN, 1);
  loop();
};

function buildGradient() {
  // Two periods of a hue sweep so any window [i, i+width) is a full gradient.
  gradientRow = new Uint32Array(width * 2);
  for (let x = 0; x < width * 2; x++) {
    const t = (x % width) / width;
    const r = Math.round(255 * Math.abs(Math.sin(Math.PI * t)));
    const g = Math.round(255 * Math.abs(Math.sin(Math.PI * (t + 1 / 3))));
    const b = Math.round(255 * Math.abs(Math.sin(Math.PI * (t + 2 / 3))));
    gradientRow[x] = 0xff000000 | (b << 16) | (g << 8) | r; // RGBA little-endian
  }
}

function paintRows(y0, y1, phase) {
  const { fb32 } = views;
  for (let y = y0; y < y1; y++) {
    const shift = (phase + y) % width;
    fb32.set(gradientRow.subarray(shift, shift + width), y * width);
  }
}

// 16 binary-coded squares showing the frame counter, plus a parity flash block.
function paintCounterBlock() {
  const { fb32 } = views;
  const cell = 16;
  for (let bit = 0; bit < 16; bit++) {
    const on = (frame >> bit) & 1;
    const color = on ? 0xffffffff : 0xff000000;
    const x0 = 8 + bit * (cell + 4);
    for (let y = 8; y < 8 + cell; y++) {
      fb32.fill(color, y * width + x0, y * width + x0 + cell);
    }
  }
  // Last-pointer-position crosshair block (visual echo of input).
  const px = Atomics.load(views.ctrl, CTRL.LAST_X);
  const py = Atomics.load(views.ctrl, CTRL.LAST_Y);
  if (px > 8 && py > 8 && px < width - 8 && py < height - 8) {
    for (let y = py - 8; y < py + 8; y++) {
      fb32.fill(0xff000000, y * width + px - 8, y * width + px + 8);
    }
  }
}

function renderFrame() {
  const t0 = performance.now();
  const { ctrl } = views;
  const phase = (frame * 6) % width;
  let y0, y1;
  if (mode === 'dirty' && frame > 0) { // frame 0 paints in full
    // A band of ~10% of rows repaints each frame; it slowly walks down the frame.
    const bandH = Math.floor(height / 10);
    y0 = (frame * 3) % (height - bandH);
    y1 = y0 + bandH;
    paintRows(y0, y1, phase);
  } else {
    y0 = 0;
    y1 = height;
    paintRows(0, height, phase);
    paintCounterBlock();
  }
  frame++;
  Atomics.store(ctrl, CTRL.DIRTY_Y0, y0);
  Atomics.store(ctrl, CTRL.DIRTY_Y1, y1);
  Atomics.store(ctrl, CTRL.ENGINE_FRAME_US, Math.round((performance.now() - t0) * 1000));
  Atomics.add(ctrl, CTRL.FRAME_SEQ, 1);
}

function drainInput() {
  const { ctrl, f64 } = views;
  let lastSeq = 0, lastTs = 0;
  const n = reader.drain((rec) => {
    lastSeq = rec.seq;
    if (rec.timestamp > lastTs) lastTs = rec.timestamp;
    switch (rec.type) {
      case EV.POINTER_DOWN: case EV.POINTER_MOVE:
      case EV.POINTER_UP: case EV.POINTER_CANCEL:
        Atomics.add(ctrl, CTRL.EV_POINTER, 1);
        Atomics.store(ctrl, CTRL.LAST_X, rec.x);
        Atomics.store(ctrl, CTRL.LAST_Y, rec.y);
        break;
      case EV.WHEEL:
        Atomics.add(ctrl, CTRL.EV_WHEEL, 1);
        break;
      case EV.KEY_DOWN: case EV.KEY_UP:
        Atomics.add(ctrl, CTRL.EV_KEY, 1);
        break;
    }
  });
  if (n > 0) {
    // Publish ack: timestamp first, then seq (viewer reads seq, then timestamp).
    f64[F64.ACK_TS] = lastTs;
    Atomics.add(ctrl, CTRL.ACK_COUNT, n);
    Atomics.store(ctrl, CTRL.ACK_SEQ, lastSeq);
  }
  return n;
}

function loop() {
  const { ctrl } = views;
  let next = performance.now();
  while (Atomics.load(ctrl, CTRL.RUN) === 1) {
    drainInput();
    renderFrame();
    next += FRAME_INTERVAL_MS;
    // Sleep until the next frame, waking early when input arrives so acks are
    // prompt (this is the latency path the real engine will need too).
    for (;;) {
      const now = performance.now();
      const remaining = next - now;
      if (remaining <= 0) { if (remaining < -100) next = now; break; }
      Atomics.wait(ctrl, CTRL.WAKE, 0, remaining);
      if (drainInput() === 0) continue; // spurious/timeout wake
    }
  }
}
