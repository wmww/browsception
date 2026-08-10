// Tier-1 stub engine (notes/testing.md § Tier 1): a Module-shaped fake that
// speaks the engine side of the ABI so bridge tests exercise the real fetch
// bridge, DNR rules, and webRequest capture without the 100 MB engine.
//
// Faithful to the real interface: a linear "heap" with bib_wasm_alloc/free,
// bib_net_* exports consuming ownership-transferred pointers, and requests
// emitted by calling the shim-installed bibNetBegin hook. Runs on the viewer
// main thread (proxying is out of tier-1's scope by design).
//
// Test driver: module.stub.request(...) returns a transcript promise.

const enc = new TextEncoder();
const dec = new TextDecoder();

const HEAP_BYTES = 64 * 1024 * 1024;
const BODY_KEEP_BYTES = 1024 * 1024; // transcript keeps at most this much body

export function createStubModule({ ackDelayMs = 0, autoAck = true } = {}) {
  const heap = new ArrayBuffer(HEAP_BYTES);
  const HEAPU8 = new Uint8Array(heap);

  // Bump allocator with whole-heap reset when nothing is live — enough for
  // stream workloads (chunks are freed as they're consumed).
  let brk = 8; // never hand out 0 (it means "no pointer")
  const live = new Set();
  const _bib_wasm_alloc = (size) => {
    if (brk + size > HEAP_BYTES) throw new Error('stub heap exhausted');
    const ptr = brk;
    brk += (size + 7) & ~7;
    live.add(ptr);
    return ptr;
  };
  const _bib_wasm_free = (ptr) => {
    if (!ptr) return;
    if (!live.delete(ptr)) throw new Error(`stub double/wild free: ${ptr}`);
    if (live.size === 0) brk = 8;
  };

  const readCString = (ptr) => {
    let end = ptr;
    while (HEAPU8[end] !== 0) end++;
    return dec.decode(HEAPU8.subarray(ptr, end));
  };
  const takeJson = (ptr) => {
    try {
      return JSON.parse(readCString(ptr));
    } finally {
      _bib_wasm_free(ptr);
    }
  };

  const pending = new Map(); // reqId -> {resolve, t}
  let nextId = 1;

  const finish = (id) => {
    const p = pending.get(id);
    pending.delete(id);
    return p;
  };

  const module = {
    HEAPU8,
    _bib_wasm_alloc,
    _bib_wasm_free,

    _bib_net_response(id, headersPtr) {
      const p = pending.get(id);
      const h = takeJson(headersPtr);
      if (p) {
        p.t.events.push('response');
        Object.assign(p.t, { status: h.status, statusText: h.statusText, url: h.url });
        p.t.headers = h.headers;
      }
    },
    _bib_net_data(id, ptr, len) {
      const p = pending.get(id);
      if (p) {
        p.t.events.push(`data:${len}`);
        p.t.bodyBytes += len;
        p.t.chunks++;
        if (p.t.keptBytes < BODY_KEEP_BYTES) {
          const take = Math.min(len, BODY_KEEP_BYTES - p.t.keptBytes);
          p.t.body.push(HEAPU8.slice(ptr, ptr + take));
          p.t.keptBytes += take;
        }
      }
      _bib_wasm_free(ptr);
      if (autoAck) {
        const ack = () => module.bibNetAck?.(id, len);
        ackDelayMs ? setTimeout(ack, ackDelayMs) : queueMicrotask(ack);
      }
    },
    _bib_net_done(id, metricsPtr) {
      const metrics = metricsPtr ? takeJson(metricsPtr) : null;
      const p = finish(id);
      if (!p) return;
      p.t.events.push('done');
      p.t.metrics = metrics;
      p.resolve(sealed(p.t));
    },
    _bib_net_fail(id, kind, msgPtr) {
      const message = msgPtr ? readCString(msgPtr) : null;
      if (msgPtr) _bib_wasm_free(msgPtr);
      const p = finish(id);
      if (!p) return;
      p.t.events.push('fail');
      p.t.error = { kind, message };
      p.resolve(sealed(p.t));
    },
    _bib_net_redirect(id, status, headersPtr) {
      const h = takeJson(headersPtr);
      const p = finish(id);
      if (!p) return;
      p.t.events.push('redirect');
      p.t.redirect = { status, headers: h.headers };
      p.resolve(sealed(p.t));
    },

    stub: {
      /** Issue one engine request; resolves with the full transcript. */
      request({ url, method = 'GET', headers = [], body = null }) {
        const id = nextId++;
        const t = { id, events: [], headers: null, body: [], bodyBytes: 0, keptBytes: 0, chunks: 0 };
        return new Promise((resolve) => {
          pending.set(id, { resolve, t });
          let bodyPtr = 0;
          let bodyLen = 0;
          if (body != null) {
            const bytes = typeof body === 'string' ? enc.encode(body) : body;
            bodyPtr = _bib_wasm_alloc(bytes.length);
            HEAPU8.set(bytes, bodyPtr);
            bodyLen = bytes.length;
          }
          const reqJson = enc.encode(JSON.stringify({ id, method, url, headers, bodyPtr, bodyLen }));
          const ptr = _bib_wasm_alloc(reqJson.length + 1);
          HEAPU8.set(reqJson, ptr);
          HEAPU8[ptr + reqJson.length] = 0;
          module.bibNetBegin(ptr);
        });
      },
      cancel(id) {
        module.bibNetCancel?.(id);
      },
      liveAllocs: () => live.size,
    },
  };

  function sealed(t) {
    const bodyText = dec.decode(concat(t.body));
    return { ...t, body: undefined, bodyText, liveAllocs: live.size };
  }
  function concat(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) out.set(p, off), (off += p.length);
    return out;
  }

  return module;
}
