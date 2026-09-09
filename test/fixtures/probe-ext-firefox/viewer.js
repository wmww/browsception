// Probe surface for the Firefox phase-0 probes; tools/probe-firefox.mjs drives
// these via the BiDi harness. Everything returns plain JSON.

function interceptedUrl() {
  const i = location.search.indexOf('url=');
  return i < 0 ? null : location.search.slice(i + 4);
}
document.getElementById('url').textContent = interceptedUrl() ?? '(none)';
document.title = `ff-probe: ${interceptedUrl() ?? 'idle'}`;

const TINY_WASM = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 5, 1, 1, 102, 0, 0, 10, 6, 1,
  4, 0, 65, 42, 11,
]);

const errStr = (e) => `ERR ${e?.name ?? ''}: ${e?.message ?? String(e)}`;

// CSP as seen by the page's OWN script at load (a BiDi-driven call may run
// under a different realm's policy).
globalThis.__cspAtLoad = {};
try {
  // eslint-disable-next-line no-eval
  globalThis.__cspAtLoad.eval = eval('1+1');
} catch (e) {
  globalThis.__cspAtLoad.eval = errStr(e);
}
try {
  globalThis.__cspAtLoad.fn = new Function('return 3')();
} catch (e) {
  globalThis.__cspAtLoad.fn = errStr(e);
}
WebAssembly.instantiate(TINY_WASM)
  .then(({ instance }) => (globalThis.__cspAtLoad.wasm = instance.exports.f()))
  .catch((e) => (globalThis.__cspAtLoad.wasm = errStr(e)));
const attempt = async (f) => {
  try {
    return await f();
  } catch (e) {
    return errStr(e);
  }
};

