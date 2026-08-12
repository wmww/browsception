/*
 * W-B1 engine pre-js — emitted into embedder.js, so it runs in EVERY scope
 * the module loads in: the page, the node runner, and each pthread pool
 * worker. Everything here targets ONE scope: the engine pthread's worker.
 * Under -sPROXY_TO_PTHREAD the engine's EM_ASM blocks execute in that
 * worker scope, whose Module does NOT inherit the page Module's fields
 * (W-B0 spike, commit 2497a89) — so the hooks the engine reads at runtime
 * must be installed here:
 *   - bibWakeUp / bibArmTimer: the event-driven RunLoop pump, now
 *     worker-LOCAL (MessageChannel/setTimeout in this scope re-enter
 *     _bib_pump on this same thread — no cross-thread hop, simpler than
 *     the old page-side plumbing it replaces).
 *   - bibWasmPolyfill: guest-injection text (wasm polyfill + media stub),
 *     fetched with sync XHR (legal and cheap in a worker).
 *   - bibWasm2js: binaryen wasm2js translation, loaded via dynamic import
 *     (binaryen.js is ESM-only). Translation is synchronous AND legal here
 *     — on the page it janked the UI thread (the W-B "strict upgrade").
 *     Returns null until the import resolves (~100-300ms after boot);
 *     callers see CompileError, same as a translation failure.
 *
 * Leading ";": emcc splices pre-js mid-expression (ASI trap, W-B0).
 */
