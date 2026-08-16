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
 *     (npm `binaryen`, ESM-only, served from node_modules by the dev
 *     server's /vendor mount). Translation is synchronous AND legal here
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

    // --- crash triage: name the frames the engine died in ---------------
    // The engine thread is where WebCore runs, so it is where aborts happen.
    // abort() calls Module.onAbort synchronously, so a stack captured HERE
    // still has the C++ frames below it, and the wasm carries a name section
    // — they read as `WebCore::Foo::bar`. Worth the lines: the reason string
    // is empty for a bare RELEASE_ASSERT (no -sASSERTIONS in this build), so
    // without this a crash is an unattributable "Aborted()". err() forwards
    // to the host page's console.
    //
    // It must CHAIN, not replace: the page's own onAbort (the crashed-UI kill
    // switch) reaches this thread as a proxy stub that the pthread bootstrap
    // installs only into an empty-or-proxy slot, so a plain assignment here
    // wins that race and silently eats the crash notification. Hence the
    // accessor: `.proxy` invites the bootstrap to overwrite us, and the setter
    // captures its stub instead (tier-2 scenario 12 is the tripwire).
    var forwardOnAbort = null;
    var abortHook = function (what) {
      try {
        var out = (typeof err === "function") ? err : console.error;
        out("engine abort stack (reason: " + (what === undefined ? "" : what) + ") "
            + new Error("engine abort").stack);
      } catch (e) {}
      if (typeof forwardOnAbort === "function")
        forwardOnAbort(what);
    };
    abortHook.proxy = true;
    Object.defineProperty(Module, "onAbort", {
      configurable: true,
      get: function () { return abortHook; },
      set: function (v) { forwardOnAbort = v; },
    });

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
    import("/vendor/binaryen/index.js")
      .then(function (m) { binaryen = m.default; })
      .catch(function (e) { console.warn("engine-pre: binaryen failed to load: " + e); });
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
