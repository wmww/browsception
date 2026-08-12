// browsception host-fetch bridge — DEV-HARNESS transport (bib_abi.h).
//
// Installs the bibNet* hooks on Module, fetching through the dev server's
// /__bibproxy endpoint (server-side fetch; see tools/dev-server.mjs). The
// production transport is the extension shim (browsception src/shim/) —
// same hook surface, privileged fetch, guard list, DNR. This file has no
// guard list and no flow-control window: dev only.
//
// Redirect classification mirrors the extension bridge: 3xx + Location =>
// bib_net_redirect (engine drives the next hop); anything else is a
// response. Bodies stream in ≤64 KB slices.

(() => {
  const SLICE = 64 * 1024;
  const inflight = new Map(); // id -> AbortController

  // Fresh view every access: shared growable memory grows in place and old
  // views keep their creation-time length.
  const heap = (Module) => new Uint8Array(Module.HEAPU8.buffer);

  const allocCString = (Module, str) => {
    const n = Module.lengthBytesUTF8(str);
    const ptr = Module._bib_wasm_alloc(n + 1);
    Module.stringToUTF8(str, ptr, n + 1);
    return ptr;
  };

  const b64 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));
  const unb64 = (str) => new TextDecoder().decode(Uint8Array.from(atob(str), (c) => c.charCodeAt(0)));

  async function begin(Module, reqPtr) {
    const req = JSON.parse(Module.UTF8ToString(reqPtr));
    Module._bib_wasm_free(reqPtr);
    let body = null;
    if (req.bodyLen > 0) body = heap(Module).slice(req.bodyPtr, req.bodyPtr + req.bodyLen);
    if (req.bodyPtr) Module._bib_wasm_free(req.bodyPtr);

    const id = req.id;
    const ctrl = new AbortController();
    inflight.set(id, ctrl);
    const fail = (kind, msg) => {
      inflight.delete(id);
      Module._bib_net_fail(id, kind, msg ? allocCString(Module, msg) : 0);
    };

    let res;
    try {
      res = await fetch(`/__bibproxy?url=${encodeURIComponent(req.url)}`, {
        method: req.method === 'GET' || req.method === 'HEAD' ? 'GET' : 'POST',
        headers: {
          'x-bib-method': req.method,
          'x-bib-headers': b64(JSON.stringify(req.headers ?? [])),
        },
        body,
        signal: ctrl.signal,
        cache: 'no-store',
      });
    } catch (e) {
      return fail(ctrl.signal.aborted ? 5 : 2, String(e?.message ?? e));
    }
    if (!inflight.has(id)) return;
    const errHdr = res.headers.get('x-bib-error');
    if (errHdr || !res.headers.get('x-bib-meta')) {
      res.body?.cancel().catch(() => {});
      return fail(2, errHdr ? decodeURIComponent(errHdr) : `proxy ${res.status}`);
    }
    const meta = JSON.parse(unb64(res.headers.get('x-bib-meta')));

    const isRedirect =
      meta.status >= 300 && meta.status < 400 &&
      meta.headers.some(([k, v]) => k === 'location' && v);
    if (isRedirect) {
      res.body?.cancel().catch(() => {});
      inflight.delete(id);
      Module._bib_net_redirect(id, meta.status, allocCString(Module, JSON.stringify(meta)));
      return;
    }

    Module._bib_net_response(id, allocCString(Module, JSON.stringify(meta)));
    try {
      const reader = res.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (!inflight.has(id)) return void reader.cancel().catch(() => {});
        if (done) break;
        for (let off = 0; off < value.length; off += SLICE) {
          const slice = value.subarray(off, off + SLICE);
          const ptr = Module._bib_wasm_alloc(slice.length);
          heap(Module).set(slice, ptr);
          Module._bib_net_data(id, ptr, slice.length);
        }
      }
    } catch (e) {
      if (inflight.has(id)) fail(ctrl.signal.aborted ? 5 : 2, String(e?.message ?? e));
      return;
    }
    if (!inflight.has(id)) return;
    inflight.delete(id);
    Module._bib_net_done(id, 0);
  }

  window.installBibNet = (Module) => {
    Module.bibNetBegin = (ptr) => void begin(Module, ptr).catch((e) => console.error('bib-net', e));
    Module.bibNetCancel = (id) => {
      const ctrl = inflight.get(id);
      inflight.delete(id);
      ctrl?.abort();
    };
    Module.bibNetAck = () => {}; // no window in the dev transport
  };
})();
