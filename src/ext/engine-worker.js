// Engine worker: hosts the plain-link engine (src/engine/embedder.js) inside
// a dedicated Worker, so the viewer's main thread stays responsive while
// WebCore runs — the same "engine off the UI thread" the old
// -sPROXY_TO_PTHREAD link bought, without SharedArrayBuffer (Firefox
// extension pages can never be cross-origin isolated). The engine's EM_ASM
// hooks run in THIS scope on THIS Module; every hook here turns into a
// postMessage to src/ext/engine-link.mjs, and every message from it into an
// export call. ABI: src/abi/bib_abi.h.
//
// Classic script, not a module: embedder.js is a non-modularized Emscripten
// output that needs importScripts and a global `Module`. The heap helpers
// below are the ones that used to live in src/shim/heap.mjs.
//
// Copy accounting (one copy per direction, same as the shared-heap design):
//   frames out   engine framebuffer -> transferable band buffer (here) ->
//                main presents it and transfers it back (ping-pong of one).
//   bytes in     fetch chunk (main) -> transfer -> copied into the heap here.
'use strict';

const enc = new TextEncoder();
const dec = new TextDecoder();
const post = (msg, transfer) => self.postMessage(msg, transfer || []);

let dead = false; // abort seen: exports throw from here on, ignore traffic
let frameBuf = null; // the one transfer buffer, null while main holds it

const H = () => Module.HEAPU8; // fresh each time: memory growth swaps it

function readCString(ptr) {
  const heap = H();
  let end = ptr;
  while (heap[end] !== 0) end++;
  return dec.decode(heap.subarray(ptr, end));
}
// Allocates and writes a NUL-terminated UTF-8 string; ownership → engine.
function allocCString(str) {
  const bytes = enc.encode(str);
  const ptr = Module._bib_wasm_alloc(bytes.length + 1);
  H().set(bytes, ptr);
  H()[ptr + bytes.length] = 0;
  return ptr;
}

function abort(reason) {
  if (dead) return;
  dead = true;
  post({ t: 'abort', reason: String(reason ?? '') });
}

// --- hooks the engine calls (worker scope, synchronous) --------------------

// bibFrame: copy the dirty band (full-width rows [y, y+h)) out of the LIVE
// framebuffer into the transfer buffer and hand it to the main thread.
// Returning true takes ownership of _bib_present_done (ABI): the engine keeps
// the frame "in flight" — no repaint, damage coalescing — until main has
// consumed the band and sent the buffer back, which is the backpressure that
// stops a fast engine from out-painting a slow present.
function bibFrame(ptr, fbW, fbH, strideBytes, x, y, w, h) {
  const bytes = h * strideBytes;
  const capacity = fbH * strideBytes; // full-frame so any band fits
  if (!frameBuf || frameBuf.byteLength < capacity) frameBuf = new ArrayBuffer(capacity);
  const start = ptr + y * strideBytes;
  new Uint8Array(frameBuf, 0, bytes).set(H().subarray(start, start + bytes));
  const buf = frameBuf;
  frameBuf = null;
  post({ t: 'frame', buf, fbW, fbH, stride: strideBytes, x, y, w, h }, [buf]);
  return true;
}

// bibChrome: kind/json arrive as strings. "clipboard" items may carry
// engine-malloc'd bytes (ptr/len): copy them into one transferable buffer,
// free them, and hand main off/len into it instead.
function bibChrome(kind, json) {
  if (kind !== 'clipboard') return post({ t: 'chrome', kind, json });
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return;
  }
  const items = Array.isArray(data.items) ? data.items : [];
  const total = items.reduce((n, it) => n + (it.ptr ? it.len : 0), 0);
  const buf = new ArrayBuffer(total);
  let off = 0;
  for (const it of items) {
    if (!it.ptr) continue;
    new Uint8Array(buf, off, it.len).set(H().subarray(it.ptr, it.ptr + it.len));
    Module._bib_wasm_free(it.ptr);
    delete it.ptr;
    it.off = off;
    off += it.len;
  }
  post({ t: 'chrome', kind, json: JSON.stringify({ items }), buf }, [buf]);
}

function frameReturned(buf) {
  if (buf && buf.byteLength) frameBuf = buf;
  if (!dead) Module._bib_present_done();
}

