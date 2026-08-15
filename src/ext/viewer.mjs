// Viewer: hosts the real wasm engine inside the extension page (2.1), or the
// stub engine for tier-1 bridge tests (?stub=1).
//
// Real-engine mode is a port of the engine repo's dev harness scaffolding
// (engine/WebkitWasm/web/browser.html) minus its dev-only paths: raster only
// (no nested GPU — security.md), no media bridge, no guest-wasm
// polyfill yet (guest wasm sees CompileError; fast-follow). Networking is the
// real bridge (src/shim/bridge.mjs): guard list, DNR header rules, webRequest
// Set-Cookie/redirect capture.

import { ABI_VERSION, NET_ERR } from '../abi/abi.mjs';
import { Bridge } from '../shim/bridge.mjs';
import { RedirectCapture } from '../shim/redirect-capture.mjs';
import { createStubModule } from '../shim/engine-stub.mjs';
import { createPresenter } from './blit.mjs';
import { shouldSandbox } from './dnr-rules.mjs';
import { getState, onStateChanged } from './state.mjs';

// Viewer params must precede url= — the raw target URL after it may contain
// its own query (&stub=, &blit=, …) that must NOT be read as ours.
const _urlIdx = location.search.indexOf('url=');
const params = new URLSearchParams(
  _urlIdx >= 0 ? location.search.slice(0, _urlIdx) : location.search,
);
const bootEl = document.getElementById('boot');
const statusEl = document.getElementById('status');
const canvas = document.getElementById('screen');

// ---------------------------------------------------------------- tier-1 stub
// Test hook: (re)create a stub-engine + bridge pair with the given overrides.
let current = null;
globalThis.__bsBoot = async (opts = {}) => {
  if (current) await current.bridge.dispose();
  const module = createStubModule(opts.stub ?? {});
  const mainFailures = [];
  const bridge = new Bridge(module, {
    capture: new RedirectCapture(),
    onMainLoadFailed: (url, kind, message) => mainFailures.push({ url, kind, message }),
    userAgent: opts.userAgent ?? 'BrowsceptionBridge/0.1',
    guardOpts: opts.guardOpts,
    maxResponseBytes: opts.maxResponseBytes,
    idleTimeoutMs: opts.idleTimeoutMs,
    windowBytes: opts.windowBytes,
  });
  await bridge.init();
  current = { module, bridge };
  globalThis.__bs = {
    abiVersion: ABI_VERSION,
    request: (req) => module.stub.request(req),
    cancel: (id) => module.stub.cancel(id),
    mainFailures,
    capturePending: () => bridge.capture.pending(),
    liveAllocs: () => module.stub.liveAllocs(),
  };
  return true;
};

// The DNR redirect's \0 carries the matched URL RAW (un-encoded), so the
// target's own query would be truncated by URLSearchParams — slice at the
// first "url=" instead. Manual/test paths pass it percent-encoded; decode
// only that form. A raw target's #fragment ends up as OUR fragment (the tab
// URLs we write back carry it), so it has to be glued back on.
function rawUrlParam() {
  const q = location.search;
  const i = q.indexOf('url=');
  if (i < 0) return null;
  let raw = q.slice(i + 4);
  if (/^https?%3A/i.test(raw)) {
    try {
      raw = decodeURIComponent(raw);
    } catch {}
    return raw;
  }
  return raw + location.hash;
}

// http(s) only: anything else must never reach bib_load_url (?url= arrives
// from arbitrary intercepted navigations).
function normalizeEngineURL(raw) {
  let url = (raw ?? '').trim();
  if (!url) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return url;
}

