// SharedArrayBuffer layout shared by viewer (main thread) and fake engine (worker).
//
//   [0      .. 128)   control words (Int32Array CTRL.*)
//   [128    .. 256)   float64 slots (Float64Array F64.*)
//   [256    .. 16384) input ring buffer (see ring.js)
//   [16384  .. end)   framebuffer, RGBA8888, tightly packed, row 0 = top

export const CTRL = {
  FRAME_SEQ: 0,   // engine increments after finishing a frame
  DIRTY_Y0: 1,    // first dirty row of the latest frame (inclusive)
  DIRTY_Y1: 2,    // last dirty row (exclusive)
  WAKE: 3,        // futex word: main notifies to wake engine early for input
  RING_HEAD: 4,   // next record index to write (main)
  RING_TAIL: 5,   // next record index to read (engine)
  ACK_SEQ: 6,     // seq of last input event the engine processed
  ACK_COUNT: 7,   // total input events the engine processed
  EV_POINTER: 8,  // per-class counters (engine-side echo)
  EV_WHEEL: 9,
  EV_KEY: 10,
  LAST_X: 11,     // framebuffer coords of last pointer event seen by engine
  LAST_Y: 12,
  ENGINE_FRAME_US: 13, // engine-side render cost of last frame, microseconds
  RUN: 14,        // 0 = stop, engine loop exits
};

export const F64 = {
  ACK_TS: 0,      // original main-thread timestamp of the newest drained event
};

export const F64_BYTE_OFFSET = 128;
export const RING_BYTE_OFFSET = 256;
export const RING_CAPACITY = 256;      // records (power of two)
export const RING_RECORD_I32 = 10;     // 40 bytes per record (8-byte aligned)
export const FB_BYTE_OFFSET = 16384;

export const RESOLUTIONS = {
  '1080': { width: 1920, height: 1080 },
  '1440': { width: 2560, height: 1440 },
};

export function sabByteLength(width, height) {
  return FB_BYTE_OFFSET + width * height * 4;
}

// Views over a SAB following this layout.
export function makeViews(sab, width, height) {
  return {
    ctrl: new Int32Array(sab, 0, 32),
    f64: new Float64Array(sab, F64_BYTE_OFFSET, 16),
    fb8: new Uint8Array(sab, FB_BYTE_OFFSET, width * height * 4),
    fb32: new Uint32Array(sab, FB_BYTE_OFFSET, width * height),
  };
}