function bibNetBegin(ptr) {
  let req;
  try {
    req = JSON.parse(readCString(ptr));
  } finally {
    Module._bib_wasm_free(ptr);
  }
  let body = null;
  if (req.bodyLen > 0) body = H().slice(req.bodyPtr, req.bodyPtr + req.bodyLen);
  if (req.bodyPtr) Module._bib_wasm_free(req.bodyPtr);
  delete req.bodyPtr;
  delete req.bodyLen;
  post({ t: 'net-begin', req, body }, body ? [body.buffer] : []);
}

// --- messages from the main thread -----------------------------------------

function boot({ engineUrl, config }) {
  self.Module = {
    // The glue resolves embedder.wasm against THIS worker's URL by default
    // (Emscripten's scriptDirectory is the worker's location, not the
    // importScripts one); point it at the artifact directory instead.
    locateFile: (path) => new URL(path, engineUrl).href,
    bibInteractive: true,
    bibHTML: config.html,
    bibNoBlock: !!config.noBlock,
    bibMedia: false,
    bibSeedState: config.seedState ?? null,
    bibLanguages: config.languages ?? null,
    // Filled by the engine's pre-js (worker-scope hooks: pump, wasm2js
    // bridge, guest-injection text fetched from the host root).
    bibWasm2js: () => null,
    bibWasmPolyfill: '',
    preRun: [() => Module.FS.mkdirTree('/var/cache/fontconfig')],
    print: (s) => post({ t: 'log', err: false, s }),
    printErr: (s) => post({ t: 'log', err: true, s }),
    // Called synchronously from abort(); the pre-js chains to it after
    // logging the named C++ stack.
    onAbort: abort,
    onEngineReady: () => post({ t: 'ready' }),
    bibFrame,
    bibReadbackReady: (data, w, h) => post({ t: 'readback', data, w, h }, data ? [data.buffer] : []),
    bibChrome,
    bibPersist: (json) => post({ t: 'persist', json }),
    bibNetBegin,
    bibNetCancel: (id) => post({ t: 'net-cancel', id }),
    bibNetAck: (id, bytes) => post({ t: 'net-ack', id, bytes }),
  };
  try {
    importScripts(engineUrl);
  } catch (e) {
    post({ t: 'boot-failed', message: String(e?.message ?? e) });
    return;
  }
  post({ t: 'loaded' });
}

// Fire-and-forget export call. String args ride ccall's stack marshalling
// (`const char*` exports); everything else is a number.
function callExport(fn, args) {
  const f = Module['_' + fn];
  if (typeof f !== 'function') {
    console.warn(`engine-worker: no export ${fn}`);
    return;
  }
  if (args.some((a) => typeof a === 'string'))
    Module.ccall(fn, null, args.map((a) => (typeof a === 'string' ? 'string' : 'number')), args);
  else f(...args);
}

// bib_edit(json, bytes, len): the payload is copied into the heap here,
// ownership → engine.
function edit({ json, buf }) {
  let ptr = 0;
  let len = 0;
  if (buf && buf.byteLength) {
    len = buf.byteLength;
    ptr = Module._bib_wasm_alloc(len);
    H().set(new Uint8Array(buf), ptr);
  }
  Module.ccall('bib_edit', null, ['string', 'number', 'number'], [json, ptr, len]);
}

function netIn(m) {
  const M = Module;
  switch (m.op) {
    case 'response':
      M._bib_net_response(m.id, allocCString(m.json));
      break;
    case 'data': {
      const bytes = new Uint8Array(m.buf, m.off, m.len);
      const ptr = M._bib_wasm_alloc(bytes.length);
      H().set(bytes, ptr);
      M._bib_net_data(m.id, ptr, bytes.length);
      break;
    }
    case 'done':
      M._bib_net_done(m.id, m.json ? allocCString(m.json) : 0);
      break;
    case 'fail':
      M._bib_net_fail(m.id, m.kind, m.message ? allocCString(m.message) : 0);
      break;
    case 'redirect':
      M._bib_net_redirect(m.id, m.status, allocCString(m.json));
      break;
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'boot') return boot(m);
  if (dead) return;
  try {
    switch (m.t) {
      case 'call':
        callExport(m.fn, m.args);
        break;
      case 'net':
        netIn(m);
        break;
      case 'edit':
        edit(m);
        break;
      case 'frame-return':
        frameReturned(m.buf);
        break;
      case 'readback':
        Module._bib_request_readback();
        break;
    }
  } catch (e) {
    // A RuntimeError out of an export after an abort the runtime didn't
    // report (or a trap without abort()) — treat it as the crash it is.
    console.error('engine-worker: export threw', e);
    abort(e?.message ?? e);
  }
};
