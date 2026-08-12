# Engine internals: hard limits & WebKit gotchas

Distilled from the fork's docs/recaps at import time (2026-08-12). These are the facts that
re-bite on rebases or bound future features.

## Hard limits of this engine build

- **Guest WebAssembly is structurally impossible under CLoop** (not just disabled): IPInt has no
  cloop lowering — `IPInt::initialize()` is `RELEASE_ASSERT_NOT_REACHED` under `C_LOOP`, and
  enabling `ENABLE_WEBASSEMBLY` aborts at boot. Hence the binaryen wasm2js shim (roadmap).
  wasm2js limits measured: 102/103 of Discord's modules translate; ~×3.5 JS size; multi-table
  (wasm-bindgen externref) untranslatable; translate time is module-shape-bound (one 1.09 MB
  module = 109 s, froze engine thread) → translate off-thread + cache. binaryen.js defaults to
  MVP features: call `setFeatures(All)` right after `readBinary` or bulk-memory modules abort.
- **WebCrypto doesn't exist**: `CryptoStubsEmscripten.cpp` registers zero algorithms (WebKit
  2.52's `crypto/openssl` is BoringSSL-flavored, doesn't compile vs real OpenSSL; and OpenSSL is
  gone from our link anyway). Realistic route: bridge `SubtleCrypto` to the host. Trap for that
  day: worker `serializeAndWrapCryptoKey` post-then-wait deadlocks under main-thread workers.
- **Workers run on the engine thread** (`WorkerThreadMode::UseMainThread`): module workers throw,
  `importScripts` → NetworkError, sync XHR and worker WebSocket unsupported, a spinning worker
  wedges the engine. Patched upstream landmine: `WorkerMainRunLoop::postTaskForMode` silently
  drops pre-bootstrap tasks (the port requeues). Before real worker threads: `WorkQueue::
  dispatchSync` is patched to run inline (wrong off-main), `RunLoop::wakeUp` has no host pump
  wake off-main, and GC requires **one mutator thread per VM** (`Thread::suspend` traps on wasm;
  keep SAMPLING_PROFILER/REMOTE_INSPECTOR off).
- **IndexedDB is in-memory only** (`BibIDBServer` passes empty directory) — lost per reload. OPFS
  persistence covers cookies/localStorage only.
- **Media**: no-engine registered → sites get spec-correct failure (`canPlayType ""`, play()
  rejects). MSE/WebRTC compiled out. `BibMediaPlayer` (audio-only, host Blob-URL, 64 MB cap)
  exists engine-side but its host hooks were only in the fork's dev browser.html — never ported
  to our viewer; video never implemented. Gotcha: a Page without `PageIdentifier` has no
  mediaSessionManager → every `play()` parks forever; keep passing `PageIdentifier::generate()`.
- **Guest `new WebSocket()`**: WebKit ≥2.46 has no in-WebCore channel; a null provider channel
  hits `RELEASE_ASSERT(m_channel)` and kills the engine. Fork's `BibSocketProvider` channel rode
  CurlStream (deleted) — re-check what we ship now; a fail-fast channel (error + close 1006)
  reads as unreachable-server and sites take offline paths.
- **Unfixed intermittent JSC Release abort under CLoop**: `Structure::materializePropertyTable`
  offset-inconsistency (off by one; PropertyDeletion replay suspected). `checkOffsetConsistency`
  is ALWAYS_INLINE, not assert-gated, no build-flag escape; patching it out = silently wrong
  property reads.

## WebKit-internals gotchas (re-bite on every rebase)

- **The `Empty*Client` family fails silently, always.** When something "does nothing", check what
  `pageConfigurationWithEmptyClients` installed before suspecting wasm. Known silent kills:
  hardcoded `SandboxFlags::all()` (no script runs until cleared via
  `LocalMainFrameCreationParameters.effectiveSandboxFlags`); `EmptyFrameLoaderClient` drops
  `FramePolicyFunction` (navigations stall), `canHandleRequest`/`canShowMIMEType` false,
  no-op `committedLoad`, `createFrame()` → nullptr (iframes get null contentWindow);
  `EmptyStorageSessionProvider::storageSession()` → nullptr (cookies vanish); back/forward
  capacity 0; `EmptyEditorClient` blocks all editing (`final` — needs guard relaxation in
  EmptyClients.h); null `createBlobRegistry()` aborts on first `new Blob()`;
  `EmptyDatabaseProvider::idbConnectionToServerForSession` is RELEASE_ASSERT. `PlatformStrategies`
  is mandatory (`FrameLoader::pageLoadCompleted` derefs unconditionally). Never cache a
  `LocalFrameView` — `createView()` per commit or blank paint after first nav.
