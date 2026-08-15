// In-page instrumentation for bench runs. Everything here is stringified into
// the VIEWER page by playwright, so each function must be self-contained (no
// module scope, no closures over node values).
//
// Why host-side numbers are not optional (notes/perf-measurement.md § Bench
// metrics): BIBPERF busy% covers the engine thread only, so work moved across
// the wasm boundary — presentation, blit, main-thread jank — reads as a free
// win unless the host is measured too.

/** Installed once per page, after __bs.ready. Exposes window.__bench. */
export function installBench() {
  if (globalThis.__bench) return 'already';
  const M = globalThis.Module;
  const bs = globalThis.__bs;
  const B = (globalThis.__bench = {
    frames: 0,
    frameTs: [],
    presentMs: 0,        // time inside the bibFrame wrapper (canvas blit lives there)
    longtaskN: 0,
    longtaskMs: 0,
    rafIntervals: [],
    wheelCalls: 0,       // _bib_wheel entries (null-safe: hook is feature-detected)
    wheelPx: 0,
    dispatched: 0,
    dispatchedPx: 0,
    watch: null,
    hooks: { frame: false, wheel: false, longtask: false },
  });

  // --- presented-frame timestamps + host present cost ---------------------
  if (typeof M?.bibFrame === 'function') {
    const raw = M.bibFrame;
    M.bibFrame = function (ptr, fbW, fbH, stride, x, y, w, h) {
      const t0 = performance.now();
      const r = raw.apply(this, arguments);
      const t1 = performance.now();
      B.frames++;
      B.presentMs += t1 - t0;
      if (B.frameTs.length < 100000) B.frameTs.push(t1);
      const wch = B.watch;
      if (wch) {
        // Read the watched pixel straight out of the framebuffer: no readback,
        // no extra engine work, and the timestamp is the frame that carried it.
        try {
          if (wch.x < fbW && wch.y < fbH) {
            const off = ptr + wch.y * stride + wch.x * 4;
            const px = new Uint8Array(M.HEAPU8.buffer, off, 3);
            const hit = wch.want
              ? Math.abs(px[0] - wch.want[0]) <= wch.tol && Math.abs(px[1] - wch.want[1]) <= wch.tol
                && Math.abs(px[2] - wch.want[2]) <= wch.tol
              : Math.abs(px[0] - wch.from[0]) > wch.tol || Math.abs(px[1] - wch.from[1]) > wch.tol
                || Math.abs(px[2] - wch.from[2]) > wch.tol;
            if (hit) {
              B.watch = null;
              wch.resolve({ ms: t1 - wch.t0, px: [px[0], px[1], px[2]], at: t1 });
            }
          }
        } catch (e) { /* heap grew under us; next frame re-reads */ }
      }
      return r;
    };
    B.hooks.frame = true;
  }

  // --- wheel entries actually reaching the engine -------------------------
  if (typeof M?._bib_wheel === 'function') {
    const raw = M._bib_wheel.bind(M);
    M._bib_wheel = (x, y, dx, dy, mods) => {
      B.wheelCalls++;
      B.wheelPx += Math.abs(dy);
      return raw(x, y, dx, dy, mods);
    };
    B.hooks.wheel = true;
  }

  // --- host main-thread saturation ----------------------------------------
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        B.longtaskN++;
        B.longtaskMs += e.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
    B.hooks.longtask = true;
  } catch (e) { /* no longtask support: recorded as absent */ }

  const canvas = () => document.getElementById('screen');
  const centre = () => {
    const r = canvas().getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };
  // Canvas CSS px for a framebuffer device-px point.
  B.cssAt = (x, y) => {
    const c = canvas(), r = c.getBoundingClientRect();
    return [r.left + x * (r.width / (c.width || 1)), r.top + y * (r.height / (c.height || 1))];
  };

  B.reset = () => {
    B.frames = 0;
    B.frameTs.length = 0;
    B.presentMs = 0;
    B.longtaskN = 0;
    B.longtaskMs = 0;
    B.rafIntervals.length = 0;
    B.wheelCalls = 0;
    B.wheelPx = 0;
    B.dispatched = 0;
    B.dispatchedPx = 0;
  };

  B.snapshot = () => ({
    frames: B.frames,
    presentMs: B.presentMs,
    longtaskN: B.longtaskN,
    longtaskMs: B.longtaskMs,
    rafIntervals: B.rafIntervals.slice(),
    wheelCalls: B.wheelCalls,
    wheelPx: B.wheelPx,
    dispatched: B.dispatched,
    dispatchedPx: B.dispatchedPx,
    hooks: B.hooks,
    firstFrameTs: B.frameTs[0] ?? null,
    lastFrameTs: B.frameTs[B.frameTs.length - 1] ?? null,
  });

  // --- pixel decoding ------------------------------------------------------
  // Scroll ruler: 120 px blocks, colour rgb(i & 255, i >> 8, 128) (fixtures).
  B.offset = async () => {
    const px = await bs.probe(4, 4);
    return px ? (px[0] + (px[1] << 8)) * 120 : null;
  };
  // Counter block: rgb(n & 255, n >> 8, 64) at the top-left (app-update, js-churn).
  B.counter = async () => {
    const px = await bs.probe(4, 4);
    return px ? px[0] + (px[1] << 8) : null;
  };
  // Whole-frame end-state fingerprint: one readback, sparse walk. "Fast
  // because it stopped painting correctly" has to read as a different number.
  B.checksum = async () => {
    const f = await bs.readback();
    if (!f) return null;
    let hash = 2166136261;
    for (let i = 0; i < f.data.length; i += 1021) hash = Math.imul(hash ^ f.data[i], 16777619);
    return { hash: hash >>> 0, w: f.w, h: f.h };
  };

  // --- waiting -------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Resolve once no frame has been presented for `quietMs`. */
  B.waitQuiet = async (quietMs, timeoutMs) => {
    const t0 = performance.now();
    let last = B.frames;
    let lastChange = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      await sleep(50);
      if (B.frames !== last) {
        last = B.frames;
        lastChange = performance.now();
      } else if (performance.now() - lastChange >= quietMs) return true;
    }
    return false;
  };

  // --- input ---------------------------------------------------------------
  B.wheelAt = (x, y, dy) => {
    const c = canvas();
    c.dispatchEvent(new WheelEvent('wheel', {
      deltaY: dy, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
    B.dispatched++;
    B.dispatchedPx += dy;
  };

  /** Wheel at a fixed px-per-HOST-FRAME rate (x ~60 for px/s). */
  B.drive = async ({ pxPerFrame, epf = 1, stride = 1, ms }) => {
    const [cx, cy] = centre();
    const per = (pxPerFrame * stride) / epf;
    const start = performance.now();
    const end = start + ms;
    let frame = 0;
    let prev = start;
    while (performance.now() < end) {
      for (let i = 0; frame % stride === 0 && i < epf; i++) B.wheelAt(cx, cy, per);
      frame++;
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      B.rafIntervals.push(now - prev);
      prev = now;
    }
    return { start, end: performance.now(), frames: frame };
  };

  /** No input at all: just hold the window open and sample rAF intervals. */
  B.idle = async (ms) => {
    const start = performance.now();
    let prev = start;
    while (performance.now() - start < ms) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      B.rafIntervals.push(now - prev);
      prev = now;
    }
    return { start, end: performance.now() };
  };

  /** Back to the top and settled, so no run inherits the previous one's backlog. */
  B.resetScroll = async (timeoutMs) => {
    const [cx, cy] = centre();
    for (let i = 0; i < 5; i++) {
      B.wheelAt(cx, cy, -1e7);
      await new Promise((r) => requestAnimationFrame(r));
    }
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const off = await B.offset();
      const n = B.frames;
      await sleep(300);
      if (off === 0 && B.frames === n) return true;
    }
    return false;
  };

  /** Arm the framebuffer pixel watcher, then run `fire`. Resolves with latency. */
  B.awaitPixel = (x, y, { want = null, from = null, tol = 6, timeoutMs = 5000 }, fire) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (B.watch && B.watch.timer === timer) B.watch = null;
        resolve(null);
      }, timeoutMs);
      B.watch = {
        x, y, want, from, tol, timer,
        t0: performance.now(),
        resolve: (r) => { clearTimeout(timer); resolve(r); },
      };
      // t0 must bracket the dispatch, not the arming.
      B.watch.t0 = performance.now();
      fire();
    });

  B.clickAt = (x, y) => {
    const c = canvas();
    const [cx, cy] = B.cssAt(x, y);
    const opts = { clientX: cx, clientY: cy, button: 0, buttons: 1, detail: 1, bubbles: true, cancelable: true };
    c.dispatchEvent(new MouseEvent('mousemove', { ...opts, buttons: 0 }));
    c.dispatchEvent(new MouseEvent('mousedown', opts));
    c.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
  };

  B.typeChar = (ch) => {
    const c = canvas();
    const code = ch.charCodeAt(0);
    const init = {
      key: ch, code: 'Key' + ch.toUpperCase(), keyCode: code, which: code,
      bubbles: true, cancelable: true,
    };
    c.dispatchEvent(new KeyboardEvent('keydown', init));
    c.dispatchEvent(new KeyboardEvent('keyup', init));
  };

  return 'installed';
}

