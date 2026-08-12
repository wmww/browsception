// BrowserInBrowser guest WebAssembly polyfill (decision-006, shim epic S-A).
//
// JSC's wasm tiers are all unavailable on the CLoop port (IPInt has no cloop
// lowering — decision-006 NO-GO), so guest pages get this polyfill instead.
// Module bytes travel to the HOST page over the __bibWasm2js native bridge
// (registered per-window by the engine right before this script runs), the
// host translates them to plain JS with Binaryen's wasm2js, and the returned
// factory source is eval'd here. Translated code executes at CLoop-JS speed.
//
// Served by the host as Module.bibWasmPolyfill; the engine evaluates it in
// every new window object before any author script (didClearWindowObject).
//
// Known S-A limits (S-B backlog): no Module.imports/exports metadata; an
// imported Memory/Table and the translated module's internal copy diverge
// after either side grows; no worker-scope injection; eval is subject to the
// page's CSP (sites that forbid 'unsafe-eval' need a bridge-eval fallback).
(function () {
  "use strict";
  // Capture + delete the bridge BEFORE any early return, so no exit path
  // leaves a native function exposed to author script (Codex LOW).
  var bridge = globalThis.__bibWasm2js;
  delete globalThis.__bibWasm2js;
  if (typeof globalThis.WebAssembly !== "undefined")
    return;
  if (typeof bridge !== "function")
    return;

  function toBase64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function copyBytes(source) {
    if (source instanceof ArrayBuffer)
      return new Uint8Array(source.slice(0));
    if (ArrayBuffer.isView(source))
      return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
    throw new TypeError("WebAssembly: argument must be a BufferSource");
  }

  class CompileError extends Error {
    constructor(message) { super(message); this.name = "CompileError"; }
  }
  class LinkError extends Error {
    constructor(message) { super(message); this.name = "LinkError"; }
  }
  class RuntimeError extends Error {
    constructor(message) { super(message); this.name = "RuntimeError"; }
  }

  class Memory {
    constructor(descriptor) {
      if (typeof descriptor !== "object" || descriptor === null)
        throw new TypeError("WebAssembly.Memory(): argument must be a memory descriptor");
      var initial = descriptor.initial >>> 0;
      this._maximum = "maximum" in descriptor ? descriptor.maximum >>> 0 : 65536;
      this._buffer = new ArrayBuffer(initial * 65536);
    }
    get buffer() { return this._buffer; }
    grow(delta) {
      var oldPages = this._buffer.byteLength >>> 16;
      var newPages = oldPages + (delta >>> 0);
      if (newPages > this._maximum)
        throw new RangeError("WebAssembly.Memory.grow(): exceeds maximum");
      var next = new ArrayBuffer(newPages * 65536);
      new Uint8Array(next).set(new Uint8Array(this._buffer));
      this._buffer = next;
      return oldPages;
    }
  }

  // Array subclass so translated code that indexes an imported
  // __indirect_function_table directly (wasm2js emits plain element access)
  // works against the same object the spec API manipulates.
  class Table extends Array {
    constructor(descriptor) {
      super();
      this.length = descriptor && descriptor.initial ? descriptor.initial >>> 0 : 0;
      this.fill(null);
    }
    get(index) { return this[index] ?? null; }
    set(index, value) { this[index] = value; }
    grow(delta) {
      var old = this.length;
      this.length = old + (delta >>> 0);
      return old;
    }
  }

  class Global {
    constructor(descriptor, value) {
      this.value = value;
      this._mutable = !!(descriptor && descriptor.mutable);
    }
    valueOf() { return this.value; }
  }

  // Presence-checked by error reporters (Sentry: `void 0 !==
  // WebAssembly.Exception && e instanceof WebAssembly.Exception`); the
  // translated code never constructs these.
  class Tag {
    constructor() { }
  }
  class Exception extends Error {
    constructor() { super("WebAssembly.Exception"); this.name = "Exception"; }
  }

  var moduleState = new WeakMap();

  // Cheap pre-scan: how many tables the module DEFINES (table section, id 4),
  // by walking only section headers — NO binaryen, NO import-descriptor
  // parsing (which is fragile across wasm-bindgen/exception-handling
  // encodings). Binaryen's wasm2js FATALS on modules with >1 table, but only
  // AFTER emitAsmjs grinds through the whole module: libdiscore (1.17MB,
  // 2 defined tables, Rust/wasm-bindgen) took 58.8s to reject on the
  // JIT-less engine thread, freezing the tab (measured 2026-06-12). Deciding
  // it here is ~1ms. Returns -1 on any parse uncertainty -> falls through to
  // the real translate path (never a false reject). NOTE: this catches the
  // common case (>=2 tables in the table section, e.g. libdiscore); a
  // 1-imported + 1-defined split would read as 1 here and fall through — no
  // regression vs. the pre-existing slow path.
  function definedTableCount(bytes) {
    try {
      if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 ||
          bytes[2] !== 0x73 || bytes[3] !== 0x6d ||
          bytes[4] !== 0x01 || bytes[5] !== 0x00 || bytes[6] !== 0x00 || bytes[7] !== 0x00)
        return -1; // not a v1 wasm module — let the bridge decide (validate
                   // must not green-light malformed bytes via the fast path)
      var p = 8;
      function u32() { // LEB128 unsigned
        var r = 0, sh = 0, b;
        do { b = bytes[p++]; r |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80);
        return r >>> 0;
      }
      while (p < bytes.length) {
        var id = bytes[p++];
        var len = u32();
        var end = p + len;
        if (id === 4) // table section: leading count = number of defined tables
          return u32();
        p = end; // skip every other section by its declared length
      }
      return 0; // no table section
    } catch (e) {
      return -1;
    }
  }

  function translate(bytes) {
    // Reject multi-table modules instantly (binaryen would burn ~60s first).
    if (definedTableCount(bytes) > 1)
      throw new CompileError("BrowserInBrowser: module is not wasm2js-translatable (multiple tables)");
    var src = bridge(toBase64(bytes), "translate");
    if (typeof src !== "string" || !src)
      throw new CompileError("BrowserInBrowser: module is not wasm2js-translatable");
    var factory;
    try {
      factory = (0, eval)(src);
    } catch (e) {
      throw new CompileError("BrowserInBrowser: translated module failed to parse: " + e);
    }
    if (typeof factory !== "function")
      throw new CompileError("BrowserInBrowser: translation produced no factory");
    return factory;
  }

  class Module {
    constructor(bytes) {
      moduleState.set(this, { factory: translate(copyBytes(bytes)) });
    }
    // S-B: real metadata needs an import/export section parse.
    static imports() { return []; }
    static exports() { return []; }
    static customSections() { return []; }
  }

  class Instance {
    constructor(module, importObject) {
      var state = moduleState.get(module);
      if (!state)
        throw new TypeError("WebAssembly.Instance(): argument must be a WebAssembly.Module");
      var exportsObject;
      try {
        exportsObject = state.factory(importObject || {});
      } catch (e) {
        if (e instanceof CompileError || e instanceof LinkError || e instanceof RuntimeError)
          throw e;
        throw new LinkError("WebAssembly.Instance(): " + e);
      }
      this.exports = Object.freeze(exportsObject || {});
    }
  }

  function instantiate(source, importObject) {
    return new Promise(function (resolve) {
      if (source instanceof Module) {
        resolve(new Instance(source, importObject));
        return;
      }
      var module = new Module(source);
      resolve({ module: module, instance: new Instance(module, importObject) });
    });
  }

  function responseToBytes(source) {
    return Promise.resolve(source).then(function (response) {
      if (!response || typeof response.arrayBuffer !== "function")
        throw new TypeError("WebAssembly streaming: expected a Response");
      if ("ok" in response && !response.ok)
        throw new TypeError("WebAssembly streaming: response failed");
      return response.arrayBuffer();
    });
  }

  function compile(bytes) {
    return new Promise(function (resolve) { resolve(new Module(bytes)); });
  }

  function validate(bytes) {
    var copy = copyBytes(bytes); // TypeError on non-BufferSource, per spec
    if (copy.length < 8 || copy[0] !== 0 || copy[1] !== 0x61 || copy[2] !== 0x73 || copy[3] !== 0x6d)
      return false;
    // A multi-table module is valid wasm (validate -> true), just not
    // wasm2js-translatable — short-circuit so feature-detection doesn't pay
    // binaryen's readBinary (~1.6s for libdiscore) or the base64 round-trip.
    if (definedTableCount(copy) > 1)
      return true;
    return bridge(toBase64(copy), "validate") === "1";
  }

  var ns = {
    compile: compile,
    compileStreaming: function (source) { return responseToBytes(source).then(compile); },
    instantiate: instantiate,
    instantiateStreaming: function (source, importObject) {
      return responseToBytes(source).then(function (bytes) { return instantiate(bytes, importObject); });
    },
    validate: validate,
    Module: Module,
    Instance: Instance,
    Memory: Memory,
    Table: Table,
    Global: Global,
    Tag: Tag,
    Exception: Exception,
    CompileError: CompileError,
    LinkError: LinkError,
    RuntimeError: RuntimeError,
  };
  if (typeof Symbol !== "undefined" && Symbol.toStringTag)
    Object.defineProperty(ns, Symbol.toStringTag, { value: "WebAssembly" });

  Object.defineProperty(globalThis, "WebAssembly", {
    value: ns,
    writable: true,
    enumerable: false,
    configurable: true,
  });
})();
