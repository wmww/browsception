// BrowserInBrowser media element stub (Audio gap, Tier A1 — task #56).
//
// The engine builds with ENABLE_VIDEO=OFF, so HTMLMediaElement and friends
// don't exist in the bindings at all (Conditional=VIDEO is compile-time).
// Sites probe media support at webpack-module TOP LEVEL — Discord:
//   `""!==new Audio().canPlayType("audio/ogg; codecs=opus")`
//   `"requestVideoFrameCallback" in HTMLVideoElement.prototype`
// — and one ReferenceError there collapses the whole chunk graph. This stub
// restores the globals with ENGINE-HONEST semantics: exactly what a Tier A2
// build (ENABLE_VIDEO=ON, zero media engines) will answer.
// MediaPlayer::supportsType with an empty engine vector is IsNotSupported,
// so canPlayType() === ""; play() rejects NotSupportedError; load() fires an
// async `error` event with MEDIA_ERR_SRC_NOT_SUPPORTED.
//
// IDL attributes live as PROTOTYPE accessors (backed by _-prefixed own
// fields), matching real bindings so `"volume" in HTMLMediaElement.prototype`
// style probes classify us correctly (Codex MED, 2026-06-11).
//
// Delivered through the S-A injection pipe: the host concatenates this after
// wasm-polyfill.js into Module.bibWasmPolyfill, and the engine evaluates the
// combined text in every new window before any author script
// (didClearWindowObject). Self-disables once a Tier A2 build provides the
// real elements. Limits: instances are not Nodes (no instanceof HTMLElement,
// can't be inserted into the DOM); document.createElement("audio"/"video")
// still yields elements unrelated to these classes; no <source> children;
// no playback ever.
(function () {
  "use strict";
  // Defensive: if the wasm-polyfill half of the payload was unavailable
  // (host-side binaryen failure), the engine-installed bridge is still on
  // the global — never leave a native function exposed to author script.
  // No-op in the normal case (the polyfill captures + deletes it first).
  if (typeof globalThis.__bibWasm2js !== "undefined")
    delete globalThis.__bibWasm2js;
  // Self-disable against real (Tier A2 / future) media element support.
  if (typeof globalThis.Audio !== "undefined" || typeof globalThis.HTMLAudioElement !== "undefined")
    return;

  function domException(message, name) {
    // DOMException is constructible in our build; the fallback is for
    // belt-and-braces only (sites match on .name either way).
    try {
      return new DOMException(message, name);
    } catch (_) {
      var err = new Error(message);
      err.name = name;
      return err;
    }
  }

  // Real MediaError has no public constructor; constructibility here is a
  // harmless stub liberty. Code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED — what a
  // zero-engine load algorithm reports.
  class MediaError {
    constructor(code, message) {
      this._code = code >>> 0;
      this._message = String(message === undefined ? "" : message);
    }
    get code() { return this._code; }
    get message() { return this._message; }
  }

  // Always-empty ranges: nothing is ever buffered/played/seekable without a
  // media engine. Spec: start/end on an empty TimeRanges is IndexSizeError.
  class TimeRanges {
    get length() { return 0; }
    start() { throw domException("Index out of range", "IndexSizeError"); }
    end() { throw domException("Index out of range", "IndexSizeError"); }
  }

  class HTMLMediaElement {
    constructor() {
      this._listeners = Object.create(null);
      this._loadToken = 0;
      this._src = "";
      this._error = null;
      this._currentSrc = "";
      this._volume = 1;
      this._muted = false;
      this._defaultMuted = false;
      this._loop = false;
      this._autoplay = false;
      this._controls = false;
      this._preload = "auto";
      this._crossOrigin = null;
      this._currentTime = 0;
      this._duration = NaN;
      this._paused = true;
      this._ended = false;
      this._seeking = false;
      this._playbackRate = 1;
      this._defaultPlaybackRate = 1;
      this._readyState = 0; // HAVE_NOTHING
      this._networkState = 0; // NETWORK_EMPTY
    }

    get src() { return this._src; }
    set src(value) {
      this._src = String(value);
      this.load();
    }

    get buffered() { return new TimeRanges(); }
    get played() { return new TimeRanges(); }
    get seekable() { return new TimeRanges(); }

    // Own listener plumbing: instances aren't EventTargets (the real
    // EventTarget can't be subclassed into a non-Node object here), so
    // dispatch is local — listeners + the on<type> handler property.
    addEventListener(type, listener, options) {
      if (listener === null || (typeof listener !== "function" && typeof listener !== "object"))
        return;
      var list = this._listeners[type] || (this._listeners[type] = []);
      for (var i = 0; i < list.length; i++) {
        if (list[i].listener === listener)
          return; // already registered (capture flag ignored: no tree, no phases)
      }
      list.push({ listener: listener, once: !!(options && options.once) });
    }
    removeEventListener(type, listener) {
      var list = this._listeners[type];
      if (!list)
        return;
      for (var i = 0; i < list.length; i++) {
        if (list[i].listener === listener) {
          list.splice(i, 1);
          return;
        }
      }
    }
    dispatchEvent(event) {
      var type = event && event.type;
      if (!type)
        return true;
      var handler = this["on" + type];
      if (typeof handler === "function") {
        try { handler.call(this, event); } catch (_) { }
      }
      var live = this._listeners[type];
      if (live) {
        // Snapshot for iteration order, but honor removal mid-dispatch: an
        // entry unsubscribed by an earlier listener must not fire.
        var snapshot = live.slice(0);
        for (var i = 0; i < snapshot.length; i++) {
          var entry = snapshot[i];
          if (live.indexOf(entry) < 0)
            continue;
          if (entry.once)
            this.removeEventListener(type, entry.listener);
          try {
            if (typeof entry.listener === "function")
              entry.listener.call(this, event);
            else if (typeof entry.listener.handleEvent === "function")
              entry.listener.handleEvent(event);
          } catch (_) { }
        }
      }
      return true;
    }

    canPlayType() { return ""; }

    play() {
      return Promise.reject(domException(
        "BrowserInBrowser: media playback is not supported (no media engine)",
        "NotSupportedError"));
    }
    pause() { }

    load() {
      // Token invalidates any failure already queued by a previous load();
      // only the latest load may report (per-load token, Codex review).
      var token = ++this._loadToken;
      this._error = null;
      this._readyState = 0; // HAVE_NOTHING
      if (!this._src) {
        this._currentSrc = "";
        this._networkState = 0; // NETWORK_EMPTY
        return;
      }
      this._currentSrc = this._src;
      this._networkState = 2; // NETWORK_LOADING, until the queued failure
      var self = this;
      setTimeout(function () {
        if (self._loadToken !== token)
          return;
        self._error = new MediaError(4, "BrowserInBrowser: no media engine");
        self._networkState = 3; // NETWORK_NO_SOURCE
        self.dispatchEvent({ type: "error", target: self, currentTarget: self });
      }, 0);
    }
  }

  class HTMLAudioElement extends HTMLMediaElement {
    constructor(src) {
      super();
      if (src !== undefined)
        this.src = src; // accessor — schedules the honest error event
    }
  }

  class HTMLVideoElement extends HTMLMediaElement {
    constructor() {
      super();
      this._videoWidth = 0;
      this._videoHeight = 0;
      this._poster = "";
      this._playsInline = false;
    }
  }

  // IDL attributes as prototype accessors over the _-backing fields, like
  // real bindings. Readonly attributes get no setter (strict-mode author
  // assignment throws, same as the real prototype).
  function defineAttributes(proto, readWrite, readOnly) {
    readWrite.forEach(function (name) {
      Object.defineProperty(proto, name, {
        get: function () { return this["_" + name]; },
        set: function (value) { this["_" + name] = value; },
        enumerable: true, configurable: true,
      });
    });
    readOnly.forEach(function (name) {
      Object.defineProperty(proto, name, {
        get: function () { return this["_" + name]; },
        enumerable: true, configurable: true,
      });
    });
  }
  defineAttributes(HTMLMediaElement.prototype,
    ["volume", "muted", "defaultMuted", "loop", "autoplay", "controls", "preload",
      "crossOrigin", "currentTime", "playbackRate", "defaultPlaybackRate",
      "onerror", "onended", "onplay", "onpause", "oncanplay", "oncanplaythrough",
      "onloadedmetadata", "onloadeddata", "ontimeupdate", "onvolumechange"],
    ["error", "currentSrc", "duration", "paused", "ended", "seeking",
      "readyState", "networkState"]);
  defineAttributes(HTMLVideoElement.prototype,
    ["poster", "playsInline"],
    ["videoWidth", "videoHeight"]);

  // Event handler backing fields live on the prototype-accessor path too;
  // initialize to null so `el.onerror` reads null before any assignment.
  ["onerror", "onended", "onplay", "onpause", "oncanplay", "oncanplaythrough",
    "onloadedmetadata", "onloadeddata", "ontimeupdate", "onvolumechange"
  ].forEach(function (name) {
    HTMLMediaElement.prototype["_" + name] = null;
  });

  // Numeric constants, visible on instances and (via static inheritance)
  // on all three classes.
  var mediaConstants = {
    NETWORK_EMPTY: 0, NETWORK_IDLE: 1, NETWORK_LOADING: 2, NETWORK_NO_SOURCE: 3,
    HAVE_NOTHING: 0, HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3, HAVE_ENOUGH_DATA: 4,
  };
  for (var name in mediaConstants) {
    Object.defineProperty(HTMLMediaElement, name, { value: mediaConstants[name], enumerable: true });
    Object.defineProperty(HTMLMediaElement.prototype, name, { value: mediaConstants[name], enumerable: true });
  }
  var errorConstants = {
    MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
  };
  for (var errName in errorConstants) {
    Object.defineProperty(MediaError, errName, { value: errorConstants[errName], enumerable: true });
    Object.defineProperty(MediaError.prototype, errName, { value: errorConstants[errName], enumerable: true });
  }

  // LegacyFactoryFunction shape: `Audio` is its own function object whose
  // .prototype is HTMLAudioElement.prototype, so
  // `new Audio() instanceof HTMLAudioElement` holds.
  function Audio(src) {
    return new HTMLAudioElement(src);
  }
  Audio.prototype = HTMLAudioElement.prototype;

  var globals = {
    Audio: Audio,
    HTMLMediaElement: HTMLMediaElement,
    HTMLAudioElement: HTMLAudioElement,
    HTMLVideoElement: HTMLVideoElement,
    MediaError: MediaError,
    TimeRanges: TimeRanges,
  };
  for (var g in globals) {
    Object.defineProperty(globalThis, g, {
      value: globals[g], writable: true, enumerable: false, configurable: true,
    });
  }
})();