// ---------------------------------------------------------------- real engine
async function bootEngine() {
  const t0 = performance.now();
  const rawURL = rawUrlParam();
  const navigateURL = normalizeEngineURL(rawURL);
  if (rawURL && !navigateURL) {
    bootEl.textContent = 'blocked: only http(s) URLs';
    return;
  }

  const presenter = createPresenter(canvas, params.get('blit'));
  const setStatus = (s) => (statusEl.textContent = s);
  const urlbarEl = document.getElementById('urlbar');
  const progressEl = document.getElementById('progress');

  // --- engine-state persistence (OPFS; one profile per extension origin) ---
  const PERSIST_FILE = 'bib-state-v1.json';
  const persistOn = params.get('persist') !== '0' && !!navigator.storage?.getDirectory;
  const persistSeedReady = (async () => {
    if (!persistOn) return null;
    try {
      const root = await navigator.storage.getDirectory();
      if (params.get('persist') === 'clear') {
        await root.removeEntry(PERSIST_FILE).catch(() => {});
        return null;
      }
      const text = await (await (await root.getFileHandle(PERSIST_FILE)).getFile()).text();
      if (text.length > 16 * 1024 * 1024) return null; // corrupt/foreign
      return text || null;
    } catch {
      return null; // first run
    }
  })();
  let persistPending = null;
  let persistTimer = 0;
  let persistWriting = false;
  async function persistWriteLoop() {
    if (persistWriting) return;
    persistWriting = true;
    try {
      while (persistPending !== null) {
        const text = persistPending;
        persistPending = null;
        try {
          const root = await navigator.storage.getDirectory();
          const w = await (await root.getFileHandle(PERSIST_FILE, { create: true })).createWritable();
          await w.write(text);
          await w.close();
        } catch {
          // engine's change-detector already advanced — requeue, retry later
          if (persistPending === null) persistPending = text;
          break;
        }
      }
    } finally {
      persistWriting = false;
      if (persistPending !== null && !persistTimer)
        persistTimer = setTimeout(() => ((persistTimer = 0), persistWriteLoop()), 5000);
    }
  }
  const bibPersist = (json) => {
    if (!persistOn) return;
    persistPending = json;
    if (persistTimer) return;
    persistTimer = setTimeout(() => ((persistTimer = 0), persistWriteLoop()), 500);
  };

  // --- machine-readable state: the __bs dev/test hook (notes/testing.md) ---
  let readbackWaiters = [];
  const bs = (globalThis.__bs = {
    abiVersion: ABI_VERSION,
    ready: false,
    dead: false,
    frames: 0,
    ticks: 0,
    // Engine framebuffer geometry as of the last bibFrame / the last
    // bib_set_viewport request (device px).
    fb: null,
    viewport: null,
    // Filled by bibChrome signals (true engine URL, not the ?url= param).
    // index/length = position + size of the engine's back/forward list.
    state: {
      url: null,
      title: null,
      canGoBack: false,
      canGoForward: false,
      progress: 0,
      index: null,
      length: 0,
    },
    metrics: { bootMs: null, engineFetchMs: null },
    workers: [],
    killEngine() {
      for (const w of this.workers) {
        try { w.terminate(); } catch {}
      }
    },
    // Async pixel probe from the engine's own framebuffer bytes (premul
    // Skia surface pixels — identical to unpremul at alpha 255, which the
    // opaque root frame always is; the canvas round-trip is lossy, never
    // read pixels off the canvas).
    readback() {
      if (!this.ready || this.dead) return Promise.resolve(null);
      return new Promise((resolve) => {
        readbackWaiters.push(resolve);
        Module._bib_request_readback();
      });
    },
    probe(x, y) {
      return this.readback().then((frame) => {
        if (!frame) return null;
        x |= 0; y |= 0;
        if (x < 0 || y < 0 || x >= frame.w || y >= frame.h) return null;
        const i = (y * frame.w + x) * 4;
        return [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
      });
    },
    // Sync probe against the last readback, kicking a fresh request — for
    // waitForFunction predicates, which cannot await (spike-era lesson).
    lastFrame: null,
    probeSync(x, y) {
      if (!this.ready || this.dead) return null;
      Module._bib_request_readback();
      const frame = this.lastFrame;
      if (!frame) return null;
      x |= 0; y |= 0;
      if (x < 0 || y < 0 || x >= frame.w || y >= frame.h) return null;
      const i = (y * frame.w + x) * 4;
      return [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
    },
    // Guest-JS eval (dev builds; results via the console forwarder).
    eval(code) {
      return Module.ccall('bib_eval', 'number', ['string'], [code]);
    },
    navigate(url) {
      const clean = normalizeEngineURL(url);
      if (!clean || this.dead) return false;
      Module.ccall('bib_load_url', null, ['string'], [clean]);
      return true;
    },
  });

  // --- viewport: the framebuffer tracks the canvas layout size -------------
  // #screen fills the window below the chrome (viewer.html flex); the engine
  // boots at its 800x600 default and is resized to match at ready + on every
  // canvas resize (window resize, zoom, boot strip hiding).
  let vpW = 0;
  let vpH = 0;
  let vpDpr = window.devicePixelRatio || 1;
  let vpApplied = null;
  let vpTimer = 0;
  const applyViewport = () => {
    if (!bs.ready || bs.dead || vpW < 1 || vpH < 1 || !Module._bib_set_viewport) return;
    const key = `${vpW}x${vpH}@${vpDpr}`;
    if (key === vpApplied) return;
    vpApplied = key;
    bs.viewport = { w: vpW, h: vpH, dpr: vpDpr };
    Module._bib_set_viewport(vpW, vpH, vpDpr);
  };
  const noteCanvasSize = (entry) => {
    vpDpr = window.devicePixelRatio || 1;
    const dp = entry?.devicePixelContentBoxSize?.[0];
    if (dp) {
      vpW = dp.inlineSize;
      vpH = dp.blockSize;
    } else {
      vpW = Math.round(canvas.clientWidth * vpDpr);
      vpH = Math.round(canvas.clientHeight * vpDpr);
    }
    // Trailing debounce: a resize drag is a burst, and each engine resize is
    // a framebuffer realloc + full repaint.
    clearTimeout(vpTimer);
    vpTimer = setTimeout(applyViewport, 100);
  };
  const vpObserver = new ResizeObserver((entries) => noteCanvasSize(entries[entries.length - 1]));
  try {
    vpObserver.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    vpObserver.observe(canvas); // fallback: CSS-px box scaled by dpr
  }

  // --- tab-history mirror (native back/forward/reload; notes/ui.md) --------
  // The TAB's session history mirrors the engine's back/forward list: every
  // url signal rewrites the tab URL to viewer.html?<our params>url=<live
  // engine URL>, pushing a new entry or replacing the current one, and tags
  // it with the engine's index. Two things fall out: the browser's own
  // back/forward/reload drive the engine (popstate -> bib_go), and everything
  // that reads tab.url — popup escape hatch, SW sweep, badge — sees the page
  // actually loaded instead of the entry point we were redirected to.
  //
  // Every mirrored entry carries a real URL, so an entry the engine can't
  // traverse to (fresh engine after a native reload, pruned list) still
  // cold-boots correctly via bib_load_url.
  const viewerParams = (() => {
    const q = location.search;
    const i = q.indexOf('url=');
    if (i >= 0) return q.slice(0, i); // "?" or "?blit=2d&" — must precede url=
    return q ? `${q}&` : '?';
  })();
  // Raw, never percent-encoded: popup/sweep slice at the first url= without
  // decoding (the DNR \0 contract).
  const tabURLFor = (url) => location.pathname + viewerParams + 'url=' + url;
  const sameURL = (a, b) => {
    if (a === b) return true;
    if (!a || !b) return false;
    try {
      return new URL(a).href === new URL(b).href;
    } catch {
      return false;
    }
  };

  // What the current tab entry reflects. index stays null until the first
  // signal: the entry we booted in already IS the engine's first page, so it
  // gets replaced, never duplicated.
  let mirror = { url: null, index: null };
  let forceReplace = false; // next signal fixes up an entry, doesn't add one
  let want = null; // {index, url}: entry the tab is on, engine isn't (yet)
  let issuedFrom = null; // engine index the in-flight bib_go was computed from

  function syncTabHistory(url, kind, index) {
    const push = kind === 'new' && mirror.index !== null && !forceReplace && !sameURL(url, mirror.url);
    forceReplace = false;
    // Each navigation signals twice (commit + didFinishLoad), and the commit
    // one carries a stale index — the repeat replaces, fixing the index up.
    try {
      if (push) history.pushState({ bsIndex: index }, '', tabURLFor(url));
      else if (url !== mirror.url || index !== mirror.index)
        history.replaceState({ bsIndex: index }, '', tabURLFor(url));
      else return; // nothing changed; don't spend the History-API rate limit
    } catch {
      // Rate-limited (a guest SPA hammering pushState): leave the tab URL
      // stale and retry on the next signal. Traversal to a stale entry still
      // works — it falls back to loading the entry's URL.
      return;
    }
    mirror = { url, index };
  }

  // Move the engine to where the tab's current entry says it should be.
  // Re-entered from every url signal: one hop is issued at a time and the
  // next only after the engine actually moved, so a burst of popstates
  // converges instead of over-shooting.
  function drive() {
    if (!want || !bs.ready || bs.dead) return;
    const here = bs.state.index;
    if (here === null) return;
    const target = want;
    if (here === target.index) {
      want = null;
      issuedFrom = null;
      if (target.url && bs.state.url && !sameURL(target.url, bs.state.url)) loadEntry(target.url);
      return;
    }
    if (issuedFrom === here) return; // hop in flight — wait for the engine
    if (target.index >= 0 && target.index < bs.state.length) {
      issuedFrom = here;
      Module._bib_go(target.index - here);
      return;
    }
    loadEntry(target.url); // not in this engine's list — cold-load it
  }

  function loadEntry(url) {
    want = null;
    issuedFrom = null;
    if (!url) return;
    forceReplace = true; // we're already ON this entry; don't push another
    if (!bs.navigate(url)) forceReplace = false;
  }

  window.addEventListener('popstate', (e) => {
    const idx = typeof e.state?.bsIndex === 'number' ? e.state.bsIndex : null;
    const url = normalizeEngineURL(rawUrlParam());
    // The tab is already on this entry — mirror it so the engine's echo fixes
    // it up in place.
    mirror = { url, index: idx };
    if (bs.dead || !window.Module) {
      location.reload(); // no engine left: cold-boot this entry
      return;
    }
    issuedFrom = null;
    want = idx === null ? null : { index: idx, url };
    if (idx === null) {
      // Entry from before the mirror existed (or an external history edit).
      if (url && !sameURL(url, bs.state.url)) loadEntry(url);
      return;
    }
    drive();
  });

  // --- input forwarding (port of the harness wiring) -----------------------
  const mods = (e) =>
    (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
  // CSS px → framebuffer DEVICE px, the ABI's input unit (bib_abi.h
  // § Coordinates). Measured from the live backing/CSS ratio rather than
  // devicePixelRatio: the two agree except transiently mid-resize, and the
  // ratio is what the blit is actually showing, so clicks stay aligned while
  // the engine catches up. The device → logical (CSS-at-engine-dpr) step is
  // the ENGINE's — it owns the dpr in force, which it clamps and adopts
  // asynchronously. Do not scale by dpr here.
  const devX = (e) => e.offsetX * (canvas.width / (canvas.clientWidth || canvas.width));
  const devY = (e) => e.offsetY * (canvas.height / (canvas.clientHeight || canvas.height));
  let pendingMove = null;
  const flushPendingMove = () => {
    if (!pendingMove || bs.dead) return;
    Module._bib_mouse_move(pendingMove[0], pendingMove[1], pendingMove[2]);
    pendingMove = null;
  };
  // Wheel deltas coalesce per frame like mousemove: a smooth trackpad fires
  // hundreds of small (float) deltas per second, and each engine wheel event
  // is a scroll step whose blit cost scales with the viewport. One summed
  // event per tick scrolls the same distance.
  let pendingWheel = null; // [x, y, dx, dy, mods]
  const flushPendingWheel = () => {
    if (!pendingWheel || bs.dead) return;
    Module._bib_wheel(...pendingWheel);
    pendingWheel = null;
  };
  // Host-owned input: never forwarded, never preventDefault()ed, so the
  // browser's own history controls still work over the canvas. Ctrl/Cmd
  // combos (devtools, tab keys, Ctrl+R) are handled at the call sites.
  const hostKey = (e) =>
    e.key === 'F5' || (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'));
  const hostButton = (e) => e.button === 3 || e.button === 4; // mouse back/forward

  function wireInput() {
    canvas.addEventListener('mousemove', (e) => {
      pendingMove = [devX(e), devY(e), mods(e)];
    });
    canvas.addEventListener('mousedown', (e) => {
      if (bs.dead || hostButton(e)) return;
      canvas.focus();
      e.preventDefault();
      flushPendingMove();
      flushPendingWheel(); // scroll must land before the click's hit test
      Module._bib_mouse_button(1, e.button, devX(e), devY(e), e.detail || 1, mods(e));
    });
    canvas.addEventListener('mouseup', (e) => {
      if (bs.dead || hostButton(e)) return;
      e.preventDefault();
      flushPendingMove();
      flushPendingWheel();
      Module._bib_mouse_button(0, e.button, devX(e), devY(e), e.detail || 1, mods(e));
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (bs.dead) return;
        e.preventDefault();
        flushPendingMove();
        // Position: device px. Deltas: logical (CSS) px, passed through
        // unscaled — that is what the ABI and WebCore both want.
        if (pendingWheel && pendingWheel[4] === mods(e)) {
          pendingWheel[0] = devX(e);
          pendingWheel[1] = devY(e);
          pendingWheel[2] += e.deltaX;
          pendingWheel[3] += e.deltaY;
        } else {
          flushPendingWheel();
          pendingWheel = [devX(e), devY(e), e.deltaX, e.deltaY, mods(e)];
        }
      },
      { passive: false },
    );
    const sendKey = (type, e, text) =>
      bs.dead
        ? 0
        : Module.ccall(
            'bib_key',
            'number',
            ['number', 'string', 'string', 'string', 'number', 'number', 'number'],
            [type, e.key, e.code, text, e.keyCode | 0, e.repeat ? 1 : 0, mods(e)],
          );
    canvas.addEventListener('keydown', (e) => {
      // Ctrl/Cmd combos stay with the HOST browser (devtools, tab keys), as
      // do its history shortcuts (Alt+arrows, F5).
      if (e.ctrlKey || e.metaKey || hostKey(e)) return;
      e.preventDefault();
      sendKey(0, e, '');
      if (e.key.length === 1) sendKey(2, e, e.key);
      else if (e.key === 'Enter') sendKey(2, e, '\r');
      else if (e.key === 'Tab') sendKey(2, e, '\t');
    });
    canvas.addEventListener('keyup', (e) => {
      if (e.ctrlKey || e.metaKey || hostKey(e)) return;
      sendKey(1, e, '');
    });
    const setFocus = (v) => {
      if (!bs.dead && Module._bib_set_focus) Module._bib_set_focus(v);
    };
    canvas.addEventListener('focus', () => setFocus(1));
    canvas.addEventListener('blur', () => setFocus(0));
  }

  // --- rAF tick loop (cadence only; engine pushes frames back) -------------
  function tickLoop() {
    if (bs.dead) return;
    flushPendingMove();
    flushPendingWheel();
    Module._bib_tick();
    bs.ticks++;
    requestAnimationFrame(tickLoop);
  }

  // Boot page the engine renders before the first navigation.
  const bootHTML =
    "<!DOCTYPE html><html><head><meta charset='utf-8'><title>browsception</title></head>" +
    "<body style='margin:0;background:#14161a'>" +
    "<div style='color:#8891a0;font:14px system-ui;padding:24px'>booting…</div>" +
    '</body></html>';

  // Keep this page out of the bfcache (a cached page retains the ~0.5-1 GB
  // instance) and drop the Module root on pagehide so GC can reclaim it.
  window.addEventListener('unload', () => {});
  const flushPersistNow = () => {
    try {
      if (window.Module && Module._bib_persist_now && bs.ready && !bs.dead)
        Module._bib_persist_now();
    } catch {}
  };
  window.addEventListener('pagehide', () => {
    flushPersistNow();
    window.Module = null;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersistNow();
  });

  window.Module = {
    bibInteractive: true,
    bibGPU: false, // no nested GPU, permanently (security.md)
    bibCanvasGPU: false,
    bibGpuBench: false,
    bibHTML: bootHTML,
    bibWasm2js: () => null, // guest wasm -> CompileError (fast-follow)
    bibWasmPolyfill: '',
    bibNoBlock: params.get('noblock') === '1',
    bibMedia: false,
    // Page-side pump fallbacks (pthread builds pump via the worker pre-js).
    bibWakeUp: () => {},
    bibArmTimer: () => {},
    // Zero-copy raster frame push (heap is a SAB; fresh view every frame —
    // a cross-thread grow leaves cached views stale).
    bibFrame(ptr, fbW, fbH, strideBytes, x, y, w, h) {
      if (bs.dead) return;
      presenter.present(new Uint8Array(Module.HEAPU8.buffer), ptr, fbW, fbH, strideBytes, y, h);
      bs.fb = { w: fbW, h: fbH };
      bs.frames++;
    },
    bibReadbackReady(data, w, h) {
      const waiters = readbackWaiters;
      readbackWaiters = [];
      const frame = data ? { data, w, h } : null;
      if (frame) bs.lastFrame = frame;
      for (const resolve of waiters) resolve(frame);
    },
    // 2.3 chrome signals — kind/json arrive as JS strings (ABI).
    bibChrome(kind, json) {
      let data = {};
      try {
        data = JSON.parse(json);
      } catch {}
      if (kind === 'url') {
        // Always the TRUE engine URL (security.md). Boot/about pages show
        // as an empty bar, never as a spoofable-looking address.
        const shown = /^https?:/.test(data.url ?? '') ? data.url : '';
        bs.state.url = data.url ?? null;
        bs.state.canGoBack = !!data.canGoBack;
        bs.state.canGoForward = !!data.canGoForward;
        bs.state.index = typeof data.index === 'number' ? data.index : null;
        bs.state.length = typeof data.length === 'number' ? data.length : 0;
        if (document.activeElement !== urlbarEl) urlbarEl.value = shown;
        // Boot/about pages are never mirrored into tab history.
        if (shown) {
          syncTabHistory(data.url, data.kind, bs.state.index);
          clearLoadError(); // a load committed — whatever failed before is stale
        }
        drive();
      } else if (kind === 'title') {
        bs.state.title = data.title ?? '';
        document.title = data.title || bs.state.url || 'browsception';
      } else if (kind === 'loadfailed') {
        // Top-level load the engine gave up on (the shim's own failures
        // arrive via onMainLoadFailed; either may fire first, same strip).
        if (!bs.dead && data.url) showLoadError(data.url, data.kind, data.message);
      } else if (kind === 'progress') {
        bs.state.progress = data.p ?? 0;
        progressEl.style.width = `${Math.round((data.p ?? 0) * 100)}%`;
        progressEl.style.opacity = (data.p ?? 0) >= 1 ? '0' : '1';
      }
    },
    bibPersist,
    bibSeedState: null, // filled before the engine script loads
    preRun: [
      function () {
        Module.FS.mkdirTree('/var/cache/fontconfig');
      },
    ],
    onEngineReady() {
      bs.ready = true;
      bs.metrics.bootMs = Math.round(performance.now() - t0);
      bootEl.style.display = 'none';
      setStatus(`engine live (${bs.metrics.bootMs} ms boot)`);
      // Size the engine to the canvas now (boot default is 800x600); hiding
      // the boot strip just changed the layout, so measure fresh.
      noteCanvasSize(null);
      clearTimeout(vpTimer);
      applyViewport();
      wireInput();
      // Back/forward/reload are the HOST browser's (tab-history mirror
      // above); the only chrome control left here is the URL bar.
      urlbarEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && bs.navigate(urlbarEl.value)) canvas.focus();
      });
      canvas.focus();
      requestAnimationFrame(tickLoop);
      if (navigateURL) {
        setStatus(`loading ${navigateURL}`);
        Module.ccall('bib_load_url', null, ['string'], [navigateURL]);
        document.title = navigateURL;
      }
    },
    print: (s) => console.log('[engine] ' + s),
    printErr: (s) => console.warn('[engine] ' + s),
    onAbort(reason) {
      // Named frames only if the HOST thread aborted; an engine-thread abort
      // arrives here as a worker error, and its stack is logged worker-side by
      // engine-pre.js ("engine abort stack"). Cheap to keep both — either
      // thread can be the one that dies.
      try { console.error('[engine] abort stack (host thread) ' + new Error().stack); } catch {}
      // One crash must not become a RuntimeError storm: flag the corpse and
      // stop every entry point (the tick loop checks bs.dead).
      bs.dead = true;
      bootEl.style.display = 'block';
      bootEl.textContent = 'engine crashed — ';
      const b = document.createElement('button');
      b.textContent = 'reload';
      b.addEventListener('click', () => location.reload());
      bootEl.append(b);
      setStatus('CRASHED: ' + reason);
    },
  };

  // A failed top-level load leaves WHATEVER is committed on screen — the boot
  // page on a first navigation, the previous page otherwise. Say so, with a
  // retry; the next successful commit clears it. (No "open natively" button
  // here on purpose: that escape hatch lives in the popup, ui.md.)
  const NET_ERR_TEXT = {
    [NET_ERR.GUARD]: 'blocked by the sandbox guard',
    [NET_ERR.NETWORK]: 'network error',
    [NET_ERR.TIMEOUT]: 'timed out',
    [NET_ERR.TOO_LARGE]: 'response too large',
    [NET_ERR.PROTOCOL]: 'protocol error',
    [NET_ERR.ENGINE]: 'the engine refused it',
  };
  function showLoadError(url, kind, message) {
    bootEl.textContent = `couldn't load ${url} — ${NET_ERR_TEXT[kind] ?? `error ${kind}`}`;
    if (message) bootEl.textContent += ` (${message})`;
    const retry = document.createElement('button');
    retry.textContent = 'retry';
    retry.addEventListener('click', () => bs.navigate(url));
    bootEl.append(retry);
    bootEl.style.display = 'block';
    setStatus(`load failed: ${url}`);
    noteCanvasSize(null); // the strip changed the layout
  }
  function clearLoadError() {
    if (bootEl.style.display === 'none') return;
    bootEl.style.display = 'none';
    bootEl.textContent = '';
    noteCanvasSize(null);
  }

  // 2.4 boundary policy: live activation/mode/list state decides whether a
  // top-level navigation stays nested or hands the REAL tab the URL.
  let listState = await getState();
  let firstMainSeen = false;
  onStateChanged((s) => (listState = s));

  // The bridge installs bibNet* on Module; must exist before the engine runs.
  const bridge = new Bridge(window.Module, {
    capture: new RedirectCapture(),
    // Host UA: sites should serve the same content they'd serve this browser.
    userAgent: navigator.userAgent,
    guardOpts: { allowPrivateNetwork: listState.allowPrivateNetwork },
    // The INITIAL target is exempt: it was already dispositioned by whatever
    // opened this viewer (DNR redirect, sweep, dev/test direct-open); the
    // boundary check is for navigating AWAY.
    navigationPolicy: (url) => {
      if (!firstMainSeen) {
        firstMainSeen = true;
        if (url === navigateURL) return 'sandbox';
      }
      return shouldSandbox(listState, url) ? 'sandbox' : 'native';
    },
    onNativeNavigation: (url) => location.replace(url),
    onMainLoadFailed: (url, kind, message) => !bs.dead && showLoadError(url, kind, message),
  });
  await bridge.init();

  // Track engine-spawned workers for tests/diagnostics.
  {
    const Prev = window.Worker;
    // `class extends` wires both prototype chains; assigning .prototype
    // explicitly (harness-era line) throws under ESM strict mode.
    window.Worker = class BIBTrackedWorker extends Prev {
      constructor(url, options) {
        super(url, options);
        bs.workers.push(this);
      }
    };
  }

  Module.bibSeedState = await persistSeedReady;
  setStatus('fetching engine…');
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('engine/embedder.js');
  s.onload = () => {
    bs.metrics.engineFetchMs = Math.round(performance.now() - t0);
  };
  s.onerror = () => {
    bootEl.textContent = 'engine artifacts missing — run tools/stage-engine.mjs';
    setStatus('no engine');
  };
  document.body.appendChild(s);
}

if (params.has('stub')) {
  await __bsBoot();
  bootEl.textContent = 'bridge up (stub engine)';
} else {
  await bootEngine();
}