/**
 * Runs BEFORE any page script (addInitScript), so nothing about boot is
 * missed. Stamps the first presented frame and — given a watch spec — the
 * first frame whose framebuffer actually carries the target page's
 * verification pixel (engine startup vs the page becoming visible).
 * @param {{x:number,y:number,rgb:number[],tol?:number}|null} watch
 */
export function bootProbe(watch) {
  let value;
  Object.defineProperty(window, 'Module', {
    configurable: true,
    get: () => value,
    set(v) {
      value = v;
      if (v && typeof v.bibFrame === 'function' && !v.__benchBootWrapped) {
        const raw = v.bibFrame;
        v.__benchBootWrapped = true;
        v.bibFrame = function (ptr, fbW, fbH, stride) {
          if (window.__benchFirstFrameMs == null) window.__benchFirstFrameMs = performance.now();
          if (watch && window.__benchWatchMs == null) {
            try {
              if (watch.x < fbW && watch.y < fbH) {
                const off = ptr + watch.y * stride + watch.x * 4;
                const px = new Uint8Array(v.HEAPU8.buffer, off, 3);
                const tol = watch.tol ?? 6;
                if (Math.abs(px[0] - watch.rgb[0]) <= tol && Math.abs(px[1] - watch.rgb[1]) <= tol
                    && Math.abs(px[2] - watch.rgb[2]) <= tol)
                  window.__benchWatchMs = performance.now();
              }
            } catch (e) { /* heap grew; next frame re-reads */ }
          }
          return raw.apply(this, arguments);
        };
      }
    },
  });
}
