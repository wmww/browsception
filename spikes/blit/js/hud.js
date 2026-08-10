// HUD overlay: fps, blit ms, input round-trip latency, engine echo counters.

export function createHud(el) {
  let last = 0;
  return {
    update(now, snap) {
      if (now - last < 250) return;
      last = now;
      const f = (x, d = 2) => x.toFixed(d);
      el.textContent = [
        `${snap.resolution}  ${snap.path}${snap.sabDirect ? ' (SAB-direct)' : ' (copy)'}  ${snap.mode}`,
        `fps        ${f(snap.fps, 1)}`,
        `blit ms    avg ${f(snap.blit.avg)}  p95 ${f(snap.blit.p95)}  max ${f(snap.blit.max)}`,
        `copy ms    avg ${f(snap.copy.avg)}  p95 ${f(snap.copy.p95)}`,
        `latency ms avg ${f(snap.latency.avg)}  p95 ${f(snap.latency.p95)}  n ${snap.latency.n}`,
        `engine     render ${f(snap.engineFrameMs)}ms  ptr ${snap.events.pointer}  whl ${snap.events.wheel}  key ${snap.events.key}  drop ${snap.events.dropped}`,
        `renderer   ${snap.renderer}`,
        `isolated   ${crossOriginIsolated}`,
      ].join('\n');
    },
  };
}