;(function () {
  var isWorker = (typeof window === "undefined") && (typeof WorkerGlobalScope !== "undefined");
  if (!isWorker)
    return; // page + node scopes: browser.html / run-embedder.cjs own Module

  function installHooks() {
    if (typeof Module === "undefined" || !Module || Module.__bibWorkerHooks)
      return typeof Module !== "undefined" && !!Module;
    Module.__bibWorkerHooks = true;

    // --- event-driven pump, worker-local -------------------------------
    var pumpScheduled = false;
    var pumpFailures = 0;
    var pumpChannel = new MessageChannel();
    pumpChannel.port1.onmessage = function () {
      pumpScheduled = false;
      try {
        if (typeof _bib_pump === "function")
          _bib_pump();
        pumpFailures = 0;
      } catch (e) {
        // Post-abort the export throws on every call — disarm after a
        // BURST of failures, never on one (a single transient throw must
        // not permanently kill the engine's wakeup channel — Codex W-B1).
        if (++pumpFailures >= 8) {
          console.error("engine-pre: pump disarmed after repeated failures: " + e);
          pumpChannel.port1.onmessage = null;
        }
      }
    };
    Module.bibWakeUp = function () {
      if (pumpScheduled)
        return;
      pumpScheduled = true;
      pumpChannel.port2.postMessage(0);
    };
    var pumpTimer = { id: 0, at: Infinity };
    Module.bibArmTimer = function (ms) {
      var at = performance.now() + ms;
      if (at >= pumpTimer.at - 0.25)
        return;
      clearTimeout(pumpTimer.id);
      pumpTimer.at = at;
      pumpTimer.id = setTimeout(function () {
        pumpTimer.at = Infinity;
        try {
          if (typeof _bib_pump === "function")
            _bib_pump();
        } catch (e) {}
      }, Math.max(0, ms));
    };

    // --- guest-injection text (wasm polyfill + media stub) --------------
    function syncFetchText(path) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", path, false); // sync XHR: legal in workers
        xhr.send();
        return (xhr.status >= 200 && xhr.status < 300) ? xhr.responseText : "";
      } catch (e) {
        return "";
      }
    }
    var polyfillText = syncFetchText("/wasm-polyfill.js");
    var mediaText = syncFetchText("/media-stub.js");
    if (!polyfillText)
      console.warn("engine-pre: wasm-polyfill.js unavailable (guest wasm shim off)");
    if (!mediaText)
      console.warn("engine-pre: media-stub.js unavailable");
    // wasm half is only useful with binaryen; media half is independent —
    // same composition rule as browser.html's wasmShimReady.
    Module.bibWasmPolyfill = polyfillText + (polyfillText && mediaText ? "\n;\n" : "") + mediaText;

    // --- binaryen wasm2js bridge (same translation as browser.html) -----
    var binaryen = null;
    import("/vendor/binaryen.js")
      .then(function (m) { binaryen = m.default; })
      .catch(function (e) { console.warn("engine-pre: binaryen.js failed to load: " + e); });
    Module.bibWasm2js = function (payload, mode) {
      if (!binaryen)
        return null; // not loaded (yet) — guest sees CompileError
      var mod = null;
      try {
        var bin = atob(payload);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++)
          bytes[i] = bin.charCodeAt(i);
        mod = binaryen.readBinary(bytes); // throws on invalid bytes, instance survives
        // wasm2js -all parity: MVP default + bulk-memory module trips a
        // C-level assert that bricks the binaryen instance for the session.
        mod.setFeatures(binaryen.Features.All);
        if (mode === "validate")
          return "1";
        var js = mod.emitAsmjs();
        var importLines = [];
        js = js.replace(/^import \* as ([A-Za-z_$][\w$]*) from '([^']*)';\s*$/gm, function (_, local, name) {
          importLines.push([local, name]);
          return "";
        });
        // Column-0 anchored: the auto-instantiation tail is the only place
        // these names appear unindented (verified across the 102-module
        // corpus; function-body vars are always indented).
        var tail = js.search(/\nvar (mem|ret)asmFunc/);
        if (tail >= 0)
          js = js.slice(0, tail);
        var header = importLines
          .map(function (p) { return "var " + p[0] + " = imports[" + JSON.stringify(p[1]) + "] || {};\n"; })
          .join("");
        return "(function(imports){\n" + header + js + "\n;return asmFunc(imports);})";
      } catch (e) {
        if (mode === "validate")
          return "0";
        console.warn("engine-pre: wasm2js translate failed: " + (e && e.message ? e.message : e));
        return null;
      } finally {
        try { mod && mod.dispose(); } catch (e) {}
      }
    };

    // --- GPU zero-copy present bridge (engine pthread only) -------------
    // The page presents engine frames onto #screen via a bitmaprenderer
    // context fed by ImageBitmaps. We CREATE a dedicated MessageChannel here
    // and hand the page port2 inside the one-time "hello" (sent from C++ via
    // Module.bibPresentWorkerHello). All frame traffic rides port1; the raw
    // Emscripten pthread Worker stream carries ONLY that single hello, so we
    // never collide with Emscripten's cmd-tagged pthread protocol (the hello
    // and the frames have no "cmd" field). Triple-buffered backpressure: the
    // worker may run up to maxInFlight un-acked frames ahead of the page (see
    // bibBitmapPresentReady) — decoupled from the per-frame ack round-trip.
    Module.__bibPresent = {
      port: null,
      wired: false,      // page has bound its receiver (sent the initial ready)
      inFlight: 0,       // frames posted but not yet acked by the page
      maxInFlight: 3,    // triple-buffer headroom (see bibBitmapPresentReady)
      nextId: 0,
      width: 0,
      height: 0,
      framesPosted: 0,
      framesSkipped: 0
    };

    // C++ checks this before snapshotting/clearing WebCore damage. If it
    // returns 0, C++ returns without painting; damage stays armed and
    // coalesces into the next deliverable frame.
    //
    // We allow up to maxInFlight UN-ACKED frames (triple buffer) rather than a
    // strict one-in-flight gate. One-in-flight made the engine block on a full
    // round-trip ack for EVERY frame; because the present only runs inside the
    // page-rAF-driven bib_tick (which collapses bursts), a tick frequently ran
    // and skipped just before the ack landed, then nothing rescheduled a tick
    // until the next rAF — a ~16ms+ dead gap per frame that stacked into the
    // "smooth then lock to 1fps" stutter on hard-graphics pages. Letting the
    // engine run a few frames ahead decouples it from the compositor round-trip
    // (raster never had this gate — it is fire-and-forget). The cadence stays
    // self-limited: the SAME main-thread rAF drives both production (_bib_tick)
    // and consumption (port.onmessage), so the engine cannot outrun the page;
    // maxInFlight only bounds the GPU-backed ImageBitmaps alive at once (memory)
    // and preserves real backpressure when the page genuinely stalls.
    Module.bibBitmapPresentReady = function () {
      var p = Module.__bibPresent;
      return !!(p && p.port && p.wired && p.inFlight < p.maxInFlight);
    };

    // Called once from C++ main() (Module.bibPresentWorkerHello($w,$h)) after
    // the bibgpu OffscreenCanvas + Skia surfaces exist. Creates the channel,
    // keeps port1, and transfers port2 to the page. wired starts FALSE: the
    // first present waits for the page's first {t:"ready"} so no frame is
    // posted before the page has wired its receiver.
    Module.bibPresentWorkerHello = function (w, h) {
      var p = Module.__bibPresent;
      p.width = w | 0;
      p.height = h | 0;
      var ch = new MessageChannel();
      p.port = ch.port1;
      p.wired = false;
      p.inFlight = 0;
      ch.port1.onmessage = function (e) {
        var d = e.data || {};
        // Optional present-depth knob from the page (?inflight=N). Sent on bind
        // BEFORE the first {t:"ready"}, so it lands before any present. 1 ==
        // the legacy strict one-in-flight behavior (for A/B); default 3.
        if (d.t === "config") {
          if (typeof d.maxInFlight === "number" && d.maxInFlight >= 1)
            p.maxInFlight = d.maxInFlight | 0;
          return;
        }
        // Each {t:"ready"} returns one credit. The page's first ack (id 0,
        // sent on bind) carries no frame — it only marks the port wired, so
        // clamp the decrement at 0.
        if (d.t === "ready") { p.wired = true; if (p.inFlight > 0) p.inFlight--; return; }
        if (d.t === "close") { p.wired = false; p.port = null; p.inFlight = 0; return; }
      };
      if (ch.port1.start) ch.port1.start();
      // worker->main only; transfer port2. No "cmd" field (Emscripten's
      // main-thread worker handler ignores cmd-less messages).
      self.postMessage({ __bibPresent: "hello", w: p.width, h: p.height }, [ch.port2]);
    };

    // C++ calls this ONLY after: WebCore/Ganesh painted into the persistent
    // texture surface, that surface was drawn into the bibgpu OffscreenCanvas
    // FBO 0, and FlushAndSubmit(FBO0) ran. transferToImageBitmap() snapshots
    // FBO 0 and resets the OffscreenCanvas to blank — fine, because the
    // persistent backing store is the texture surface (C++ side), not FBO 0.
    // Returns 1 posted, 0 not-ready, -1 no-canvas, -2 transfer-threw.
    Module.bibTransferCurrentFrame = function () {
      var p = Module.__bibPresent;
      if (!p || !p.port || !p.wired || p.inFlight >= p.maxInFlight) { if (p) p.framesSkipped++; return 0; }
      var entry = (typeof GL !== "undefined") && GL.offscreenCanvases &&
        GL.offscreenCanvases["bibgpu"];
      var oc = entry && (entry.offscreenCanvas || entry.canvas);
      if (!oc || typeof oc.transferToImageBitmap !== "function")
        return -1;
      var bitmap;
      try {
        bitmap = oc.transferToImageBitmap();
      } catch (e) {
        console.error("engine-pre: transferToImageBitmap failed: " + e);
        return -2;
      }
      // Zero-copy ownership transfer of the ImageBitmap to the page. Count the
      // in-flight frame ONLY after a confirmed post: if postMessage throws
      // (dead port / transfer error) the bitmap was NOT transferred, so close
      // it (no leak) and do NOT increment inFlight — C++ re-arms damage and
      // retries, and the credit is never stranded (Codex 2026-06-13).
      var id = ++p.nextId;
      try {
        p.port.postMessage({ t: "frame", id: id, bitmap: bitmap, w: p.width, h: p.height }, [bitmap]);
      } catch (e) {
        console.error("engine-pre: present postMessage failed: " + e);
        try { bitmap.close(); } catch (_) {}
        return -3;
      }
      p.inFlight++;
      p.framesPosted++;
      return 1;
    };

    return true;
  }

  // `var Module` hoists — at pre-js time (and even at microtask/timeout
  // time) the pthread bootstrap may not have built Module yet: the worker
  // assembles it while handling the 'load'/'run' messages, AFTER this
  // script evaluates. The guaranteed install point is C: main() executes
  // in THIS scope with Module fully alive and calls
  // self.__bibInstallWorkerHooks() as its first statement (gate9 caught
  // the early attempts silently missing — empty bibWasmPolyfill was
  // cached for the session). The eager attempts below remain as a best
  // effort so the hooks exist as early as possible.
  self.__bibInstallWorkerHooks = installHooks;
  if (!installHooks()) {
    Promise.resolve().then(installHooks);
    setTimeout(installHooks, 0);
  }
})();