- **No `DisplayRefreshMonitor` in a custom port** → guest rAF never fires and "update the
  rendering" never runs unless the embedder calls `Page::updateRendering()` +
  `finalizeRenderingUpdate({})` per host frame.
- **`ScrollAnimator::scrollAnimationEnabled` base returns true** (only COORDINATED_GRAPHICS
  overrides) → wheel events become smooth-scroll animations nothing ticks: handled=1, no motion
  (thumb drag works, masking it). Route to `immediateScrollBy` via Settings.
- **WebCore-direct embedders get the `WebCore:` default column of UnifiedWebPreferences.yaml**,
  not WebKit2 defaults. Default-FALSE booby traps: `loadsImagesAutomatically`,
  `LocalStorageEnabled`/`SessionStorageEnabled` (IDL-gated → ReferenceError, kills SPA boots),
  `RequestIdleCallbackEnabled`, `CanvasUsesAcceleratedDrawing`.
- **Reachable-from-content thread landmines**: `IDBBackingStore` ctor/dtor, `~AsyncFileStream`,
  `callOnIDBSerializationThreadAndWait` all RELEASE_ASSERT-or-`Thread::create` off-main. And
  `SynchronizedFixedQueue` (ImageFrameWorkQueue, size 8) blocking-enqueues: with no consumer
  thread, wasm futex waits spin 100% CPU forever (>8 pending image decodes did it).
- **`createImageBitmap()` on USE(SKIA) CPU-raster requests Accelerated unconditionally**
  (escape hatch is PLATFORM(GTK)-only) → unguarded `PlatformDisplay::sharedDisplay()` abort.
  The patch's `sharedDisplayIfExists()` early-out hunk must survive rebases.
- **Scroll damage semantics**: `ScrollView::scrollContents` calls invalidateRootView(full rect)
  on every scroll *before* `ChromeClient::scroll` — it means "push backing store", not damage.
  `canBlitOnScroll()` is false under fixed/sticky and virtualized/transformed scrollers. A single
  unioned damage rect is structurally wrong for scroll (strip ∪ scrollbar ≈ 80% of frame) — the
  4-entry merge-on-overlap damage list is what got 24 → 5.6 ms. (Working blit documented in
  rendering-input.md; this is the why.)

## Perf constraints (numbers that bound designs)

- **Skia paint is the entire cost**: full-viewport 800×600 paint ≈ 32 ms (old.reddit) / 111 ms
  (Discord); small-damage frame 0.3 ms; blit/pump are noise. `-msimd128` ≈ zero on real content.
  libjpeg-turbo is built `WITH_SIMD=0` (webcore-deps.sh) — cheap win if JPEG decode shows hot.
- **The no-JIT wall**: Discord hydration = one synchronous 10.5 s `RunLoop::cycle()` building
  ~95 MB of JS objects (JIT would be ~300 ms). GC is not a cost center (full collect 2–6 ms).
  The cycle is uninterruptible and cross-thread paint mid-handler is unsafe → "make the engine
  yield" designs are dead; only host-side mitigation. A `JSC::Watchdog` fixes runaway loops but
  not legitimate multi-second hydration (bounds issues/guest-js-can-wedge-engine-thread.md).
  Helper-call boundary ~0.5–5 µs → a wasm-compiled JS tier that bounces per property op can't
  beat CLoop unless it inlines ICs/allocation/barriers (i.e. is a baseline JIT).
- **RunLoop quantization**: `performWork` swap semantics make mid-cycle dispatches wait a full
  cycle — a pure-rAF pump costs a display frame per `callOnMainThread` hop; use
  `RunLoop::setWakeUpCallback` for the event-driven pump (MessageChannel hop 16.5 → 0.4 ms).
  `cycle()` in Iterate mode never blocks — safe from host callbacks. Current main.cpp still has
  `kRcapUpdateBudget = 0.33` — the dynamic-cap shape that measured 5.2× worse than fixed
  `rcap=30` on MotionMark (see issues/rcap-dynamic-budget.md). `bib_tick` updates rendering
  *before* `bibPushFrameIfDirty` (finished frame waits a tick); `bib_pump*` cycle with no paint.
- **Present pacing**: return frame credit **after** composite; early ack at queue depth 3 →
  bimodal near-freezes. Depth 1 needs tick-on-ack or a ~16 ms dead gap appears.
- **Heap views**: only `Module.HEAPU8` is exported (build other views from `HEAPU8.buffer`);
  memory growth detaches views — re-acquire after growth. Canvas `getImageData` is
  premultiplied-lossy — verify pixels from the engine's own bytes.
- **Host RAM ≈ 1 GB per engine instance** (256 MB heap + compiled ~100 MB module). Firefox
  reclaims dead wasm instances lazily (30–60 s+) → rapid reloads stack to 4+ GB; Chromium tears
  down within a cycle. Relevant to reload/crash-recovery and the Firefox port.
