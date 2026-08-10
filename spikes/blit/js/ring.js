// SPSC input-event ring buffer in the SAB. Main thread writes, engine worker reads.
// Record layout (10 x int32 = 40 bytes):
//   [0] type  [1] seq  [2] x  [3] y  [4] a  [5] b  [6] mods  [7] pad
//   [8..9] float64 timestamp (main-thread performance.now())

import { CTRL, RING_BYTE_OFFSET, RING_CAPACITY, RING_RECORD_I32 } from './layout.js';

export const EV = {
  POINTER_DOWN: 1,
  POINTER_MOVE: 2,
  POINTER_UP: 3,
  POINTER_CANCEL: 4,
  WHEEL: 5,
  KEY_DOWN: 6,
  KEY_UP: 7,
};

function ringViews(sab) {
  const i32 = new Int32Array(sab, RING_BYTE_OFFSET, RING_CAPACITY * RING_RECORD_I32);
  const f64 = new Float64Array(sab, RING_BYTE_OFFSET, RING_CAPACITY * RING_RECORD_I32 / 2);
  return { i32, f64 };
}

export class RingWriter {
  constructor(sab, ctrl) {
    Object.assign(this, ringViews(sab));
    this.ctrl = ctrl;
    this.seq = 0;
    this.dropped = 0;
  }

  // Returns the event seq, or -1 if the ring was full (event dropped).
  push(type, x, y, a, b, mods, timestamp) {
    const head = Atomics.load(this.ctrl, CTRL.RING_HEAD);
    const tail = Atomics.load(this.ctrl, CTRL.RING_TAIL);
    if (head - tail >= RING_CAPACITY) {
      this.dropped++;
      return -1;
    }
    const seq = ++this.seq;
    const base = (head & (RING_CAPACITY - 1)) * RING_RECORD_I32;
    const i32 = this.i32;
    i32[base] = type;
    i32[base + 1] = seq;
    i32[base + 2] = x | 0;
    i32[base + 3] = y | 0;
    i32[base + 4] = a | 0;
    i32[base + 5] = b | 0;
    i32[base + 6] = mods | 0;
    this.f64[(base + 8) / 2] = timestamp;
    Atomics.store(this.ctrl, CTRL.RING_HEAD, head + 1);
    // Wake the engine if it's sleeping between frames.
    Atomics.notify(this.ctrl, CTRL.WAKE);
    return seq;
  }
}

export class RingReader {
  constructor(sab, ctrl) {
    Object.assign(this, ringViews(sab));
    this.ctrl = ctrl;
  }

  // Drain all pending records, invoking cb(record) for each.
  // Returns number of records drained.
  drain(cb) {
    const head = Atomics.load(this.ctrl, CTRL.RING_HEAD);
    let tail = Atomics.load(this.ctrl, CTRL.RING_TAIL);
    const n = head - tail;
    const rec = {};
    for (; tail < head; tail++) {
      const base = (tail & (RING_CAPACITY - 1)) * RING_RECORD_I32;
      const i32 = this.i32;
      rec.type = i32[base];
      rec.seq = i32[base + 1];
      rec.x = i32[base + 2];
      rec.y = i32[base + 3];
      rec.a = i32[base + 4];
      rec.b = i32[base + 5];
      rec.mods = i32[base + 6];
      rec.timestamp = this.f64[(base + 8) / 2];
      cb(rec);
    }
    if (n > 0) Atomics.store(this.ctrl, CTRL.RING_TAIL, head);
    return n;
  }
}
