// EngineLink: the main-thread end of the engine worker (src/ext/engine-worker.js).
// The viewer drives the engine through it (export calls, readbacks) and the
// bridge streams network traffic through it; every hook the engine fires in
// the worker arrives here as a message and lands on one of `hooks`.
//
// Messages are FIFO in both directions, so a call posted after a net chunk
// runs after it — the same ordering the old proxied-call queue gave.
//
// Frames: the worker transfers one band buffer per presented frame and keeps
// the engine's present in flight until we hand the buffer back — so
// hooks.onFrame must consume the band SYNCHRONOUSLY (texSubImage2D and
// putImageData both copy at call time); the buffer is transferred back the
// moment it returns.

export class EngineLink {
  #worker;
  #hooks;
  #dead = false;
  #calls = 0;

  // Bridge-facing: engine → host network events. The bridge assigns these.
  onNetBegin = null; // (req, body: Uint8Array|null)
  onNetCancel = null; // (id)
  onNetAck = null; // (id, bytes)

  /**
   * @param {{
   *   workerUrl: string, engineUrl: string,
   *   hooks: {
   *     onReady?: () => void, onLoaded?: () => void, onBootFailed?: (message: string) => void,
   *     onFrame?: (f: {buf: ArrayBuffer, fbW: number, fbH: number, stride: number,
   *                    x: number, y: number, w: number, h: number}) => void,
   *     onChrome?: (kind: string, json: string) => void, onPersist?: (json: string) => void,
   *     onReadback?: (data: Uint8Array|null, w: number, h: number) => void,
   *     onAbort?: (reason: string) => void, onLog?: (err: boolean, text: string) => void,
   *     onCall?: (fn: string, args: unknown[]) => void,
   *   },
   * }} opts
   */
  constructor({ workerUrl, engineUrl, hooks }) {
    this.engineUrl = engineUrl;
    this.#hooks = hooks;
    this.#worker = new Worker(workerUrl);
    this.#worker.onmessage = (e) => this.#onMessage(e.data);
    // Backstop for a death the runtime never reported (script error before
    // Module exists, OOM). After an abort the worker is a corpse: ignore.
    this.#worker.onerror = (e) => {
      e.preventDefault?.();
      this.#abort(`worker error: ${e.message ?? e}`);
    };
  }

  get dead() {
    return this.#dead;
  }

  /** Export calls issued so far (diagnostics). */
  get calls() {
    return this.#calls;
  }

  /**
   * Load the engine with the boot config (see engine-worker.js boot()).
   * @param {{html?: string, noBlock?: boolean, seedState?: string|null,
   *   languages?: string[]}} config languages: BCP 47 tags, most preferred
   *   first — the engine's navigator.language(s) (the host's list)
   */
  boot(config) {
    this.#post({ t: 'boot', engineUrl: this.engineUrl, config });
  }

  /** Fire-and-forget export call: strings and numbers only. */
  call(fn, ...args) {
    if (this.#dead) return false;
    this.#calls++;
    this.#hooks.onCall?.(fn, args);
    this.#post({ t: 'call', fn, args });
    return true;
  }

  requestReadback() {
    this.#post({ t: 'readback' });
  }

  // --- network (bridge → engine) -------------------------------------------
  netResponse(id, headersJson) {
    this.#post({ t: 'net', op: 'response', id, json: headersJson });
  }
  netData(id, bytes) {
    // Transfer when the view owns its whole buffer (a fetch chunk does);
    // otherwise copy the slice out so the transfer can't detach siblings.
    const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    const buf = whole ? bytes.buffer : bytes.slice().buffer;
    this.#post({ t: 'net', op: 'data', id, buf, off: 0, len: buf.byteLength }, [buf]);
  }
  netDone(id, metricsJson) {
    this.#post({ t: 'net', op: 'done', id, json: metricsJson ?? null });
  }
  netFail(id, kind, message) {
    this.#post({ t: 'net', op: 'fail', id, kind, message: message ?? null });
  }
  netRedirect(id, status, headersJson) {
    this.#post({ t: 'net', op: 'redirect', id, status, json: headersJson });
  }

  /** Kill the worker outright (crash recovery, pagehide). */
  terminate() {
    this.#dead = true;
    try {
      this.#worker.terminate();
    } catch {}
  }

  // ------------------------------------------------------------- internals
  #post(msg, transfer) {
    if (this.#dead) return;
    this.#worker.postMessage(msg, transfer ?? []);
  }

  #abort(reason) {
    if (this.#dead) return;
    this.#dead = true;
    this.#hooks.onAbort?.(reason);
  }

  #onMessage(m) {
    const h = this.#hooks;
    switch (m.t) {
      case 'frame':
        try {
          if (!this.#dead) h.onFrame?.(m);
        } finally {
          this.#post({ t: 'frame-return', buf: m.buf }, [m.buf]);
        }
        break;
      case 'chrome':
        h.onChrome?.(m.kind, m.json);
        break;
      case 'persist':
        h.onPersist?.(m.json);
        break;
      case 'readback':
        h.onReadback?.(m.data, m.w, m.h);
        break;
      case 'net-begin':
        this.onNetBegin?.(m.req, m.body);
        break;
      case 'net-cancel':
        this.onNetCancel?.(m.id);
        break;
      case 'net-ack':
        this.onNetAck?.(m.id, m.bytes);
        break;
      case 'log':
        h.onLog?.(m.err, m.s);
        break;
      case 'loaded':
        h.onLoaded?.();
        break;
      case 'ready':
        h.onReady?.();
        break;
      case 'boot-failed':
        this.#dead = true;
        h.onBootFailed?.(m.message);
        break;
      case 'abort':
        this.#abort(m.reason);
        break;
    }
  }
}
