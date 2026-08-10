// Rolling sample window with avg/p95, used for blit cost and input latency.

export class Rolling {
  constructor(capacity = 240) {
    this.buf = new Float64Array(capacity);
    this.n = 0;
    this.i = 0;
  }

  push(v) {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
  }

  reset() { this.n = 0; this.i = 0; }

  summary() {
    if (this.n === 0) return { n: 0, avg: 0, p95: 0, max: 0 };
    const a = Array.from(this.buf.subarray(0, this.n)).sort((x, y) => x - y);
    const avg = a.reduce((s, v) => s + v, 0) / a.length;
    const p95 = a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
    return { n: a.length, avg, p95, max: a[a.length - 1] };
  }
}

export class FpsCounter {
  constructor() { this.frames = 0; this.t0 = performance.now(); this.fps = 0; }

  frame(now) {
    this.frames++;
    if (now - this.t0 >= 1000) {
      this.fps = this.frames * 1000 / (now - this.t0);
      this.frames = 0;
      this.t0 = now;
    }
  }

  reset() { this.frames = 0; this.t0 = performance.now(); this.fps = 0; }
}
