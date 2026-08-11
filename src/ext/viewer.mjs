// Viewer: hosts the real wasm engine inside the extension page (2.1), or the
// stub engine for tier-1 bridge tests (?stub=1).
//
// Real-engine mode is a port of the engine repo's dev harness scaffolding
// (engine/WebkitWasm/web/browser.html) minus its dev-only paths: raster only
// (no nested GPU — security.md), no wisp, no media bridge, no guest-wasm
// polyfill yet (guest wasm sees CompileError; fast-follow). Networking is the
// real bridge (src/shim/bridge.mjs): guard list, DNR header rules, webRequest
// Set-Cookie/redirect capture.

import { ABI_VERSION } from '../abi/abi.mjs';
import { Bridge } from '../shim/bridge.mjs';
import { RedirectCapture } from '../shim/redirect-capture.mjs';
import { createStubModule } from '../shim/engine-stub.mjs';
import { createPresenter } from './blit.mjs';

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
  const bridge = new Bridge(module, {
    capture: new RedirectCapture(),
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
    liveAllocs: () => module.stub.liveAllocs(),
  };
  return true;
};

// The DNR redirect's \0 carries the matched URL RAW (un-encoded), so the
// target's own query would be truncated by URLSearchParams — slice at the
// first "url=" instead. Manual/test paths pass it percent-encoded; decode
// only that form.
function rawUrlParam() {
  const q = location.search;
  const i = q.indexOf('url=');
  if (i < 0) return null;
  let raw = q.slice(i + 4);
  if (/^https?%3A/i.test(raw)) {
    try {
      raw = decodeURIComponent(raw);
    } catch {}
  }
  return raw;
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
  const backBtn = document.getElementById('back');
  const fwdBtn = document.getElementById('fwd');
  const reloadBtn = document.getElementById('reloadbtn');
  const nativeBtn = document.getElementById('native');
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
    // Filled by bibChrome signals (true engine URL, not the ?url= param).
    state: { url: null, title: null, canGoBack: false, canGoForward: false, progress: 0 },
    metrics: { bootMs: null, engineFetchMs: null },
    workers: [],
    killEngine() {
      for (const w of this.workers) {
        try { w.terminate(); } catch {}
      }
    },
    // Async pixel probe from the engine's unpremultiplied framebuffer (the
    // canvas round-trip is lossy; never read pixels off the canvas).
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

  // --- input forwarding (port of the harness wiring) -----------------------
  const mods = (e) =>
    (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
  let pendingMove = null;
  const flushPendingMove = () => {
    if (!pendingMove || bs.dead) return;
    Module._bib_mouse_move(pendingMove[0], pendingMove[1], pendingMove[2]);
    pendingMove = null;
  };
  function wireInput() {
    canvas.addEventListener('mousemove', (e) => {
      pendingMove = [e.offsetX, e.offsetY, mods(e)];
    });
    canvas.addEventListener('mousedown', (e) => {
      if (bs.dead) return;
      canvas.focus();
      e.preventDefault();
      flushPendingMove();
      Module._bib_mouse_button(1, e.button, e.offsetX, e.offsetY, e.detail || 1, mods(e));
    });
    canvas.addEventListener('mouseup', (e) => {
      if (bs.dead) return;
      e.preventDefault();
      flushPendingMove();
      Module._bib_mouse_button(0, e.button, e.offsetX, e.offsetY, e.detail || 1, mods(e));
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (bs.dead) return;
        e.preventDefault();
        flushPendingMove();
        Module._bib_wheel(e.offsetX, e.offsetY, e.deltaX, e.deltaY, mods(e));
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
      // Ctrl/Cmd combos stay with the HOST browser (devtools, tab keys).
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      sendKey(0, e, '');
      if (e.key.length === 1) sendKey(2, e, e.key);
      else if (e.key === 'Enter') sendKey(2, e, '\r');
      else if (e.key === 'Tab') sendKey(2, e, '\t');
    });
    canvas.addEventListener('keyup', (e) => {
      if (e.ctrlKey || e.metaKey) return;
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
    bibCurlDebug: false,
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
        if (document.activeElement !== urlbarEl) urlbarEl.value = shown;
        backBtn.disabled = !data.canGoBack;
        fwdBtn.disabled = !data.canGoForward;
      } else if (kind === 'title') {
        bs.state.title = data.title ?? '';
        document.title = data.title || bs.state.url || 'browsception';
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
      wireInput();
      // Chrome controls (2.3).
      backBtn.addEventListener('click', () => {
        if (!bs.dead) Module._bib_go(-1);
      });
      fwdBtn.addEventListener('click', () => {
        if (!bs.dead) Module._bib_go(1);
      });
      reloadBtn.addEventListener('click', () => {
        if (!bs.dead && Module._bib_reload) Module._bib_reload();
      });
      urlbarEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && bs.navigate(urlbarEl.value)) canvas.focus();
      });
      nativeBtn.addEventListener('click', () => {
        const url = bs.state.url;
        if (/^https?:/.test(url ?? ''))
          chrome.runtime.sendMessage({ type: 'open-natively', url });
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

  // The bridge installs bibNet* on Module; must exist before the engine runs.
  const bridge = new Bridge(window.Module, {
    capture: new RedirectCapture(),
    // Host UA: sites should serve the same content they'd serve this browser.
    userAgent: navigator.userAgent,
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
