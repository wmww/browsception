// BIBPERF (?perflog=1) console-line parsing + windowed aggregation.
//
// Part of the suite's narrow contract with the code under test
// (notes/perf-measurement.md § Bench contract): fields are OPTIONAL. Engines
// older or newer than the runner simply report fewer/more of them, and every
// consumer must treat null as "this target does not report it" rather than 0.
//
// Current line (2026-08 engine):
//   BIBPERF/s ticks=N painted=N elapsed=Nms busy=N% heap=NMB jsc=NMB |
//   runloop(JS)=N renderUpd=N layout=N paint=N pushOther=N persist=N ms |
//   pump=N(maxN nN) | wheel=N(nN evN qN) blit=N(mvN wrN nN fbN rowsN) |
//   avgPaintedFrame=Nms
// Newer engines may add: paintRects=N(<total>Mpx, <X>Mpx/frame)

const FIELDS = {
  ticks: /ticks=(-?[\d.]+)/,
  painted: /painted=(-?[\d.]+)/,
  elapsedMs: /elapsed=(-?[\d.]+)ms/,
  busyPct: /busy=(-?[\d.]+)%/,
  heapMB: /heap=(-?[\d.]+)MB/,
  jscMB: /jsc=(-?[\d.]+)MB/,
  runloopMs: /runloop\(JS\)=(-?[\d.]+)/,
  renderUpdMs: /renderUpd=(-?[\d.]+)/,
  layoutMs: /layout=(-?[\d.]+)/,
  paintMs: /paint=(-?[\d.]+)/,
  // Legacy: engines before 2026-08-15 (the GPU path) reported a present phase.
  presentMs: /present=(-?[\d.]+)/,
  pushOtherMs: /pushOther=(-?[\d.]+)/,
  persistMs: /persist=(-?[\d.]+)/,
  pumpMs: /pump=(-?[\d.]+)\(/,
  pumpMaxMs: /pump=[\d.]+\(max(-?[\d.]+)/,
  pumps: /pump=[\d.]+\(max[\d.]+ n(-?[\d.]+)\)/,
  wheelMs: /wheel=(-?[\d.]+)\(/,
  wheelApplied: /wheel=[\d.]+\(n(-?[\d.]+)/,
  wheelEvents: /wheel=[\d.]+\(n[\d.]+ ev(-?[\d.]+)/,
  wheelQueueMax: /wheel=[\d.]+\(n[\d.]+ ev[\d.]+ q(-?[\d.]+)\)/,
  blitMs: /blit=(-?[\d.]+)\(/,
  blitMoveMs: /blit=[\d.]+\(mv(-?[\d.]+)/,
  blitWriteMs: /blit=[\d.]+\(mv[\d.]+ wr(-?[\d.]+)/,
  blits: /blit=[\d.]+\(mv[\d.]+ wr[\d.]+ n(-?[\d.]+)/,
  blitFallbacks: /blit=[\d.]+\(mv[\d.]+ wr[\d.]+ n[\d.]+ fb(-?[\d.]+)/,
  blitRows: /rows(-?[\d.]+)\)/,
  avgPaintedFrameMs: /avgPaintedFrame=(-?[\d.]+)/,
  // Only present on engines that carry the damage-degeneration signal.
  paintRects: /paintRects=(-?[\d.]+)\(/,
  paintMpx: /paintRects=[\d.]+\((-?[\d.]+)Mpx/,
  paintMpxPerFrame: /paintRects=[\d.]+\([\d.]+Mpx, (-?[\d.]+)Mpx\/frame/,
};

export const BIBPERF_FIELDS = Object.keys(FIELDS);

/** @returns {null | Record<string, number|null>} null if not a BIBPERF line. */
export function parseBibperf(text) {
  if (!text.includes('BIBPERF')) return null;
  const out = {};
  for (const [k, re] of Object.entries(FIELDS)) {
    const m = text.match(re);
    out[k] = m ? Number(m[1]) : null;
  }
  return out;
}

const sum = (ws, k) => {
  let t = null;
  for (const w of ws) if (w[k] != null) t = (t ?? 0) + w[k];
  return t;
};
const maxOf = (ws, k) => {
  let t = null;
  for (const w of ws) if (w[k] != null) t = t == null ? w[k] : Math.max(t, w[k]);
  return t;
};
const perSec = (ws, k) => {
  const s = sum(ws, k), e = sum(ws, 'elapsedMs');
  return s == null || !e ? null : (s / e) * 1000;
};

/**
 * Collapse the 1-Hz windows that fell inside a measured interval into one set
 * of rates. Weighted by each window's own elapsed time — windows are only
 * approximately 1 s, and a stalled engine emits long ones.
 */
export function aggregateWindows(windows) {
  const ws = windows.filter((w) => w && w.elapsedMs);
  if (!ws.length) return { windows: 0 };
  const elapsed = sum(ws, 'elapsedMs');
  const painted = sum(ws, 'painted');
  const wheelApplied = sum(ws, 'wheelApplied');
  const wheelEvents = sum(ws, 'wheelEvents');
  const avgFrames = ws.filter((w) => w.avgPaintedFrameMs != null && w.painted);
  const first = ws[0], last = ws[ws.length - 1];
  const growth = (k) => (first[k] == null || last[k] == null ? null : last[k] - first[k]);
  return {
    windows: ws.length,
    fps: painted == null ? null : (painted / elapsed) * 1000,
    ticksPerSec: perSec(ws, 'ticks'),
    busyPct: sum(ws, 'busyPct') == null ? null
      : ws.reduce((a, w) => a + (w.busyPct ?? 0) * w.elapsedMs, 0) / elapsed,
    paintMsPerSec: perSec(ws, 'paintMs'),
    layoutMsPerSec: perSec(ws, 'layoutMs'),
    renderUpdMsPerSec: perSec(ws, 'renderUpdMs'),
    presentMsPerSec: perSec(ws, 'presentMs'),
    runloopMsPerSec: perSec(ws, 'runloopMs'),
    wheelMsPerSec: perSec(ws, 'wheelMs'),
    blitMsPerSec: perSec(ws, 'blitMs'),
    avgPaintedFrameMs: avgFrames.length
      ? avgFrames.reduce((a, w) => a + w.avgPaintedFrameMs * w.painted, 0)
        / avgFrames.reduce((a, w) => a + w.painted, 0)
      : null,
    wheelQueueMax: maxOf(ws, 'wheelQueueMax'),
    // >1 means the engine merged host wheel events instead of walking the
    // framebuffer through positions it already knew were stale.
    wheelMergedRatio: wheelApplied ? wheelEvents / wheelApplied : null,
    blitFallbacks: sum(ws, 'blitFallbacks'),
    heapMB: last.heapMB,
    jscMB: last.jscMB,
    heapGrowthMB: growth('heapMB'),
    jscGrowthMB: growth('jscMB'),
    paintMpxPerFrame: ws.some((w) => w.paintMpxPerFrame != null)
      ? ws.reduce((a, w) => a + (w.paintMpxPerFrame ?? 0), 0) / ws.filter((w) => w.paintMpxPerFrame != null).length
      : null,
  };
}
