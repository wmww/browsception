// Probe 5/8 worker: big non-shared wasm memory, importScripts, import(),
// WebAssembly.instantiate under the manifest CSP.
const TINY_WASM = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 5, 1, 1, 102, 0, 0, 10, 6, 1,
  4, 0, 65, 42, 11,
]);

onmessage = async (e) => {
  const out = { kind: e.data };
  const t = (f) => {
    try {
      return f();
    } catch (err) {
      return `ERR ${err.name}: ${err.message}`;
    }
  };
  if (e.data === 'memory') {
    const PAGE = 65536;
    out.sab = typeof SharedArrayBuffer;
    out.crossOriginIsolated = self.crossOriginIsolated;
    out.create = t(() => {
      const t0 = performance.now();
      self.mem = new WebAssembly.Memory({ initial: (256 * 1024 * 1024) / PAGE, maximum: 65536, shared: false });
      return { ok: true, bytes: self.mem.buffer.byteLength, ms: Math.round(performance.now() - t0) };
    });
    if (self.mem) {
      const stages = [];
      for (const targetMB of [512, 1024, 1536, 2048, 3072, 4095]) {
        const cur = self.mem.buffer.byteLength / PAGE;
        const want = (targetMB * 1024 * 1024) / PAGE - cur;
        if (want <= 0) continue;
        const r = t(() => {
          const t0 = performance.now();
          self.mem.grow(want);
          // Touch a byte at the end so the pages are really committed.
          new Uint8Array(self.mem.buffer)[self.mem.buffer.byteLength - 1] = 1;
          return { targetMB, ok: true, bytes: self.mem.buffer.byteLength, ms: Math.round(performance.now() - t0) };
        });
        stages.push(typeof r === 'string' ? { targetMB, err: r } : r);
        if (typeof r === 'string') break;
      }
      out.grow = stages;
      out.finalMB = self.mem.buffer.byteLength / 1048576;
    }
    out.maxAlone = t(() => {
      const m = new WebAssembly.Memory({ initial: 1, maximum: 65536 });
      return m.buffer.byteLength;
    });
    out.sharedAttempt = t(() => new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }).buffer.constructor.name);
  } else if (e.data === 'scripts') {
    out.importScripts = t(() => {
      importScripts('imported.js');
      return self.IMPORTED_OK;
    });
    try {
      const m = await import('./mod.js');
      out.dynamicImport = m.MOD_OK;
    } catch (err) {
      out.dynamicImport = `ERR ${err.name}: ${err.message}`;
    }
  } else if (e.data === 'wasm') {
    try {
      const { instance } = await WebAssembly.instantiate(TINY_WASM);
      out.wasm = instance.exports.f();
    } catch (err) {
      out.wasm = `ERR ${err.name}: ${err.message}`;
    }
  }
  postMessage(out);
};