globalThis.__probe = {
  interceptedUrl,
  href: () => location.href,
  extUrl: () => chrome.runtime.getURL(''),
  extId: () => chrome.runtime.id,

  // --- DNR ----------------------------------------------------------------
  dnr: {
    updateDynamicRules: (o) => attempt(() => chrome.declarativeNetRequest.updateDynamicRules(o)),
    getDynamicRules: () => chrome.declarativeNetRequest.getDynamicRules(),
    updateSessionRules: (o) => attempt(() => chrome.declarativeNetRequest.updateSessionRules(o)),
    getSessionRules: () => chrome.declarativeNetRequest.getSessionRules(),
    updateEnabledRulesets: (o) => attempt(() => chrome.declarativeNetRequest.updateEnabledRulesets(o)),
    getEnabledRulesets: () => chrome.declarativeNetRequest.getEnabledRulesets(),
    getAvailableStaticRuleCount: () => attempt(() => chrome.declarativeNetRequest.getAvailableStaticRuleCount()),
    testMatchOutcome: (o) => attempt(() => chrome.declarativeNetRequest.testMatchOutcome(o)),
  },

  tabs: {
    query: (q) => chrome.tabs.query(q ?? {}),
    current: () => chrome.tabs.getCurrent(),
  },

  // --- fetch --------------------------------------------------------------
  async fetchProbe({ url, init = {} }) {
    try {
      const r = await fetch(url, { credentials: 'omit', cache: 'no-store', ...init });
      let bodyPrefix = null;
      try {
        bodyPrefix = (await r.clone().text()).slice(0, 300);
      } catch {}
      return {
        ok: r.ok,
        status: r.status,
        type: r.type,
        redirected: r.redirected,
        url: r.url,
        headers: [...r.headers.entries()],
        getSetCookie: typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : null,
        bodyPrefix,
      };
    } catch (e) {
      return { error: errStr(e) };
    }
  },

  // --- webRequest capture from this (non-background) extension page --------
  wrEvents: [],
  wrErrors: {},
  wrStart(specs) {
    const P = globalThis.__probe;
    const rec = (name) => (d) =>
      P.wrEvents.push({
        event: name,
        requestId: d.requestId,
        url: d.url,
        type: d.type,
        statusCode: d.statusCode,
        redirectUrl: d.redirectUrl,
        initiator: d.initiator,
        originUrl: d.originUrl,
        documentUrl: d.documentUrl,
        tabId: d.tabId,
        requestHeaders: d.requestHeaders,
        responseHeaders: d.responseHeaders,
      });
    const filter = { urls: ['https://*.bstest/*', 'http://*.bstest/*'], types: ['xmlhttprequest'] };
    for (const [ev, spec] of Object.entries(specs)) {
      try {
        chrome.webRequest[ev].addListener(rec(ev), filter, spec);
        P.wrErrors[ev] = 'ok';
      } catch (e) {
        P.wrErrors[ev] = errStr(e);
      }
    }
    return P.wrErrors;
  },
  wrDump() {
    return globalThis.__probe.wrEvents;
  },
  wrClear() {
    globalThis.__probe.wrEvents.length = 0;
  },

  // --- background round-trips --------------------------------------------
  bg: (msg) => attempt(() => chrome.runtime.sendMessage(msg)),
  storageLocal: (k) => chrome.storage.local.get(k),

  // --- OPFS ---------------------------------------------------------------
  async opfs() {
    const out = {};
    try {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle('probe.txt', { create: true });
      out.createWritable = typeof fh.createWritable;
      if (typeof fh.createWritable === 'function') {
        const w = await fh.createWritable();
        await w.write('hello-opfs');
        await w.close();
      } else {
        out.mainThreadWrite = 'no createWritable';
      }
      out.readBack = await (await fh.getFile()).text();
      out.estimate = await attempt(async () => (await navigator.storage.estimate()).quota);
      out.persisted = await attempt(() => navigator.storage.persisted());
    } catch (e) {
      out.error = errStr(e);
    }
    return out;
  },

  // --- worker probes --------------------------------------------------------
  worker(kind) {
    return new Promise((resolve) => {
      let w;
      try {
        w = new Worker('worker.js');
      } catch (e) {
        return resolve({ error: errStr(e) });
      }
      const timer = setTimeout(() => {
        w.terminate();
        resolve({ error: 'timeout' });
      }, 60000);
      w.onmessage = (e) => {
        clearTimeout(timer);
        w.terminate();
        resolve(e.data);
      };
      w.onerror = (e) => {
        clearTimeout(timer);
        w.terminate();
        resolve({ error: `worker error: ${e.message}` });
      };
      w.postMessage(kind);
    });
  },
  isolation() {
    return {
      crossOriginIsolated: globalThis.crossOriginIsolated,
      sab: typeof SharedArrayBuffer,
      sharedMem: (() => {
        try {
          return new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }).buffer.constructor.name;
        } catch (e) {
          return errStr(e);
        }
      })(),
    };
  },

  // --- WebGL2 presenter ----------------------------------------------------
  webgl2(n = 60) {
    const W = 1600, H = 900;
    const out = {};
    const canvas = document.getElementById('c');
    const gl = canvas.getContext('webgl2', { alpha: false, desynchronized: true });
    out.hasContext = !!gl;
    if (!gl) {
      out.webgl1 = !!document.createElement('canvas').getContext('webgl');
    } else {
      out.renderer = gl.getParameter(gl.RENDERER);
      out.vendor = gl.getParameter(gl.VENDOR);
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) out.unmasked = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      out.attrs = gl.getContextAttributes();
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
      const px = new Uint8Array(W * H * 4);
      const times = [];
      for (let i = 0; i < n; i++) {
        px[i * 4] = i;
        const t0 = performance.now();
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.flush();
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      out.uploadMsMedian = +times[n >> 1].toFixed(3);
      out.uploadMsMax = +times[n - 1].toFixed(3);
      out.glError = gl.getError();
    }
    // 2d fallback
    const c2 = document.createElement('canvas');
    c2.width = W; c2.height = H;
    const ctx = c2.getContext('2d', { alpha: false, desynchronized: true });
    const img = new ImageData(W, H);
    const t2 = [];
    for (let i = 0; i < n; i++) {
      img.data[i * 4] = i;
      const t0 = performance.now();
      ctx.putImageData(img, 0, 0);
      t2.push(performance.now() - t0);
    }
    t2.sort((a, b) => a - b);
    out.putImageDataMsMedian = +t2[n >> 1].toFixed(3);
    return out;
  },

  // --- CSP / wasm -----------------------------------------------------------
  async wasmPage() {
    try {
      const { instance } = await WebAssembly.instantiate(TINY_WASM);
      return { instantiate: instance.exports.f() };
    } catch (e) {
      return { instantiate: errStr(e) };
    }
  },
  evalBlocked() {
    try {
      // eslint-disable-next-line no-eval
      return { eval: eval('1+1') };
    } catch (e) {
      return { eval: errStr(e) };
    }
  },
};
