// Tier-1 stub engine (notes/testing.md § Tier 1): speaks the engine side of
// the bridge's bytes/strings interface (src/shim/bridge.mjs header) so bridge
// tests exercise the real fetch bridge, DNR rules, and webRequest capture
// without the 100 MB engine. The pointer/heap half of the ABI lives in the
// engine worker (src/ext/engine-worker.js) and is not modelled here.
//
// Test driver: engine.stub.request(...) returns a transcript promise.

const enc = new TextEncoder();
const dec = new TextDecoder();

const BODY_KEEP_BYTES = 1024 * 1024; // transcript keeps at most this much body

export function createStubEngine({ ackDelayMs = 0, autoAck = true } = {}) {
  const pending = new Map(); // reqId -> {resolve, t}
  let nextId = 1;

  const finish = (id) => {
    const p = pending.get(id);
    pending.delete(id);
    return p;
  };

  const engine = {
    // Assigned by the bridge.
    onNetBegin: null,
    onNetCancel: null,
    onNetAck: null,

    netResponse(id, headersJson) {
      const p = pending.get(id);
      const h = JSON.parse(headersJson);
      if (p) {
        p.t.events.push('response');
        Object.assign(p.t, { status: h.status, statusText: h.statusText, url: h.url });
        p.t.headers = h.headers;
      }
    },
    netData(id, bytes) {
      const p = pending.get(id);
      const len = bytes.length;
      if (p) {
        p.t.events.push(`data:${len}`);
        p.t.bodyBytes += len;
        p.t.chunks++;
        if (p.t.keptBytes < BODY_KEEP_BYTES) {
          const take = Math.min(len, BODY_KEEP_BYTES - p.t.keptBytes);
          p.t.body.push(bytes.slice(0, take));
          p.t.keptBytes += take;
        }
      }
      if (autoAck) {
        const ack = () => engine.onNetAck?.(id, len);
        ackDelayMs ? setTimeout(ack, ackDelayMs) : queueMicrotask(ack);
      }
    },
    netDone(id, metricsJson) {
      const metrics = metricsJson ? JSON.parse(metricsJson) : null;
      const p = finish(id);
      if (!p) return;
      p.t.events.push('done');
      p.t.metrics = metrics;
      p.resolve(sealed(p.t));
    },
    netFail(id, kind, message) {
      const p = finish(id);
      if (!p) return;
      p.t.events.push('fail');
      p.t.error = { kind, message: message ?? null };
      p.resolve(sealed(p.t));
    },
    netRedirect(id, status, headersJson) {
      const h = JSON.parse(headersJson);
      const p = finish(id);
      if (!p) return;
      p.t.events.push('redirect');
      p.t.redirect = { status, headers: h.headers };
      p.resolve(sealed(p.t));
    },

    stub: {
      /** Issue one engine request; resolves with the full transcript. */
      request({ url, method = 'GET', headers = [], body = null, main = 0 }) {
        const id = nextId++;
        const t = { id, events: [], headers: null, body: [], bodyBytes: 0, keptBytes: 0, chunks: 0 };
        // .id on the promise so a test can cancel a request mid-flight.
        const transcript = new Promise((resolve) => {
          pending.set(id, { resolve, t });
          const bytes = body == null ? null : typeof body === 'string' ? enc.encode(body) : body;
          engine.onNetBegin({ id, method, url, headers, main }, bytes);
        });
        transcript.id = id;
        return transcript;
      },
      cancel(id) {
        engine.onNetCancel?.(id);
      },
    },
  };

  function sealed(t) {
    const bodyText = dec.decode(concat(t.body));
    return { ...t, body: undefined, bodyText };
  }
  function concat(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) out.set(p, off), (off += p.length);
    return out;
  }

  return engine;
}
