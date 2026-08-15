// BrowserInBrowser embedder.
// Builds a WebCore::Page against internal headers (no public embedding API
// exists outside Cocoa — decision-001), loads a fixed HTML string, lays it
// out, and paints through a Skia raster surface.
//
// Two modes, decided at runtime by Module.bibInteractive:
//  - gate mode (node, tools/run-embedder.cjs): one paint → PPM dump in the
//    wasm FS + region-pixel assertions → exit. The Phase 2 gate, unchanged.
//  - interactive mode (browser host page, web/browser.html): main() sets the
//    page up, signals Module.onEngineReady, then keeps the runtime alive.
//    The host drives bib_tick()/bib_render() from requestAnimationFrame and
//    blits the returned RGBA buffer to a <canvas> via putImageData.
//
// Construction sequence is cribbed from SVGImage::dataChanged() — the one
// in-tree user of pageConfigurationWithEmptyClients() that paints.

#include "config.h"

#include "BibIDBServer.h"
#include "BibMediaPlayer.h" // g_mediaEnabled boot flag
#include "BibBackForward.h"
#include "BibPageClients.h"
#include "BibSocketProvider.h"
#include "BibStorage.h"
#include "CommonAtomStrings.h"
#include "CookieJar.h"
#include "Document.h"
#include "DocumentLoader.h"
#include "DocumentView.h" // inline LocalFrame::view() lives here, not in LocalFrame.h
#include "DocumentWriter.h"
#include "EmptyClients.h"
#include "EventHandler.h"
#include "FocusController.h"
#include "FrameLoadRequest.h"
#include "FrameLoader.h"
#include "GLContext.h" // presentGPU: makeContextCurrent on the shared display's context
#include "GraphicsContextSkia.h"
#include "HandleUserInputEventResult.h"
#include "LocalFrame.h"
#include "LocalFrameInlines.h"
#include "LocalFrameView.h"
#include "MemoryCache.h"
#include "CommonVM.h" // #77/OOM probe: commonVM().heap.size() for the JS-heap gauge
#include "NetworkStorageSession.h" // persistence: cookieDatabase() dump/seed
#include "Page.h"
#include "PageConfiguration.h"
#include "PlatformDisplay.h"
#include "PlatformDisplayEmscripten.h"
#include "PlatformKeyboardEvent.h"
#include "PlatformMouseEvent.h"
#include "PlatformWheelEvent.h"
#include "RenderTreeAsText.h"
#include "ResourceRequest.h"
#include "ScriptController.h"
#include "ScrollAnimator.h"
#include "ScrollingCoordinatorTypes.h" // WheelEventProcessingSteps
#include "SecurityContext.h"
#include "Settings.h"
#include "SharedBuffer.h"
#include "StorageSessionProvider.h"
#include "DOMWrapperWorld.h"
#include "JSDOMGlobalObject.h"
#include <JavaScriptCore/InitializeThreading.h>
#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/JSFunction.h>
#include <atomic>
#include <cmath>
#include <vector>
#include <emscripten.h>
#include <emscripten/heap.h> // emscripten_get_heap_size(): total wasm linear memory (4GB ceiling gauge)
#ifdef __EMSCRIPTEN_PTHREADS__
#include <emscripten/proxying.h>
#endif
#include <emscripten/threading.h>
#include <pal/SessionID.h>
#include <wtf/JSONValues.h>
#include <wtf/MainThread.h>
#include <wtf/Assertions.h> // WTFLogAlways — perf-log breakdown from the engine thread
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/ProcessPrivilege.h>
#include <wtf/RunLoop.h>
#include <wtf/WallTime.h>

WTF_IGNORE_WARNINGS_IN_THIRD_PARTY_CODE_BEGIN
#include <skia/core/SkCanvas.h>
#include <skia/core/SkImageInfo.h>
#include <skia/core/SkPixmap.h>
#include <skia/core/SkSurface.h>
#include <skia/gpu/ganesh/GrBackendSurface.h>
#include <skia/gpu/ganesh/GrDirectContext.h>
#include <skia/gpu/ganesh/SkSurfaceGanesh.h>
#include <skia/gpu/ganesh/gl/GrGLBackendSurface.h>
WTF_IGNORE_WARNINGS_IN_THIRD_PARTY_CODE_END

#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <utility> // std::exchange

namespace BIB {
void installEmbedderStrategies(); // EmbedderStrategies.cpp
void setRequestBlocklistEnabled(bool); // EmbedderStrategies.cpp
Ref<WebCore::StorageSessionProvider> createEmbedderStorageSessionProvider(); // EmbedderStrategies.cpp
WebCore::NetworkStorageSession& embedderStorageSession(); // EmbedderStrategies.cpp

// Persistence registries declared in BibStorage.h — engine-thread only.
HashMap<String, RefPtr<BibStorageArea>>& bibLocalAreaRegistry()
{
    static NeverDestroyed<HashMap<String, RefPtr<BibStorageArea>>> registry;
    return registry;
}
HashMap<String, HashMap<String, String>>& bibPendingStorageImport()
{
    static NeverDestroyed<HashMap<String, HashMap<String, String>>> pending;
    return pending;
}
}

#ifdef __EMSCRIPTEN_PTHREADS__
// W-B2: runtime-decided OffscreenCanvas transfer for the proxied-main
// (engine) thread. crt1_proxy_main marks its pthread_create with a
// (char*)-1 sentinel meaning "use the -sOFFSCREENCANVASES_TO_PTHREAD link
// list". We deliberately don't link that list: it is compile-time-fixed
// and a canvas missing at spawn fails pthread_create outright — node gates
// have no DOM at all, and raster mode must keep #screen page-owned for its
// 2d context. Intercept the sentinel (-Wl,--wrap=pthread_create,
// embedder.cmake) and substitute the real decision: transfer #screen only
// when the page committed to GPU mode. This also keeps the sentinel away
// from UTF8ToString((char*)-1), which the stock JS would otherwise hit
// with no link list configured.
//
// Runs on the SPAWNING thread — the page main thread for proxied main, so
// EM_ASM reads the page Module directly (node: bibGPU undefined → no
// transfer). All other pthread_creates (thread pool, WTF threads) carry a
// null/zero canvas list and pass through untouched.
extern "C" int __real_pthread_create(pthread_t*, const pthread_attr_t*, void* (*)(void*), void*);
extern "C" int __wrap_pthread_create(pthread_t* thread, const pthread_attr_t* attr, void* (*startRoutine)(void*), void* arg)
{
    if (attr) {
        const char* canvases = nullptr;
        emscripten_pthread_attr_gettransferredcanvases(attr, &canvases);
        if (canvases == reinterpret_cast<const char*>(-1)) {
            // W-B2 v2 (commit-starvation fix): NEVER transfer #screen. The old
            // path transferred #screen to this engine thread as an
            // OffscreenCanvas and presented through its placeholder — but the
            // placeholder commit is starved under PROXY_TO_PTHREAD (engine
            // paints ~47fps, screen saw ~0.2fps). GPU now renders into a
            // worker-PRIVATE OffscreenCanvas (registered as "#bibgpu" at GPU
            // boot) and delivers frames to the host #screen via the SAME
            // readback+putImageData path raster uses (host owns #screen's 2d
            // context). So the transfer list is always empty; the sentinel is
            // just neutralized (keeps it away from UTF8ToString((char*)-1)).
            pthread_attr_t patched = *attr;
            emscripten_pthread_attr_settransferredcanvases(&patched, "");
            return __real_pthread_create(thread, &patched, startRoutine, arg);
        }
    }
    return __real_pthread_create(thread, attr, startRoutine, arg);
}
#endif

// Boot defaults. The RUNTIME framebuffer size lives in g_fbWidth/g_fbHeight
// (browsception 1.3: bib_set_viewport resizes the raster path; GPU-mode
// surfaces stay at the boot size — resize there is unsupported).
static constexpr int kWidth = 800;
static constexpr int kHeight = 600;
static int g_fbWidth = kWidth;   // device px
static int g_fbHeight = kHeight; // device px
static double g_dpr = 1.0;       // logical px = device px / g_dpr

static const char* kTestHTML =
    "<!DOCTYPE html>"
    "<html><head><title>gate</title></head>"
    "<body style='background:#ffffff; margin:0'>"
    "<h1 style='color:#cc0000; font-size:48px; margin:20px'>hello</h1>"
    "<div style='width:200px; height:100px; background:#0066cc'></div>"
    "</body></html>";

// Engine state outlives main() in interactive mode. Intentionally leaked:
// destruction order of WebCore globals at process exit is not a supported
// path in this embedder, and in gate mode the process exits anyway.
struct Engine {
    RefPtr<WebCore::Page> page;
    RefPtr<WebCore::LocalFrame> mainFrame;
    sk_sp<SkSurface> surface;
};
static Engine* g_engine;

// The main frame's CURRENT view. Never cache a LocalFrameView: every
// committed navigation replaces it (BibFrameLoaderClient::
// transitionToCommittedForNewPage), so a stored pointer would be the boot
// view forever — painting a detached view renders nothing.
static WebCore::LocalFrameView* mainFrameView()
{
    return g_engine ? g_engine->mainFrame->view() : nullptr;
}

// bib_render() hands this buffer to JS. Unpremultiplied RGBA as ImageData
// expects; for this engine's output (opaque pixels) conversion is identity.
// Heap-allocated (g_fbWidth * g_fbHeight * 4) so bib_set_viewport can
// resize it; allocated in main() before g_engine exists, reallocated only
// on the engine thread.
static uint8_t* g_blitPixels;

// What Module.bibFrame actually points the host at. bibPushFrameIfDirty
// copies the dirty band g_blitPixels -> g_presentPixels ON THE ENGINE THREAD
// before posting, so the host's async texSubImage2D never reads rows the
// engine is still mutating. Presenting g_blitPixels itself ("zero-copy",
// tearing "accepted, self-correcting") was the scroll-up duplicated-band
// glitch: the async present raced bibScrollBlit — its bottom-up row memmove
// (dy > 0) crossed the host's top-down read once per overlap, splicing the
// pre-shift frame above the crossing onto the post-shift frame below it.
// Scroll-down walks top-down like the reader, so only scrolling UP produced
// the clean duplicated band (2026-08-15, wikipedia). Same size as
// g_blitPixels, same realloc sites.
static uint8_t* g_presentPixels;

// One frame in flight: set before posting bibFrame, cleared by
// bib_present_done() (run on the main thread right after the present).
// While set, bibPushFrameIfDirty leaves damage/upload armed and skips the
// paint — the GPU bitmap path's backpressure pattern, and the guarantee
// that g_presentPixels is never written while the host may be reading it.
static std::atomic<bool> g_presentInFlight { false };

// Present buffers replaced by bib_set_viewport while a present may still be
// reading them. Freed by the push path at the next moment the flag is clear
// — only then is it certain no present references any retired buffer.
static std::vector<uint8_t*> g_retiredPresentPixels;

// The region bib_render last repainted, as {x, y, w, h} DEVICE px for the
// host's partial blit. force=1 and the first frame report the full frame.
static int g_dirtyBox[4] = { 0, 0, kWidth, kHeight };

// --- Coordinate spaces -----------------------------------------------------
// Three spaces meet here, and at dpr 1 they are numerically IDENTICAL — which
// is precisely why a mix-up survives testing (see the HiDPI tier-2 suite,
// which exists to break that symmetry):
//
//   DEVICE px   the framebuffer, the canvas backing store, and every
//               coordinate that crosses the ABI in either direction:
//               bib_set_viewport, the bibFrame dirty box, and the
//               bib_mouse_*/bib_wheel positions.
//   LOGICAL px  WebCore's world: view size, event positions, damage rects.
//               logical = device / g_dpr.
//   CSS px      the host page's own units. The viewer converts CSS -> DEVICE
//               before calling in, using the canvas backing/CSS ratio it can
//               measure; it deliberately does NOT do the device -> logical
//               step, because only we know the dpr actually in force (we
//               clamp, reject and adopt viewport requests asynchronously).
//
// Rule: convert at the ABI edge, through the three helpers below. Nothing
// else in this file should touch g_dpr — if you are writing `* g_dpr` or
// `/ g_dpr` anywhere else, you are inventing a fourth space.

// LOGICAL (view-coordinate) rect -> DEVICE px, clamped to the framebuffer.
// Identity at dpr 1.0.
static WebCore::IntRect bibDeviceRect(const WebCore::IntRect& logical)
{
    const WebCore::IntRect fbRect(0, 0, g_fbWidth, g_fbHeight);
    if (g_dpr == 1.0)
        return WebCore::intersection(logical, fbRect);
    WebCore::FloatRect scaled { logical };
    scaled.scale(g_dpr);
    return WebCore::intersection(WebCore::enclosingIntRect(scaled), fbRect);
}

// The frame in LOGICAL coordinates (what WebCore's damage/paint use).
static WebCore::IntRect bibLogicalFrameRect()
{
    if (g_dpr == 1.0)
        return { 0, 0, g_fbWidth, g_fbHeight };
    return { 0, 0, static_cast<int>(lround(g_fbWidth / g_dpr)), static_cast<int>(lround(g_fbHeight / g_dpr)) };
}

// DEVICE px point (as every input export receives) -> LOGICAL px, the space
// WebCore's EventHandler hit-tests in. Identity at dpr 1.0; without it a
// HiDPI click lands dpr times too far down and right.
static WebCore::DoublePoint bibLogicalPoint(double deviceX, double deviceY)
{
    if (g_dpr == 1.0)
        return { deviceX, deviceY };
    return { deviceX / g_dpr, deviceY / g_dpr };
}

// Skia GPU (decision-005 G2, opt-in via Module.bibGPU): the backing
// SkSurface in g_engine becomes a Ganesh TEXTURE target, paints stay
// dirty-rect-clipped, and presenting = drawing the backing texture onto a
// wrap of the canvas WebGL2 context's framebuffer 0 (GPU-GPU quad). The
// host page never sees pixels: bib_render returns null and the canvas is
// live. When the flag is unset every byte of the CPU path is unchanged.
static bool g_gpu = false;
static sk_sp<SkSurface> g_fbo0Surface; // present target, GPU mode only
// G4 (W-B2): set by the webglcontextlost handler, cleared after the Ganesh
// world is rebuilt on restore. Atomic: read by bib_render on the engine
// thread, written by canvas event handlers (same thread under pthreads —
// the OffscreenCanvas lives with the engine — but atomic keeps the
// single-threaded build's main-thread handlers honest too).
static std::atomic<bool> g_gpuLost { false };

// ?perflog=1 (read once in main, host-page URL): accumulate per-phase
// engine-thread timing and WTFLogAlways a one-line breakdown once a second.
// The whole point of this investigation is to stop GUESSING whether Discord's
// near-frozen render is a spin loop, heavy guest JS, layout, paint, or GPU
// present — this measures it. Off by default; when off it costs a handful of
// branch checks per tick. All fields are engine-thread-only (no atomics
// needed — bib_tick/bib_render run on the engine thread).
static bool g_perfLog = false;
// Rendering-update throttle. On JS-saturated pages WebCore's "update the
// rendering" pass (guest rAF/React callbacks + the style/layout they dirty)
// eats most of the engine thread (measured: 700-890ms/s on Discord) and starves
// paint -> freeze. We cap how often that pass runs. DYNAMIC by default: the cap
// is DERIVED from the measured per-pass cost (EMA) so the pass takes at most
// kRcapUpdateBudget of the thread -> heavy pages throttle (Discord ~8ms/pass ->
// ~31/s), light pages run full rate (~1ms/pass -> ~250/s = uncapped). No
// hardcoded fps. ?rcap=0 disables; ?rcap=N forces a fixed N/s (manual override).
// Deferred, not dropped: g_renderingUpdateRequested stays set until an eligible
// tick runs it.
static bool   g_rcapDynamic   = false;  // dynamic cap (default when interactive)
static double g_rcapFixedMs   = 0.0;    // >0 = fixed min-interval (manual override)
static double g_dynUpdEmaMs   = 0.0;    // EMA of updateRendering cost (ms)
static double g_dynIntervalMs = 0.0;    // derived min-interval (ms); ~0 = uncapped
static double g_lastRenderUpdateMs = 0.0;
static constexpr double kRcapUpdateBudget   = 0.33;  // updateRendering's max thread share
                                                     // (~1/3; leaves 2/3 for paint+timers.
                                                     // higher = more updates/fps, less paint
                                                     // headroom. 0.33 targets ~30/s on Discord
                                                     // where throttled passes batch to ~10ms.)
static constexpr double kRcapMaxIntervalMs  = 33.0;  // 30/s floor: never throttle below the
                                                     // empirically-good rate (rcap=30 beat 20).
                                                     // bounds the cost-inflation feedback so the
                                                     // dynamic cap floats 30-60/s, not down to a
                                                     // choppy crawl. (timer/microtask JS in
                                                     // bib_pump is a separate, un-throttled load.)
static constexpr double kRcapEmaAlpha       = 0.2;   // EMA weight for new cost samples
namespace {
struct PerfAccum {
    double windowStart = 0;  // MonotonicTime ms at window open (0 = not yet)
    double runloop = 0;      // RunLoop::cycle — guest JS, timers, microtasks
    double renderUpdate = 0; // updateRendering + finalizeRenderingUpdate (rAF/style/IO)
    double layout = 0;       // updateLayoutIgnorePendingStylesheets
    double paint = 0;        // paintFrameRect loop + CPU readback
    double present = 0;      // presentGPU (GPU mode only)
    double pushTotal = 0;    // whole bibPushFrameIfDirty (render + memcpy + dispatch)
    double persist = 0;      // bibMaybePersist
    int ticks = 0;           // bib_tick bodies run this window
    int painted = 0;         // frames that actually painted >=1 rect
    // #77 burst-shape probe: bib_pump RunLoop::cycle costs. These run
    // OUTSIDE bib_tick (no paint), so their total ~= the page-side
    // "pumpGap". max/count tell us the SHAPE: one giant cycle (max~=total ->
    // pacing between pumps useless, need mid-cycle break) vs many small cycles
    // (max<<total -> interleaving a paint per N pumps works).
    double pumpCycle = 0;    // sum of bib_pump RunLoop::cycle ms
    double pumpMax = 0;      // largest single bib_pump cycle ms (the decider)
    int pumps = 0;           // bib_pump cycles this window
    // Scroll-path probe (2026-08-13, notes/perf-measurement.md § BIBPERF):
    // wheel handling runs as a PROXIED TASK, i.e. OUTSIDE bib_tick, so none of
    // it showed up in busy% before. wheelMs = engine-thread time inside
    // handleWheelEvent (WebCore scroll machinery + bibScrollBlit); blitMs =
    // bibScrollBlit, split into its two mirrors (blitMoveMs = the g_blitPixels
    // memmove, blitWriteMs = the surface mirror); blitRows = device rows
    // shifted, per mirror; queueMax = deepest wheel-batch backlog seen (~1-2
    // now that batches merge; it was the pre-2026-08-14 pile-up gauge).
    double wheelMs = 0;
    int wheels = 0;
    int wheelEvents = 0;     // host wheel events those applied events carry (>= wheels once merging bites)
    double blitMs = 0;
    double blitMoveMs = 0;   // the single wrapped-surface row walk
    double blitWriteMs = 0;  // unused since the surface wraps g_blitPixels (kept in the log format)
    int blits = 0;
    double blitRows = 0;
    int blitFallbacks = 0;
    int queueMax = 0;
    // What paint actually covered (2026-08-14, the sticky-damage hunt):
    // rects painted and their device-px area. area/painted ≈ full frame ⇒
    // damage is degenerating to full-viewport repaints regardless of what
    // the blit saved.
    int paintRects = 0;
    double paintAreaPx = 0;
};
PerfAccum g_perf;
}
static inline double bibNowMs() { return MonotonicTime::now().secondsSinceEpoch().milliseconds(); }

// W-B2 v2: there is no presentGPU() anymore. GPU frames are NOT presented
// through the (starved) OffscreenCanvas placeholder; instead bib_render reads
// the painted Ganesh surface back to CPU and the host puts it on #screen via
// Module.bibBlit (same path as raster). g_fbo0Surface is retained only for the
// boot software-detection bench (it draws+flushes there directly).

// Dump RGBA pixels as a binary PPM (P6, alpha dropped) into the wasm FS.
// The node runner extracts it afterwards.
static bool writePPM(const char* path, const SkPixmap& pixmap)
{
    FILE* f = fopen(path, "wb");
    if (!f)
        return false;
    bool ok = fprintf(f, "P6\n%d %d\n255\n", pixmap.width(), pixmap.height()) > 0;
    for (int y = 0; ok && y < pixmap.height(); ++y) {
        const uint8_t* row = static_cast<const uint8_t*>(pixmap.addr(0, y));
        for (int x = 0; x < pixmap.width(); ++x) {
            // kRGBA_8888 byte order is R,G,B,A regardless of endianness.
            if (fwrite(row + x * 4, 1, 3, f) != 3) {
                ok = false;
                break;
            }
        }
    }
    ok = ok && !ferror(f);
    if (fclose(f) != 0)
        ok = false;
    return ok;
}

// True while view->paint runs (paintFrameRect). A scroll callback arriving
// MID-PAINT would shift pixels under the painter and slip past the frame's
// snapshotted upload box — bibScrollBlit falls back to plain damage instead
// (Codex hypothesis, 2026-06-11).
static bool g_inPaint = false;

// Paint ONLY `dirty` (root-view coords, pre-clamped to the frame, layout
// already up to date — see bib_render) into the persistent surface. Pixels
// outside the clip keep the previous frame's content. In raster mode the
// surface wraps g_blitPixels, so painting IS filling the framebuffer.
// drawColor, NOT clear(): SkCanvas::clear ignores the clip.
static bool paintFrameRect(const WebCore::IntRect& dirty)
{
    RefPtr view = mainFrameView();
    if (!view)
        return false;
    SkCanvas* canvas = g_engine->surface->getCanvas();
    canvas->save();
    // `dirty` is logical; the surface is device px. Clip in device space,
    // then scale so WebCore paints logical coordinates (no-op at dpr 1).
    const WebCore::IntRect deviceClip = bibDeviceRect(dirty);
    canvas->clipRect(SkRect::MakeXYWH(deviceClip.x(), deviceClip.y(), deviceClip.width(), deviceClip.height()));
    canvas->drawColor(SK_ColorWHITE);
    // At fractional dpr the enclosing device clip's edge rows straddle a
    // logical-pixel boundary: they need content from the NEIGHBORING logical
    // row too, which view->paint would cull against a bare `dirty` — leaving
    // partial paints a hair off a full paint (AA hairlines at damage edges).
    // Cull 1 logical px wider; the device clip still bounds the pixels.
    WebCore::IntRect cullRect = dirty;
    if (g_dpr != 1.0) {
        canvas->scale(g_dpr, g_dpr);
        cullRect.inflate(1);
        cullRect.intersect(bibLogicalFrameRect());
    }
    // Accelerated mode only changes texture-backed-image handling (no raster
    // copies for shadows) — Canvas-purpose GL gymnastics stay off either way.
    WebCore::GraphicsContextSkia context(*canvas,
        g_gpu ? WebCore::RenderingMode::Accelerated : WebCore::RenderingMode::Unaccelerated,
        WebCore::RenderingPurpose::Unspecified);
    g_inPaint = true;
    BIB::g_damagePhase = "paint";
    view->paint(context, cullRect);
    BIB::g_damagePhase = "idle";
    g_inPaint = false;
    canvas->restore();
    return true;
}

// Callers snapshot-and-clear the dirty state BEFORE painting: damage
// reported DURING view->paint (paint-triggered invalidations) must
// accumulate for the NEXT frame, not be wiped post-paint (Codex 2026-06-11).
static void clearDamage()
{
    BIB::g_frameDirty = false;
    BIB::g_damageCount = 0;
    BIB::g_uploadRect = { };
}

// Snap-to-device-pixel scroll state (dpr != 1): the blit shifts by the
// INTEGER device delta nearest to delta*dpr; the residual (applied − true
// shift, device px, |r| <= 0.5 by construction) carries into the next blit
// so error never accumulates. Any blit under a nonzero residual leaves its
// strip within half a device pixel of truth — and it STAYS off even if the
// residual later returns to exactly 0, so the settle flag LATCHES until
// bib_tick schedules one full repaint after scrolling goes quiet
// (kScrollSettleMs). Integer dpr never produces a residual (delta*dpr is
// exact): no settle repaints, no misalignment. Engine-thread-only.
static double g_scrollResidX = 0.0;
static double g_scrollResidY = 0.0;
static bool g_scrollSnapDirty = false;
static double g_lastScrollBlitMs = 0.0;
static constexpr double kScrollSettleMs = 200.0;

// Fast-scroll blit (ChromeClient::scroll): shift the already-painted pixels
// by `delta` within the scrolled clip. The raster surface wraps g_blitPixels,
// so one row walk moves both "views" of the frame at once. WebCore then only
// repaints the strips the shift exposed; the host re-uploads the whole moved
// region via g_uploadRect.
// Incoming delta/rects are LOGICAL; the pixel shift happens in DEVICE px
// (snapped, see above). Damage bookkeeping stays logical, inflated by 1
// logical px at dpr != 1 so snap misalignment repaints a hair extra rather
// than smearing.
static void bibScrollBlitImpl(const WebCore::IntSize&, const WebCore::IntRect&, const WebCore::IntRect&);
static void bibScrollBlit(const WebCore::IntSize& delta, const WebCore::IntRect& rectToScroll, const WebCore::IntRect& clipRect)
{
    if (!g_perfLog) {
        bibScrollBlitImpl(delta, rectToScroll, clipRect);
        return;
    }
    const double t0 = bibNowMs();
    const double rows0 = g_perf.blitRows;
    bibScrollBlitImpl(delta, rectToScroll, clipRect);
    g_perf.blitMs += bibNowMs() - t0;
    g_perf.blits++;
    if (g_perf.blitRows == rows0)
        g_perf.blitFallbacks++; // bailed to a plain repaint, no pixels reused
}
static void bibScrollBlitImpl(const WebCore::IntSize& delta, const WebCore::IntRect& rectToScroll, const WebCore::IntRect& clipRect)
{
    WebCore::IntRect scrollRect = WebCore::intersection(WebCore::intersection(rectToScroll, clipRect), bibLogicalFrameRect());
    if (!g_engine || g_inPaint || scrollRect.isEmpty()) {
        BIB::addDamage(clipRect);
        return;
    }
    const int dx = delta.width(), dy = delta.height();
    // Snap the device shift to whole pixels, carrying the sub-pixel
    // remainder: n = round(exact − residual) keeps |residual| <= 0.5 across
    // any run of blits. At dpr 1 (or any integer dpr) this is exact.
    int ndx = dx, ndy = dy;
    if (g_dpr != 1.0) {
        const double ex = dx * g_dpr - g_scrollResidX;
        const double ey = dy * g_dpr - g_scrollResidY;
        ndx = static_cast<int>(lround(ex));
        ndy = static_cast<int>(lround(ey));
        g_scrollResidX = ndx - ex;
        g_scrollResidY = ndy - ey;
        if (g_scrollResidX != 0.0 || g_scrollResidY != 0.0)
            g_scrollSnapDirty = true;
        g_lastScrollBlitMs = bibNowMs();
        if (!ndx && !ndy) {
            // Net movement under one device pixel (dpr < 1): nothing to
            // shift; repaint the region at truth and drop the residual.
            g_scrollResidX = g_scrollResidY = 0.0;
            BIB::addDamage(scrollRect);
            return;
        }
    }
    const WebCore::IntRect devScroll = bibDeviceRect(scrollRect);
    WebCore::IntRect devDst = devScroll;
    devDst.move(ndx, ndy);
    devDst.intersect(devScroll);
    if (devScroll.isEmpty() || devDst.isEmpty()) { // shifted clean out of the clip — nothing reusable
        g_scrollResidX = g_scrollResidY = 0.0;
        BIB::addDamage(scrollRect);
        return;
    }
    WebCore::IntRect devSrc = devDst;
    devSrc.move(-ndx, -ndy);
    // Logical mirror of the reusable region, for the damage bookkeeping.
    WebCore::IntRect dst = scrollRect;
    dst.move(dx, dy);
    dst.intersect(scrollRect);
    // At dpr != 1 the snapped device shift can differ from a rect's logical
    // translation by up to a device pixel — ALONG THE SCROLLED AXIS ONLY
    // (the other axis doesn't move). Inflate damage by 1 logical px on just
    // that axis: extra repaint beats a stale sliver, and axis-only keeps the
    // strip from touching the scrollbar's damage column (addDamage merges
    // intersecting rects — a both-axes inflate united strip + scrollbar into
    // a frame-covering rect, re-triggering full repaints; 2026-08-11).
    auto snapInflate = [dx, dy](WebCore::IntRect& r) {
        if (g_dpr == 1.0)
            return;
        if (dx)
            r.inflateX(1);
        if (dy)
            r.inflateY(1);
    };

    // Pending unpainted damage: WebCore invalidates scrollbars/content
    // BEFORE calling ChromeClient::scroll, so bailing out here tripped on
    // EVERY scroll tick and kept blit-shift dormant (2026-06-11 scroll
    // probe: 40/40 full-viewport repaints). Damage tracks the content it
    // marks — translate the part inside the scrolled clip by the delta
    // (the Windows port offsets its backing-store dirty region the same
    // way). Stale pixels can only land where the shift writes (dst);
    // damage shifted beyond dst is overwritten or clipped away with them.
    // Fixed/sticky elements are NOT a smear hazard: scrollContentsFastPath
    // invalidates their old+new rects AFTER this callback returns.
    if (BIB::g_frameDirty) {
        // A pending rect covering the whole scroll region means the blit
        // preserves nothing worth keeping.
        for (size_t i = 0; i < BIB::g_damageCount; ++i) {
            if (BIB::g_damageRects[i].contains(scrollRect)) {
                if (g_perfLog)
                    WTFLogAlways("BIBSCROLL fallback: pending damage %d,%d %dx%d contains scrollRect",
                        BIB::g_damageRects[i].x(), BIB::g_damageRects[i].y(),
                        BIB::g_damageRects[i].width(), BIB::g_damageRects[i].height());
                g_scrollResidX = g_scrollResidY = 0.0;
                BIB::addDamage(scrollRect);
                return;
            }
        }
        // Per rect: damage outside the clip stays put; damage straddling
        // the clip edge stays in place in FULL and gains a translated copy
        // (repaints a little extra, never smears); fully-inside damage
        // rides the scroll. Translated copies clip to dst — stale pixels
        // can only land where the shift writes. Copies and clip get the
        // snap inflation (see snapInflate above).
        WebCore::IntRect dstClip = dst;
        snapInflate(dstClip);
        WebCore::IntRect pending[BIB::kMaxDamageRects * 2];
        size_t pendingCount = 0;
        for (size_t i = 0; i < BIB::g_damageCount; ++i) {
            const WebCore::IntRect r = BIB::g_damageRects[i];
            WebCore::IntRect moving = WebCore::intersection(r, scrollRect);
            if (moving.isEmpty()) {
                pending[pendingCount++] = r;
                continue;
            }
            if (moving != r)
                pending[pendingCount++] = r;
            moving.move(dx, dy);
            snapInflate(moving);
            moving.intersect(dstClip);
            if (!moving.isEmpty())
                pending[pendingCount++] = moving;
        }
        BIB::g_damageCount = 0;
        BIB::g_frameDirty = false;
        for (size_t i = 0; i < pendingCount; ++i)
            BIB::addDamage(pending[i]); // re-merges + re-arms g_frameDirty
    }

    // Overlap-safe row walk (memmove handles x overlap), done once per
    // mirror. devDst/devSrc/ndx/ndy: everything here is DEVICE px.
    const size_t rowBytes = static_cast<size_t>(devDst.width()) * 4;
    auto shiftRows = [&](uint8_t* base, size_t stride) {
        if (ndy > 0) {
            for (int y = devDst.height() - 1; y >= 0; --y)
                memmove(base + (devDst.y() + y) * stride + static_cast<size_t>(devDst.x()) * 4,
                    base + (devSrc.y() + y) * stride + static_cast<size_t>(devSrc.x()) * 4, rowBytes);
        } else {
            for (int y = 0; y < devDst.height(); ++y)
                memmove(base + (devDst.y() + y) * stride + static_cast<size_t>(devDst.x()) * 4,
                    base + (devSrc.y() + y) * stride + static_cast<size_t>(devSrc.x()) * 4, rowBytes);
        }
    };
    // ONE walk: the raster surface wraps g_blitPixels (boot), so shifting the
    // surface's own pixels IS shifting the framebuffer — there is no second
    // mirror anymore. notifyContentWillChange first — writing through
    // peekPixels bypasses Skia's snapshot handshake, so the surface has to
    // be told. (History: this used to be two walks over two buffers, and
    // before that a writePixels whose unpremul→premul conversion cost ~9x
    // the memmove — 13 ms vs 1.4 ms at 5.6 Mpx.)
    const double _moveT0 = g_perfLog ? bibNowMs() : 0;
    SkPixmap surfacePixels;
    g_engine->surface->notifyContentWillChange(SkSurface::kRetain_ContentChangeMode);
    if (!g_engine->surface->peekPixels(&surfacePixels) || surfacePixels.writable_addr() != g_blitPixels) {
        // No direct pixel access, or the surface stopped wrapping the
        // framebuffer (can't happen for the wrapped raster surface). Repaint
        // the whole frame rather than failing silently.
        g_scrollResidX = g_scrollResidY = 0.0;
        BIB::addDamage(bibLogicalFrameRect());
        return;
    }
    if (g_perfLog)
        g_perf.blitRows += devDst.height();
    shiftRows(static_cast<uint8_t*>(surfacePixels.writable_addr()), surfacePixels.rowBytes());
    if (g_perfLog)
        g_perf.blitMoveMs += bibNowMs() - _moveT0;
    // Host re-uploads everything that moved…
    BIB::g_uploadRect.unite(scrollRect);
    // …WebCore repaints only the exposed strips (scrollRect minus dst): a
    // horizontal band (top or bottom) and/or a vertical band (left/right).
    // Strips get the snap inflation too (addDamage merges; bib_render clamps
    // to the frame).
    auto exposeDamage = [&snapInflate](WebCore::IntRect r) {
        snapInflate(r);
        BIB::addDamage(r);
    };
    if (dy > 0)
        exposeDamage({ scrollRect.x(), scrollRect.y(), scrollRect.width(), dy });
    else if (dy < 0)
        exposeDamage({ scrollRect.x(), scrollRect.maxY() + dy, scrollRect.width(), -dy });
    if (dx > 0)
        exposeDamage({ scrollRect.x(), scrollRect.y(), dx, scrollRect.height() });
    else if (dx < 0)
        exposeDamage({ scrollRect.maxX() + dx, scrollRect.y(), -dx, scrollRect.height() });
}

// Layout + paint the FULL frame (boot/gate path; bib_render drives the
// dirty-rect path itself so it can snapshot damage after layout).
static bool paintFrame()
{
    if (!mainFrameView())
        return false;
    g_engine->mainFrame->protectedDocument()->updateLayoutIgnorePendingStylesheets();
    clearDamage();
    return paintFrameRect(bibLogicalFrameRect());
}

static OptionSet<WebCore::PlatformEvent::Modifier> modifiersFromBits(int bits)
{
    OptionSet<WebCore::PlatformEvent::Modifier> modifiers;
    if (bits & 1)
        modifiers.add(WebCore::PlatformEvent::Modifier::ShiftKey);
    if (bits & 2)
        modifiers.add(WebCore::PlatformEvent::Modifier::ControlKey);
    if (bits & 4)
        modifiers.add(WebCore::PlatformEvent::Modifier::AltKey);
    if (bits & 8)
        modifiers.add(WebCore::PlatformEvent::Modifier::MetaKey);
    return modifiers;
}

// ---------------------------------------------------------------------------
// W-B1 cross-thread entry marshaling. Under -sPROXY_TO_PTHREAD, main() (and
// all of WebCore/JSC) runs on a dedicated pthread, but the host page still
// calls the bib_* exports from the BROWSER MAIN THREAD — a direct call there
// would race the engine. Every export below self-proxies: called on the
// wrong thread, it queues itself onto the engine thread via the emscripten
// system proxying queue (processed whenever the engine pthread returns to
// its event loop — which the event-driven pump guarantees) and returns.
// High-frequency cadence entries (tick/pump) collapse bursts through an
// atomic pending flag so a pegged engine never accumulates a task backlog.

static pthread_t g_engineThread;
static std::atomic<bool> g_engineThreadReady { false };

static bool bibOnEngineThread()
{
    return g_engineThreadReady.load(std::memory_order_acquire)
        && pthread_equal(pthread_self(), g_engineThread);
}

// Queue a task onto the engine thread; drops silently pre-main() (matches
// the !g_engine early-outs every entry point already has).
// BIB_PTHREAD=OFF build: there is only one thread, so after main() runs
// every caller IS the engine thread (bibOnEngineThread() true — emscripten
// stubs pthread_self/pthread_equal) and this path is unreachable; before
// main() it returns false, matching the pthread build's pre-ready drop.
//
// Positional-input coalescing (§ Input forwarding): a queued wheel/mouse-move
// task stays OPEN for merging until something else is posted behind it.
// Sealing here — the one place every cross-thread task goes through — is what
// keeps order: an event that arrives after a click, a key, or a tick can never
// be merged into a batch that runs before them.
static void bibRunWheel(void*);
static void bibRunMouseMove(void*);
static void bibSealPendingInput(void (*posted)(void*));

static bool bibProxyToEngine(void (*task)(void*), void* arg)
{
#ifdef __EMSCRIPTEN_PTHREADS__
    if (!g_engineThreadReady.load(std::memory_order_acquire))
        return false;
    bibSealPendingInput(task);
    return emscripten_proxy_async(emscripten_proxy_get_system_queue(), g_engineThread, task, arg);
#else
    (void)task;
    (void)arg;
    return false;
#endif
}

// Shared with BibMediaPlayer.cpp's bib_media_event export (BibMediaPlayer.h).
namespace BIB {
bool onEngineThread() { return bibOnEngineThread(); }
bool proxyToEngine(void (*task)(void*), void* arg) { return bibProxyToEngine(task, arg); }
}

// ---------------------------------------------------------------------------
// Engine-state persistence: cookies + guest localStorage round-trip through
// the host page's OPFS (web/browser.html). Seed: main() reads
// Module.bibSeedState (one JSON blob) before the first load — cookies go
// straight into the CookieJarDB, localStorage waits in
// bibPendingStorageImport() until each origin's area materializes
// (BibStorage.h). Dump: bib_tick re-serializes every ~5s and pushes to
// Module.bibPersist ONLY when the blob changed (string compare — there is
// no write hook on the cookie jar, so polling is the change detector).
// Everything here runs on the engine thread.

static String bibBuildPersistJSON()
{
    auto root = JSON::Object::create();
    root->setInteger("v"_s, 1);

    auto cookies = JSON::Array::create();
    for (auto& cookie : BIB::embedderStorageSession().cookieDatabase().getAllCookies()) {
        auto c = JSON::Object::create();
        c->setString("name"_s, cookie.name);
        c->setString("value"_s, cookie.value);
        c->setString("domain"_s, cookie.domain);
        c->setString("path"_s, cookie.path);
        if (cookie.expires)
            c->setDouble("expires"_s, *cookie.expires); // ms since epoch
        c->setBoolean("httpOnly"_s, cookie.httpOnly);
        c->setBoolean("secure"_s, cookie.secure);
        c->setBoolean("session"_s, cookie.session);
        cookies->pushObject(WTF::move(c));
    }
    root->setArray("cookies"_s, WTF::move(cookies));

    auto storage = JSON::Object::create();
    for (auto& [origin, area] : BIB::bibLocalAreaRegistry()) {
        auto items = JSON::Object::create();
        area->forEachItem([&](const String& key, const String& value) {
            items->setString(key, value);
        });
        storage->setObject(origin, WTF::move(items));
    }
    // Origins seeded from a previous session that the guest has not opened
    // yet THIS session still live in the pending map — dropping them here
    // would erase a prior session's data just by not visiting the site.
    for (auto& [origin, pendingItems] : BIB::bibPendingStorageImport()) {
        if (BIB::bibLocalAreaRegistry().contains(origin))
            continue;
        auto items = JSON::Object::create();
        for (auto& [key, value] : pendingItems)
            items->setString(key, value);
        storage->setObject(origin, WTF::move(items));
    }
    root->setObject("localStorage"_s, WTF::move(storage));
    return root->toJSONString();
}

static void bibSeedPersistedState(const String& json)
{
    auto value = JSON::Value::parseJSON(json);
    auto root = value ? value->asObject() : nullptr;
    if (!root) {
        printf("EMBEDDER: persist seed unreadable — starting fresh\n");
        return;
    }

    int cookieCount = 0;
    if (auto cookieArray = root->getArray("cookies"_s)) {
        auto& jar = BIB::embedderStorageSession().cookieDatabase();
        double nowMs = WallTime::now().secondsSinceEpoch().milliseconds();
        for (auto& entry : *cookieArray) {
            auto c = entry->asObject();
            if (!c)
                continue;
            WebCore::Cookie cookie;
            cookie.name = c->getString("name"_s);
            cookie.value = c->getString("value"_s);
            cookie.domain = c->getString("domain"_s);
            cookie.path = c->getString("path"_s);
            cookie.expires = c->getDouble("expires"_s);
            cookie.httpOnly = c->getBoolean("httpOnly"_s).value_or(false);
            cookie.secure = c->getBoolean("secure"_s).value_or(false);
            cookie.session = c->getBoolean("session"_s).value_or(false);
            if (cookie.name.isEmpty() && cookie.value.isEmpty())
                continue;
            if (!cookie.session && cookie.expires && *cookie.expires <= nowMs)
                continue; // expired while we were away
            if (jar.setCookie(cookie))
                cookieCount++;
        }
    }

    int originCount = 0;
    if (auto storage = root->getObject("localStorage"_s)) {
        for (auto& member : *storage) {
            auto items = member.value->asObject();
            if (!items)
                continue;
            HashMap<String, String> map;
            for (auto& item : *items) {
                String itemValue;
                if (item.value->asString(itemValue))
                    map.set(item.key, itemValue);
            }
            BIB::bibPendingStorageImport().set(member.key, WTF::move(map));
            originCount++;
        }
    }
    printf("EMBEDDER: persist seed: %d cookies, %d localStorage origins\n", cookieCount, originCount);
}

static void bibMaybePersist(bool force)
{
    static NeverDestroyed<String> lastJSON;
    static MonotonicTime lastCheck;
    static bool oversizeWarned = false;

    if (!g_engine)
        return;
    auto now = MonotonicTime::now();
    if (!force && now - lastCheck < Seconds(5))
        return;
    lastCheck = now;

    String json = bibBuildPersistJSON();
    if (json == lastJSON.get())
        return;
    CString utf8 = json.utf8();
    // localStorage quota (5MB/origin) keeps real blobs far below this; the
    // cap only guards the cross-heap string copy from pathological growth.
    if (utf8.length() > 12 * 1024 * 1024) {
        if (!std::exchange(oversizeWarned, true))
            printf("EMBEDDER: persist blob over 12MB — persistence paused\n");
        return;
    }
    lastJSON.get() = json;

    char* copy = static_cast<char*>(malloc(utf8.length() + 1));
    if (!copy)
        return;
    memcpy(copy, utf8.data(), utf8.length() + 1);
    // Same protocol as bibPushFrameIfDirty: malloc'd payload crosses to the
    // main thread, which reads it out of the (possibly grown) shared heap
    // and frees it via the exported _bib_wasm_free.
    // Module guard: pagehide nulls window.Module while a queued push may
    // still be in flight — free-then-drop is the correct outcome there.
    MAIN_THREAD_ASYNC_EM_ASM({
        if (typeof growMemViews === "function")
            growMemViews();
        var json = UTF8ToString($0);
        _bib_wasm_free($0);
        if (typeof Module !== "undefined" && Module && Module.bibPersist)
            Module.bibPersist(json);
    }, copy);
}

extern "C" {

EMSCRIPTEN_KEEPALIVE int bib_frame_width() { return g_fbWidth; }
EMSCRIPTEN_KEEPALIVE int bib_frame_height() { return g_fbHeight; }

// browsception 1.3 (ABI bib_set_viewport): resize the raster framebuffer +
// frame view. Device pixels in; the view is resized to logical px
// (device / dpr; dpr 1.0 is the tested path). GPU mode: surfaces are
// boot-sized (FBO 0 wrap, OffscreenCanvas) — unsupported, log-once + ignore.
struct BibViewportTask {
    int width;
    int height;
    double dpr;
};
static void bibRunSetViewport(void*);
EMSCRIPTEN_KEEPALIVE void bib_set_viewport(int widthPx, int heightPx, double dpr)
{
    if (!bibOnEngineThread()) {
        auto* task = new BibViewportTask { widthPx, heightPx, dpr };
        if (!bibProxyToEngine(bibRunSetViewport, task))
            delete task;
        return;
    }
    if (!g_engine)
        return;
    if (g_gpu) {
        static bool warnedOnce = false;
        if (!warnedOnce) {
            WTFLogAlways("BIB: bib_set_viewport is unsupported in GPU mode — ignored");
            warnedOnce = true;
        }
        return;
    }
    if (widthPx < 1 || heightPx < 1 || widthPx > 8192 || heightPx > 8192
        || !(dpr >= 0.25) || !(dpr <= 8.0))
        return;
    if (widthPx == g_fbWidth && heightPx == g_fbHeight && dpr == g_dpr)
        return;
    // Allocate the new set first so failure keeps the old, consistent state.
    // The surface wraps the framebuffer (see boot: paint lands in
    // g_blitPixels directly, no readback).
    uint8_t* pixels = static_cast<uint8_t*>(malloc(static_cast<size_t>(widthPx) * heightPx * 4));
    uint8_t* presentPixels = static_cast<uint8_t*>(malloc(static_cast<size_t>(widthPx) * heightPx * 4));
    auto info = SkImageInfo::Make(widthPx, heightPx, kRGBA_8888_SkColorType, kPremul_SkAlphaType);
    sk_sp<SkSurface> surface = pixels
        ? SkSurfaces::WrapPixels(info, pixels, static_cast<size_t>(widthPx) * 4)
        : nullptr;
    if (!pixels || !presentPixels || !surface) {
        WTFLogAlways("BIB: bib_set_viewport %dx%d allocation failed — keeping %dx%d",
            widthPx, heightPx, g_fbWidth, g_fbHeight);
        free(pixels);
        free(presentPixels);
        return;
    }
    free(g_blitPixels);
    g_blitPixels = pixels;
    // An in-flight present may still point the host at the OLD present
    // buffer; freeing it now would hand that upload freed heap. Retire it
    // instead — the push path frees retirees once nothing is in flight.
    g_retiredPresentPixels.push_back(g_presentPixels);
    g_presentPixels = presentPixels;
    g_engine->surface = WTF::move(surface);
    g_fbWidth = widthPx;
    g_fbHeight = heightPx;
    if (g_dpr != dpr) {
        g_dpr = dpr;
        g_engine->page->setDeviceScaleFactor(static_cast<float>(dpr));
    }
    if (RefPtr view = mainFrameView()) {
        const WebCore::IntRect logical = bibLogicalFrameRect();
        view->resize(logical.width(), logical.height());
    }
    BIB::g_logicalFrameSize = bibLogicalFrameRect().size();
    // Everything is stale: arm a full-frame repaint; the next tick pushes a
    // complete frame at the new size (bibFrame carries fbW/fbH, from which
    // the host resizes its canvas).
    g_scrollResidX = g_scrollResidY = 0.0;
    clearDamage();
    g_dirtyBox[0] = 0;
    g_dirtyBox[1] = 0;
    g_dirtyBox[2] = g_fbWidth;
    g_dirtyBox[3] = g_fbHeight;
    BIB::addDamage(bibLogicalFrameRect());
}
static void bibRunSetViewport(void* p)
{
    auto* task = static_cast<BibViewportTask*>(p);
    bib_set_viewport(task->width, task->height, task->dpr);
    delete task;
}

// W-B1 push-model rendering: defined after bib_render (which it drives).
static void bibPushFrameIfDirty();

// One non-blocking engine-RunLoop iteration: fires due WebCore timers and
// dispatched main-thread functions (DOM timers, RenderingUpdateScheduler's
// fallback timer, caret blink). Drive from requestAnimationFrame.
// (RunMode::Iterate never sleeps — RunLoopGeneric's Drain-only waitUntil.)
// W-B1: the host rAF still calls this for CADENCE, but the body runs on the
// engine thread; the frame (if any) is PUSHED back via Module.bibBlit.
static std::atomic<bool> g_tickQueued { false };
static void bibRunTick(void*);
EMSCRIPTEN_KEEPALIVE void bib_tick()
{
    if (!bibOnEngineThread()) {
        if (g_tickQueued.exchange(true, std::memory_order_acq_rel))
            return; // one tick already pending — collapse the burst
        if (!bibProxyToEngine(bibRunTick, nullptr))
            g_tickQueued.store(false, std::memory_order_release);
        return;
    }
    const double _perfT0 = g_perfLog ? bibNowMs() : 0;
    BIB::g_damagePhase = "runloop";
    WTF::RunLoop::cycle();
    BIB::g_damagePhase = "idle";
    const double _perfT1 = g_perfLog ? bibNowMs() : 0;
    // Drive WebCore's "update the rendering" steps. This port has no
    // DisplayRefreshMonitor, so nothing else ever runs them — guest
    // requestAnimationFrame callbacks NEVER fired (root cause #16), which
    // silently stalled everything rAF-shaped: CSS/JS animations,
    // IntersectionObserver delivery, and rAF-deferred commits (react-helmet
    // batches <script> head insertions through rAF — 2captcha's reCAPTCHA
    // loader died exactly there). Gated on WebCore actually requesting an
    // update (BibChromeClient::scheduleRenderingUpdate sets the flag and
    // returns true, which also suppresses RenderingUpdateScheduler's
    // fallback timer): one pass per request, max one per host frame, zero
    // on idle pages.
    if (g_engine && BIB::g_renderingUpdateRequested) {
        // Throttle the rendering-update pass (see g_rcapDynamic). Interval is
        // fixed (manual ?rcap=N) or DERIVED from the EMA of the pass cost so it
        // stays <= kRcapUpdateBudget of the thread. Deferred, not dropped: the
        // flag stays set so a later eligible tick runs it. Uncapped (rcap=0 /
        // non-interactive): throttling=false -> equivalent to the old exchange().
        const bool throttling = g_rcapDynamic || g_rcapFixedMs > 0.0;
        bool runNow = true;
        double now = 0.0;
        if (throttling) {
            now = bibNowMs();
            const double interval = g_rcapFixedMs > 0.0 ? g_rcapFixedMs : g_dynIntervalMs;
            if (interval > 0.0 && now - g_lastRenderUpdateMs < interval)
                runNow = false;
        }
        if (runNow) {
            BIB::g_renderingUpdateRequested = false;
            BIB::g_damagePhase = "renderUpd";
            g_engine->page->updateRendering();
            g_engine->page->finalizeRenderingUpdate({ });
            BIB::g_damagePhase = "idle";
            if (throttling) {
                g_lastRenderUpdateMs = now; // start-to-start spacing
                if (g_rcapDynamic) {
                    // Re-derive the cap from this pass's cost: keep
                    // updateRendering <= kRcapUpdateBudget of the thread.
                    const double cost = bibNowMs() - now;
                    g_dynUpdEmaMs = g_dynUpdEmaMs > 0.0
                        ? g_dynUpdEmaMs * (1.0 - kRcapEmaAlpha) + cost * kRcapEmaAlpha
                        : cost;
                    const double iv = g_dynUpdEmaMs / kRcapUpdateBudget;
                    g_dynIntervalMs = iv > kRcapMaxIntervalMs ? kRcapMaxIntervalMs : iv;
                }
            }
        }
    }
    // Snap-scroll settle: fractional-dpr scrolling left the frame within
    // half a device pixel of truth (see bibScrollBlit); once the scroll goes
    // quiet, one full repaint lands it exactly. Integer dpr never sets the
    // flag, so this never fires there.
    if (g_engine && g_scrollSnapDirty && bibNowMs() - g_lastScrollBlitMs > kScrollSettleMs) {
        g_scrollSnapDirty = false;
        g_scrollResidX = g_scrollResidY = 0.0;
        BIB::addDamage(bibLogicalFrameRect());
        if (g_perfLog)
            WTFLogAlways("BIBSCROLL settle repaint");
    }
    const double _perfT2 = g_perfLog ? bibNowMs() : 0;
    bibPushFrameIfDirty(); // layout/paint/present accumulate inside bib_render
    const double _perfT3 = g_perfLog ? bibNowMs() : 0;
    bibMaybePersist(false);
    if (g_perfLog) {
        const double _perfT4 = bibNowMs();
        g_perf.runloop += _perfT1 - _perfT0;
        g_perf.renderUpdate += _perfT2 - _perfT1;
        g_perf.pushTotal += _perfT3 - _perfT2;
        g_perf.persist += _perfT4 - _perfT3;
        g_perf.ticks++;
        if (!g_perf.windowStart)
            g_perf.windowStart = _perfT0;
        const double elapsed = _perfT4 - g_perf.windowStart;
        if (elapsed >= 1000.0) {
            // pushOther = bibPushFrameIfDirty minus the painted phases =
            // dirty-rect bookkeeping + the malloc/memcpy/cross-thread dispatch.
            double pushOther = g_perf.pushTotal - g_perf.layout - g_perf.paint - g_perf.present;
            if (pushOther < 0)
                pushOther = 0;
            // wheelMs runs OUTSIDE bib_tick (proxied task) — count it or busy%
            // lies about a scroll-saturated thread.
            const double busy = g_perf.runloop + g_perf.renderUpdate + g_perf.layout
                + g_perf.paint + g_perf.present + g_perf.persist + pushOther + g_perf.wheelMs;
            WTFLogAlways("BIBPERF/s ticks=%d painted=%d elapsed=%.0fms busy=%.0f%% heap=%.0fMB jsc=%.0fMB | "
                "runloop(JS)=%.0f renderUpd=%.0f layout=%.0f paint=%.0f present=%.0f pushOther=%.0f persist=%.0f ms | "
                "pump=%.0f(max%.0f n%d) | "
                "wheel=%.0f(n%d ev%d q%d) blit=%.0f(mv%.0f wr%.0f n%d fb%d rows%.0f) | "
                "paintRects=%d(%.2fMpx, %.2fMpx/frame) avgPaintedFrame=%.1fms",
                g_perf.ticks, g_perf.painted, elapsed, 100.0 * busy / elapsed,
                emscripten_get_heap_size() / 1048576.0, WebCore::commonVM().heap.size() / 1048576.0,
                g_perf.runloop, g_perf.renderUpdate, g_perf.layout, g_perf.paint,
                g_perf.present, pushOther, g_perf.persist,
                g_perf.pumpCycle, g_perf.pumpMax, g_perf.pumps,
                g_perf.wheelMs, g_perf.wheels, g_perf.wheelEvents, g_perf.queueMax,
                g_perf.blitMs, g_perf.blitMoveMs, g_perf.blitWriteMs,
                g_perf.blits, g_perf.blitFallbacks, g_perf.blitRows,
                g_perf.paintRects, g_perf.paintAreaPx / 1e6,
                g_perf.painted ? g_perf.paintAreaPx / 1e6 / g_perf.painted : 0.0,
                g_perf.painted ? (g_perf.layout + g_perf.paint + g_perf.present) / g_perf.painted : 0.0);
            g_perf = PerfAccum { };
            g_perf.windowStart = _perfT4;
        }
    }
}
static void bibRunTick(void*)
{
    g_tickQueued.store(false, std::memory_order_release);
    bib_tick();
}

// One engine-RunLoop iteration WITHOUT the rendering-update steps. The
// wake-up plumbing (Module.bibWakeUp -> macrotask, Module.bibArmTimer ->
// setTimeout — WORKER-scope under W-B1, see engine-pre.js) calls this,
// so engine work runs at event-loop rate while rendering stays on
// bib_tick's rAF cadence.
static std::atomic<bool> g_pumpQueued { false };
static void bibRunPump(void*);
EMSCRIPTEN_KEEPALIVE void bib_pump()
{
    if (!bibOnEngineThread()) {
        if (g_pumpQueued.exchange(true, std::memory_order_acq_rel))
            return;
        if (!bibProxyToEngine(bibRunPump, nullptr))
            g_pumpQueued.store(false, std::memory_order_release);
        return;
    }
    if (!g_perfLog) {
        WTF::RunLoop::cycle();
        return;
    }
    const double t0 = bibNowMs();
    BIB::g_damagePhase = "pump";
    WTF::RunLoop::cycle();
    BIB::g_damagePhase = "idle";
    const double dt = bibNowMs() - t0;
    g_perf.pumpCycle += dt;
    if (dt > g_perf.pumpMax)
        g_perf.pumpMax = dt;
    g_perf.pumps++;
}
static void bibRunPump(void*)
{
    g_pumpQueued.store(false, std::memory_order_release);
    bib_pump();
}

EMSCRIPTEN_KEEPALIVE const int* bib_dirty_box() { return g_dirtyBox; }

// Returns the RGBA frame buffer (kWidth*kHeight*4) after repainting, or 0.
// force=0: only repaints (and returns the buffer) when the page is dirty —
//          the rAF blit loop skips putImageData on clean frames. Only the
//          accumulated damage union is painted + read back (bib_dirty_box);
//          the rest of g_blitPixels still holds the previous frame, which
//          is exactly what those pixels look like on the surface too.
// force=1: always repaints and returns the FULL frame (pixel probes that
//          sample anywhere in the buffer, first use).
EMSCRIPTEN_KEEPALIVE const uint8_t* bib_render(int force)
{
    // W-B1: engine-thread-only (driven by bib_tick's push; the host no
    // longer pulls frames). A stray main-thread caller gets nullptr.
    if (!bibOnEngineThread())
        return nullptr;
    if (!g_engine)
        return nullptr;
    // G4: while the WebGL context is lost the surfaces are dead/dropped —
    // skip BEFORE the damage snapshot below so nothing is wiped; damage
    // keeps accumulating and the restore path queues a full-frame repaint.
    if (g_gpu && g_gpuLost.load(std::memory_order_acquire))
        return nullptr;
    if (!force && !BIB::g_frameDirty && BIB::g_uploadRect.isEmpty())
        return nullptr;
    RefPtr view = mainFrameView();
    if (!view)
        return nullptr;
    // Layout BEFORE snapshotting the damage union — layout itself reports
    // damage through BibChromeClient, and it must land in THIS frame.
    const double _perfL0 = g_perfLog ? bibNowMs() : 0;
    BIB::g_damagePhase = "layout";
    g_engine->mainFrame->protectedDocument()->updateLayoutIgnorePendingStylesheets();
    BIB::g_damagePhase = "idle";
    const double _perfPaint0 = g_perfLog ? bibNowMs() : 0;
    if (g_perfLog)
        g_perf.layout += _perfPaint0 - _perfL0;
    const WebCore::IntRect frameRect = bibLogicalFrameRect();
    // Two regions, two meanings: `dirty` = WebCore repaints + we read back;
    // `upload` = pixels bibScrollBlit already shifted in BOTH mirrors — the
    // host just re-uploads them, nothing repaints (a force frame is both).
    // Damage/paint rects are LOGICAL; the framebuffer, readbacks, and the
    // reported dirty box are DEVICE px (identical at dpr 1).
    WebCore::IntRect dirty[BIB::kMaxDamageRects];
    size_t dirtyCount = 0;
    if (force)
        dirty[dirtyCount++] = frameRect;
    else {
        for (size_t i = 0; i < BIB::g_damageCount; ++i) {
            WebCore::IntRect r = WebCore::intersection(BIB::g_damageRects[i], frameRect);
            if (!r.isEmpty())
                dirty[dirtyCount++] = r;
        }
    }
    WebCore::IntRect upload = force ? WebCore::IntRect() : WebCore::intersection(BIB::g_uploadRect, frameRect);
    clearDamage(); // BEFORE paint — paint-time damage belongs to the next frame
    if (!dirtyCount && upload.isEmpty()) {
        // All damage was outside the viewport — nothing visible changed.
        return nullptr;
    }
    WebCore::IntRect paintedBounds; // device px (the reported box)
    WebCore::IntRect paintedBoundsLogical; // for the retry re-arm below
    for (size_t i = 0; i < dirtyCount; ++i) {
        const WebCore::IntRect& r = dirty[i];
        const WebCore::IntRect dr = bibDeviceRect(r);
        bool painted = paintFrameRect(r);
        bool readBack = painted;
        // Raster: the surface WRAPS g_blitPixels (boot/bib_set_viewport), so
        // the paint above already landed in the framebuffer — no readback.
        // GPU mode still reads the painted rect back: g_engine->surface is a
        // Ganesh texture surface there, and readPixels is the GPU→CPU
        // delivery (~few ms) for the proven bibBlit path.
        if (painted && g_gpu) {
            // GPU mode: paintFrameRect only RECORDS Ganesh commands; the GPU
            // hasn't executed them yet. readPixels would read stale/blank
            // pixels (the bug that made the screen look frozen while the engine
            // "painted" 60fps — 2026-06-13). Force the paint onto the GPU
            // before reading it back. (The old presentGPU did this
            // FlushAndSubmit; Approach R dropped presentGPU, so the readback
            // path must do it.) kPremul dst matches what raster now delivers
            // (straight memcpy, no per-pixel conversion).
            skgpu::ganesh::FlushAndSubmit(g_engine->surface.get());
            auto dstInfo = SkImageInfo::Make(dr.width(), dr.height(), kRGBA_8888_SkColorType, kPremul_SkAlphaType);
            uint8_t* dst = g_blitPixels + (static_cast<size_t>(dr.y()) * g_fbWidth + dr.x()) * 4;
            readBack = g_engine->surface->readPixels(SkPixmap(dstInfo, dst, g_fbWidth * 4), dr.x(), dr.y());
        }
        if (!painted || !readBack) {
            // Failed paint/readback: re-dirty THIS rect and every rect not
            // yet painted so the next frame retries instead of losing the
            // damage (Codex 2026-06-11). Re-arm the upload region too: it
            // was snapshot-cleared above. (A failed readback leaves the
            // surface newer than g_blitPixels until the retry lands.)
            for (size_t j = i; j < dirtyCount; ++j)
                BIB::addDamage(dirty[j]);
            BIB::g_uploadRect.unite(upload);
            // Rects painted BEFORE the failure are correct in both mirrors
            // but were never reported — without this the host canvas stays
            // stale there until unrelated damage covers it (Codex).
            BIB::g_uploadRect.unite(paintedBoundsLogical);
            return nullptr;
        }
        paintedBounds.unite(dr);
        paintedBoundsLogical.unite(r);
        if (g_perfLog) {
            g_perf.paintRects++;
            g_perf.paintAreaPx += static_cast<double>(dr.width()) * dr.height();
        }
    }
    if (g_perfLog) {
        g_perf.paint += bibNowMs() - _perfPaint0;
        g_perf.painted++;
    }
    WebCore::IntRect box = paintedBounds;
    box.unite(bibDeviceRect(upload));
    g_dirtyBox[0] = box.x();
    g_dirtyBox[1] = box.y();
    g_dirtyBox[2] = box.width();
    g_dirtyBox[3] = box.height();
    // W-B2 v2: GPU mode no longer presents through the (starved) OffscreenCanvas
    // placeholder. Both modes now return g_blitPixels (filled by the readback
    // above) and the host puts it on #screen via Module.bibBlit. presentGPU()
    // and g_fbo0Surface are retained only for the boot software-detection
    // bench; they are not on the steady-state path.
    return g_blitPixels;
}

// --- GPU zero-copy present (decision: handoff-2026-06-13-gpu-present-rearchitecture) ---
// Steady-state GPU present no longer reads pixels back to CPU (Approach R was
// flaky/non-deterministic — a cross-thread readback race that left the screen
// near-frozen). Instead:
//   BIB_PTHREAD=ON  : paint dirty rects into the persistent texture surface →
//                     blit texture→FBO 0 → FlushAndSubmit → the worker-private
//                     OffscreenCanvas transferToImageBitmap → postMessage the
//                     ImageBitmap (zero-copy) to the page, which paints it onto
//                     #screen via a bitmaprenderer context.
//   BIB_PTHREAD=OFF : same paint + texture→FBO 0 blit, but FBO 0 IS #screen's
//                     own WebGL drawing buffer — the browser presents it
//                     implicitly when control returns to the event loop. This
//                     is the pre-W-B1 main-thread path (MotionMark 109@144fps).
// The texture surface stays the persistent dirty-rect backing store; FBO 0 is
// rewritten in full every present (it is undefined after composite with
// preserveDrawingBuffer off, so it cannot hold dirty-rect history).

// GPU paint primitive: layout, snapshot+clear damage, paint the dirty rects
// into g_engine->surface (the texture). Mirrors bib_render's damage handling
// but stops BEFORE any readback/present. force => full-frame repaint. Returns
// true iff it painted at least one rect (i.e. a present is warranted). In GPU
// mode g_scrollBlit is null, so g_uploadRect is never armed — no upload mirror.
static bool bibPaintGPUIfDirty(bool force)
{
    if (!g_engine || !g_engine->surface)
        return false;
    if (g_gpuLost.load(std::memory_order_acquire))
        return false;
    if (!force && !BIB::g_frameDirty)
        return false;
    RefPtr view = mainFrameView();
    if (!view)
        return false;

    const double _perfL0 = g_perfLog ? bibNowMs() : 0;
    BIB::g_damagePhase = "layout";
    g_engine->mainFrame->protectedDocument()->updateLayoutIgnorePendingStylesheets();
    BIB::g_damagePhase = "idle";
    const double _perfPaint0 = g_perfLog ? bibNowMs() : 0;
    if (g_perfLog)
        g_perf.layout += _perfPaint0 - _perfL0;

    const WebCore::IntRect frameRect(0, 0, kWidth, kHeight);
    WebCore::IntRect dirty[BIB::kMaxDamageRects];
    size_t dirtyCount = 0;
    if (force)
        dirty[dirtyCount++] = frameRect;
    else {
        for (size_t i = 0; i < BIB::g_damageCount; ++i) {
            WebCore::IntRect r = WebCore::intersection(BIB::g_damageRects[i], frameRect);
            if (!r.isEmpty())
                dirty[dirtyCount++] = r;
        }
    }
    clearDamage(); // BEFORE paint — paint-time damage belongs to the next frame
    if (!dirtyCount)
        return false; // all damage was outside the viewport

    for (size_t i = 0; i < dirtyCount; ++i) {
        if (!paintFrameRect(dirty[i])) {
            // Re-arm this rect + every unpainted one so the next frame retries.
            for (size_t j = i; j < dirtyCount; ++j)
                BIB::addDamage(dirty[j]);
            return false;
        }
    }
    if (g_perfLog) {
        g_perf.paint += bibNowMs() - _perfPaint0;
        g_perf.painted++;
    }
    return true;
}

// Blit the persistent texture surface into FBO 0 and flush. After this the
// canvas default framebuffer (the bibgpu OffscreenCanvas under pthreads, or
// #screen directly otherwise) holds the current frame, ready for
// transferToImageBitmap / implicit present. FBO 0 is cleared and fully
// redrawn every present (it has no stable history under preserveDrawingBuffer
// off — that's why the texture surface, not FBO 0, is the dirty-rect store).
static bool presentGPUToCanvasFBO()
{
    if (!g_gpu || !g_engine || !g_engine->surface || !g_fbo0Surface)
        return false;
    auto* glContext = WebCore::PlatformDisplay::sharedDisplay().skiaGLContext();
    if (!glContext || !glContext->makeContextCurrent())
        return false;
    const double _p0 = g_perfLog ? bibNowMs() : 0;
    SkCanvas* dst = g_fbo0Surface->getCanvas();
    dst->clear(SK_ColorWHITE);
    g_engine->surface->draw(dst, 0, 0);
    // paintFrameRect + draw() only ENQUEUE Ganesh work; force it onto the GPU
    // so the framebuffer is complete before transfer/implicit-present.
    skgpu::ganesh::FlushAndSubmit(g_fbo0Surface.get());
    if (g_perfLog)
        g_perf.present += bibNowMs() - _p0;
    return true;
}

#ifdef __EMSCRIPTEN_PTHREADS__
// One-in-flight backpressure gate: true iff the page has consumed the previous
// ImageBitmap. Checked BEFORE bibPaintGPUIfDirty (which clears damage) so a
// not-ready frame leaves damage armed and coalesces into the next deliverable.
static bool bibBitmapPresentReady()
{
    return EM_ASM_INT({
        return (Module.bibBitmapPresentReady && Module.bibBitmapPresentReady()) ? 1 : 0;
    });
}
// transferToImageBitmap the bibgpu OffscreenCanvas (FBO 0 contents) and post it
// to the page over the dedicated MessagePort. Must run AFTER presentGPUToCanvasFBO.
// Returns true only on a successful post (1); 0/-1/-2 mean not-ready/no-canvas/throw.
static bool bibTransferCurrentFrameBitmap()
{
    return EM_ASM_INT({
        return (Module.bibTransferCurrentFrame && Module.bibTransferCurrentFrame() === 1) ? 1 : 0;
    });
}
#endif

// Called on the MAIN thread by the bibFrame present EM_ASM (finally-block,
// so a throwing host handler can't wedge the pipeline). Cheap enough to run
// off-thread: one atomic store, exactly like _bib_wasm_free's precedent.
EMSCRIPTEN_KEEPALIVE void bib_present_done()
{
    g_presentInFlight.store(false, std::memory_order_release);
}

// W-B1 frame push: GPU presents zero-copy (pthread) or implicitly (mainthread);
// raster paints into g_blitPixels, snapshots the dirty band into
// g_presentPixels, and hands that to the page (bibFrame; legacy bibBlit
// hosts get a tight malloc'd copy instead — its receiving EM_ASM runs on
// the browser main thread in module scope, copies the bytes OUT of the
// shared heap (ImageData rejects SAB-backed views), frees the transfer
// buffer (dlmalloc is thread-safe under -pthread), and calls Module.bibBlit;
// growMemViews() first — views go stale after a cross-thread memory grow,
// W-B0 finding).
static void bibPushFrameIfDirty()
{
    static bool firstFramePushed = false;

    if (g_gpu) {
        const bool force = !firstFramePushed;
#ifdef __EMSCRIPTEN_PTHREADS__
        // Zero-copy bitmap present. Backpressure FIRST: if the page hasn't
        // consumed the last ImageBitmap, do NOT paint — bibPaintGPUIfDirty
        // clears damage, so painting now would drop the frame. Leaving early
        // keeps damage armed; it coalesces into the next deliverable frame.
        if (!bibBitmapPresentReady())
            return;
        if (!bibPaintGPUIfDirty(force))
            return;
        if (!presentGPUToCanvasFBO()) {
            BIB::addDamage(WebCore::IntRect(0, 0, kWidth, kHeight));
            return;
        }
        if (!bibTransferCurrentFrameBitmap()) {
            // Port not wired yet (pre-handshake) or canvas missing — re-arm a
            // full repaint; the next ready tick retries. The ready gate above
            // means this is rare (transfer was green; the post itself failed).
            BIB::addDamage(WebCore::IntRect(0, 0, kWidth, kHeight));
            return;
        }
        firstFramePushed = true;
        return;
#else
        // BIB_PTHREAD=OFF: the engine owns #screen's WebGL2 context on the
        // browser main thread; the browser presents FBO 0 implicitly when this
        // call stack returns to the event loop (GLContext::swapBuffers is a
        // no-op). No transfer, no readback — the fast path.
        if (!bibPaintGPUIfDirty(force))
            return;
        if (!presentGPUToCanvasFBO()) {
            BIB::addDamage(WebCore::IntRect(0, 0, kWidth, kHeight));
            return;
        }
        firstFramePushed = true;
        return;
#endif
    }

    // Raster path (browsception 1.3): bibFrame push per the ABI. The host
    // uploads the dirty box from g_presentPixels, a snapshot this thread
    // fills below — NOT from the live g_blitPixels, which the engine keeps
    // mutating (paint, bibScrollBlit) while the async present runs; reading
    // it live is the scroll-up duplicated-band tear (see g_presentPixels).
    // Backpressure FIRST, like the GPU bitmap path: while the last frame is
    // unconsumed, don't paint — bib_render clears damage, so painting now
    // would either drop the frame or overwrite the in-flight snapshot.
    // Damage stays armed and coalesces into the next push. Hosts without
    // bibFrame (older gate pages) get the legacy copied bibBlit delivery,
    // which never arms the flag (its band copy below is still coherent).
    if (g_presentInFlight.load(std::memory_order_acquire))
        return;
    // Nothing in flight: no present references any retired buffer (resize).
    for (uint8_t* retired : g_retiredPresentPixels)
        free(retired);
    g_retiredPresentPixels.clear();
    const uint8_t* pixels = bib_render(firstFramePushed ? 0 : 1);
    if (!pixels)
        return;
    firstFramePushed = true;
    const int x = g_dirtyBox[0], y = g_dirtyBox[1], w = g_dirtyBox[2], h = g_dirtyBox[3];
    if (w <= 0 || h <= 0)
        return;
    static int hostHasBibFrame = -1;
    if (hostHasBibFrame < 0) {
        // One blocking hop, first push only (the boot-flag read pattern).
        hostHasBibFrame = MAIN_THREAD_EM_ASM_INT({ return Module.bibFrame ? 1 : 0; });
    }
    if (hostHasBibFrame) {
        // Snapshot the full-width dirty band (the presenter uploads full
        // rows; x/w only annotate). One contiguous memcpy — ~0.2ms/Mpx,
        // and only per PRESENTED frame thanks to the backpressure gate.
        const size_t stride = static_cast<size_t>(g_fbWidth) * 4;
        memcpy(g_presentPixels + y * stride, g_blitPixels + y * stride,
            static_cast<size_t>(h) * stride);
        g_presentInFlight.store(true, std::memory_order_release);
        MAIN_THREAD_ASYNC_EM_ASM({
            try {
                if (Module.bibFrame)
                    Module.bibFrame($0, $1, $2, $3, $4, $5, $6, $7);
            } finally {
                _bib_present_done();
            }
        }, g_presentPixels, g_fbWidth, g_fbHeight, g_fbWidth * 4, x, y, w, h);
        return;
    }
    uint8_t* copy = static_cast<uint8_t*>(malloc(static_cast<size_t>(w) * h * 4));
    if (!copy)
        return;
    for (int row = 0; row < h; ++row) {
        memcpy(copy + static_cast<size_t>(row) * w * 4,
            pixels + (static_cast<size_t>(y + row) * g_fbWidth + x) * 4,
            static_cast<size_t>(w) * 4);
    }
    MAIN_THREAD_ASYNC_EM_ASM({
        if (typeof growMemViews === "function")
            growMemViews();
        var bytes = HEAPU8.slice($0, $0 + $3 * $4 * 4);
        _bib_wasm_free($0);
        if (Module.bibBlit)
            Module.bibBlit(bytes, $1, $2, $3, $4);
    }, copy, x, y, w, h);
}

// Probe/gate path ONLY (G3, decision-005): force a repaint and return CPU
// pixels in BOTH modes. CPU mode is bib_render(1) verbatim; GPU mode force-
// paints the persistent texture surface (the SAME primitive the present path
// uses) and reads IT back into g_blitPixels — a deliberate GPU sync that must
// never run per-frame (the steady render loop presents zero-copy, no readback).
// Independent of the bitmap present path: reads the texture, not FBO 0 (whose
// content is undefined after composite with preserveDrawingBuffer off), so it
// stays correct without the legacy offscreen-backbuffer preserve attributes.
EMSCRIPTEN_KEEPALIVE const uint8_t* bib_render_readback()
{
    if (!bibOnEngineThread())
        return nullptr; // W-B1: probes use bib_request_readback instead
    if (!g_gpu)
        return bib_render(1); // raster: unchanged
    if (!g_engine || !g_engine->surface)
        return nullptr;
    if (g_gpuLost.load(std::memory_order_acquire))
        return nullptr;
    // Full-frame repaint into the texture surface, then flush + read it back.
    if (!bibPaintGPUIfDirty(true))
        return nullptr;
    auto* glContext = WebCore::PlatformDisplay::sharedDisplay().skiaGLContext();
    if (!glContext || !glContext->makeContextCurrent())
        return nullptr;
    skgpu::ganesh::FlushAndSubmit(g_engine->surface.get());
    // kPremul: matches what raster mode now delivers (the wrapped surface's
    // own bytes) — probes see one format in both modes.
    auto dstInfo = SkImageInfo::Make(g_fbWidth, g_fbHeight, kRGBA_8888_SkColorType, kPremul_SkAlphaType);
    if (!g_engine->surface->readPixels(SkPixmap(dstInfo, g_blitPixels, g_fbWidth * 4), 0, 0))
        return nullptr;
    return g_blitPixels;
}

// W-B1 async probe readback: the page cannot pull pixels synchronously
// anymore (a blocking main->engine call risks deadlock against the
// engine's proxied syscalls). The page requests; the engine renders and
// pushes the FULL frame to Module.bibReadbackReady as a copied-out
// Uint8Array. Used by __bib.probe / gate harnesses.
static void bibRunReadback(void*)
{
    const uint8_t* pixels = bib_render_readback();
    uint8_t* copy = nullptr;
    const size_t bytes = static_cast<size_t>(g_fbWidth) * g_fbHeight * 4;
    if (pixels) {
        copy = static_cast<uint8_t*>(malloc(bytes));
        if (copy)
            memcpy(copy, pixels, bytes);
        // The forced render consumed any pending damage WITHOUT pushing a
        // frame — the canvas would stay stale until unrelated damage covered
        // it. Re-arm delivery for the next tick: raster only needs an upload
        // (the framebuffer is freshly correct); GPU re-paints.
        if (!g_gpu)
            BIB::g_uploadRect.unite(bibLogicalFrameRect());
        else
            BIB::addDamage(bibLogicalFrameRect());
    }
    MAIN_THREAD_ASYNC_EM_ASM({
        var data = null;
        if ($0) {
            if (typeof growMemViews === "function")
                growMemViews();
            data = HEAPU8.slice($0, $0 + $1);
            _bib_wasm_free($0);
        }
        if (Module.bibReadbackReady)
            Module.bibReadbackReady(data, $2, $3);
    }, copy, bytes, g_fbWidth, g_fbHeight);
}
// Collapsed like bib_tick: harness predicates poll probe() every ~100ms —
// while the engine is pegged (Discord boot) the requests must not pile up
// as queued forced repaints. One pending readback serves every waiter
// (bibReadbackReady resolves them all with the same frame).
static std::atomic<bool> g_readbackQueued { false };
static void bibRunReadbackCollapsed(void*)
{
    g_readbackQueued.store(false, std::memory_order_release);
    bibRunReadback(nullptr);
}
EMSCRIPTEN_KEEPALIVE void bib_request_readback()
{
    if (!bibOnEngineThread()) {
        if (g_readbackQueued.exchange(true, std::memory_order_acq_rel))
            return;
        if (!bibProxyToEngine(bibRunReadbackCollapsed, nullptr))
            g_readbackQueued.store(false, std::memory_order_release);
        return;
    }
    bibRunReadback(nullptr);
}

// --- G4: in-place GPU context-loss recovery (W-B2) ----------------------
// The browser can revoke a WebGL context at any time (GPU reset, driver
// restart, resource pressure). G3 recovered by reloading the page; G4
// recovers IN PLACE: the lost handler preventDefault()s (required, or the
// browser never restores) and parks rendering (bib_render's g_gpuLost
// guard); the restored handler rebuilds the Ganesh world over the SAME
// context handle (WebGL restores the same context object, so the GLContext
// facades and the assembled proc table stay valid) and queues a full
// repaint. If restored never fires (some drivers won't), a deadline falls
// back to the G3 protocol: the page reloads (?gpulost=1, second loss
// ?gpu=0). Guest ImageBuffers from accelerated 2D canvases (?canvasgpu)
// are NOT rebuilt — accepted v1 gap, they re-create on guest redraw paths.

extern "C" void bibEnableAllWebGLExtensions(); // EM_JS, PlatformDisplayEmscripten.cpp

static void bibGpuRebuildAfterRestore()
{
    auto& display = WebCore::PlatformDisplay::sharedDisplay();
    // Restoration invalidated every previously enabled extension (WebGL
    // spec) — re-enable BEFORE Skia re-reads caps below, or shaders using
    // advertised extensions fail to compile again. Make the (restored)
    // context current first: the EM_JS helper reads GL.currentContext.
    emscripten_webgl_make_context_current(WebCore::emscriptenSkiaWebGLContext());
    bibEnableAllWebGLExtensions();
    // Documented teardown order for a lost context: abandon the GrContext
    // FIRST (destruction would otherwise drive dead GL), then drop the
    // surfaces that reference it.
    if (auto* grContext = display.skiaGrContext())
        grContext->abandonContext();
    g_fbo0Surface = nullptr;
    if (g_engine)
        g_engine->surface = nullptr;
    // Upstream hook (public wrapper over the private clearSkiaGLContext):
    // clears the thread-local SkiaGLContext; the next skiaGLContext() call
    // builds a fresh GrDirectContext over the restored WebGL handle via
    // GLContext::createOffscreen + the same proc table. Also nulls
    // m_sharingGLContext, which this port never creates — harmless.
    display.clearGLContexts();
    bool ok = display.skiaGLContext() && display.skiaGrContext();
    if (ok && g_engine) {
        // Same surface pair as the boot path in main(): texture-backed
        // store + FBO 0 present wrap (samples=1/stencil=8 match the
        // context attributes).
        auto info = SkImageInfo::Make(kWidth, kHeight, kRGBA_8888_SkColorType, kPremul_SkAlphaType);
        auto* grContext = display.skiaGrContext();
        g_engine->surface = SkSurfaces::RenderTarget(grContext, skgpu::Budgeted::kNo, info, 0, kTopLeft_GrSurfaceOrigin, nullptr);
        if (g_engine->surface) {
            GrGLFramebufferInfo fbInfo;
            fbInfo.fFBOID = 0;
            fbInfo.fFormat = 0x8058; // GL_RGBA8
            auto target = GrBackendRenderTargets::MakeGL(kWidth, kHeight, 1, 8, fbInfo);
            g_fbo0Surface = SkSurfaces::WrapBackendRenderTarget(grContext, target,
                kBottomLeft_GrSurfaceOrigin, kRGBA_8888_SkColorType, nullptr, nullptr);
        }
        ok = g_engine->surface && g_fbo0Surface;
    }
    if (!ok) {
        // Same split-brain hazard as a failed GPU boot: the host has no
        // blit path, so CPU raster would never reach the screen. Reload.
        printf("EMBEDDER: gpu restore REBUILD FAILED — host reload\n");
        MAIN_THREAD_ASYNC_EM_ASM({ if (Module.bibGpuLostReload) Module.bibGpuLostReload(); });
        return;
    }
    g_gpuLost.store(false, std::memory_order_release);
    printf("EMBEDDER: gpu context restored\n");
    // Everything on the old context is gone — full-frame repaint. The next
    // bib_tick's push renders it.
    BIB::addDamage(WebCore::IntRect(0, 0, kWidth, kHeight));
}

extern "C" {
// Called directly from the canvas event handlers below — they run on the
// thread that owns the canvas, which is the engine thread (pthread build:
// the OffscreenCanvas lives here; single-thread build: main IS the engine).
EMSCRIPTEN_KEEPALIVE void bib_gpu_context_lost()
{
    // No g_gpu guard: the handlers are installed right after context
    // creation, BEFORE the caps stage sets g_gpu (Codex MEDIUM) — a
    // mid-boot loss must still be flagged.
    g_gpuLost.store(true, std::memory_order_release);
    printf("EMBEDDER: gpu context LOST — awaiting restore\n");
}

EMSCRIPTEN_KEEPALIVE void bib_gpu_context_restored()
{
    if (!g_gpuLost.load(std::memory_order_acquire))
        return;
    if (!g_gpu) {
        // Lost+restored entirely within the boot window: nothing to
        // rebuild yet — boot either succeeded on the restored context or
        // failed into the host raster-reload fallback.
        g_gpuLost.store(false, std::memory_order_release);
        return;
    }
    bibGpuRebuildAfterRestore();
}

EMSCRIPTEN_KEEPALIVE void bib_gpu_restore_timed_out()
{
    if (!g_gpuLost.load(std::memory_order_acquire))
        return;
    printf("EMBEDDER: gpu restore TIMED OUT — host reload\n");
    MAIN_THREAD_ASYNC_EM_ASM({ if (Module.bibGpuLostReload) Module.bibGpuLostReload(); });
}
}

// Registered from main() after a successful GPU boot. W-B2 v2: the GL context
// is backed by the worker-private "#bibgpu" OffscreenCanvas (created at GPU
// boot, registered in GL.offscreenCanvases) — NOT #screen, which is no longer
// transferred. Attach the loss/restore listeners to that OffscreenCanvas (it
// is an EventTarget firing webglcontextlost/restored). The handlers run
// between engine tasks (worker/main event loop), never mid-paint, so calling
// the exports directly is safe.
static void installGpuContextLossHandlers()
{
#ifdef __EMSCRIPTEN_PTHREADS__
    // pthread build: the GL context is backed by the worker-private "#bibgpu"
    // OffscreenCanvas (it is an EventTarget firing webglcontextlost/restored).
    EM_ASM({
        var entry = typeof GL !== "undefined" && GL.offscreenCanvases && GL.offscreenCanvases["bibgpu"];
        var canvas = entry ? (entry.offscreenCanvas || entry.canvas) : null;
        if (!canvas) {
            out("EMBEDDER: gpu loss handlers NOT installed (no #bibgpu canvas)");
            return;
        }
        var deadline = null;
        canvas.addEventListener("webglcontextlost", function(e) {
            e.preventDefault(); // REQUIRED or the browser never restores
            _bib_gpu_context_lost();
            deadline = setTimeout(function() {
                deadline = null;
                _bib_gpu_restore_timed_out();
            }, 8000);
        });
        canvas.addEventListener("webglcontextrestored", function() {
            if (deadline) {
                clearTimeout(deadline);
                deadline = null;
            }
            _bib_gpu_context_restored();
        });
    });
#else
    // BIB_PTHREAD=OFF: the engine owns #screen's WebGL2 context directly on the
    // browser main thread, so loss/restore fire on the DOM canvas itself.
    EM_ASM({
        var canvas = document.getElementById("screen");
        if (!canvas) {
            out("EMBEDDER: gpu loss handlers NOT installed (no #screen)");
            return;
        }
        var deadline = null;
        canvas.addEventListener("webglcontextlost", function(e) {
            e.preventDefault(); // REQUIRED or the browser never restores
            _bib_gpu_context_lost();
            deadline = setTimeout(function() {
                deadline = null;
                _bib_gpu_restore_timed_out();
            }, 8000);
        });
        canvas.addEventListener("webglcontextrestored", function() {
            if (deadline) {
                clearTimeout(deadline);
                deadline = null;
            }
            _bib_gpu_context_restored();
        });
    });
#endif
}

// Test hook (gate8): lose the live context via WEBGL_lose_context, restore
// it 500ms later — exercises the full G4 path. Self-proxies like every
// page-callable export.
static void bibRunGpuTestLose(void*)
{
    if (!g_gpu || g_gpuLost.load(std::memory_order_acquire))
        return;
    auto* glContext = WebCore::PlatformDisplay::sharedDisplay().skiaGLContext();
    if (!glContext || !glContext->makeContextCurrent())
        return;
    EM_ASM({
        var ext = GL.currentContext && GL.currentContext.GLctx.getExtension("WEBGL_lose_context");
        if (!ext) {
            out("EMBEDDER: WEBGL_lose_context unavailable");
            return;
        }
        ext.loseContext();
        setTimeout(function() { ext.restoreContext(); }, 500);
    });
}

extern "C" EMSCRIPTEN_KEEPALIVE void bib_gpu_test_lose_restore()
{
    if (!bibOnEngineThread()) {
        bibProxyToEngine(bibRunGpuTestLose, nullptr);
        return;
    }
    bibRunGpuTestLose(nullptr);
}

// --- Input forwarding (canvas events -> WebCore EventHandler) ---
// W-B1: each entry self-proxies with a heap-copied argument pack; events
// run on the engine thread in arrival order (single FIFO proxy queue).
//
// POSITIONAL input (wheel, mouse move) additionally COALESCES into the task
// already queued for it: never apply — and so never render — a state the
// pending input already supersedes. A wheel batch sums its deltas, a move
// batch keeps the latest position; DISCRETE input (buttons, keys) is never
// merged, because each one means something on its own.
//
// The merge window is exactly "while this task is still queued and nothing
// else has been posted behind it" (bibSealPendingInput, called from
// bibProxyToEngine). Two consequences worth knowing:
//   - Order is preserved against every other proxied task, input or not.
//   - Collapse is proportional to how far behind the engine is. Keeping up,
//     each host event still gets its own task (the rAF tick posted between
//     them sealed the batch) and the guest sees exactly what it saw before;
//     saturated, ticks collapse too and a frame's worth of wheels arrive as
//     one event, which is what bounds the blit to ~1 per painted frame.
// Batch state is host-thread-written, engine-thread-read: g_inputMutex covers
// both, and the open pointer is published BEFORE the task is posted so the
// drain (which clears it under the lock) can never race a merge into memory
// it is about to free.
static std::mutex g_inputMutex;

struct BibMouseMoveTask { double x; double y; int mods; };
static BibMouseMoveTask* g_openMove; // g_inputMutex

// events = host wheel events summed into this one (perf log only).
struct BibWheelTask { double x; double y; double dx; double dy; int mods; int events; };
static BibWheelTask* g_openWheel; // g_inputMutex

// Close every batch except the one whose task is being posted right now
// (that one is open precisely because its task is queued).
static void bibSealPendingInput(void (*posted)(void*))
{
    std::lock_guard<std::mutex> lock(g_inputMutex);
    if (posted != bibRunWheel)
        g_openWheel = nullptr;
    if (posted != bibRunMouseMove)
        g_openMove = nullptr;
}

EMSCRIPTEN_KEEPALIVE void bib_mouse_move(double deviceX, double deviceY, int modifierBits)
{
    if (!bibOnEngineThread()) {
        {
            std::lock_guard<std::mutex> lock(g_inputMutex);
            if (g_openMove && g_openMove->mods == modifierBits) {
                g_openMove->x = deviceX; // latest position wins
                g_openMove->y = deviceY;
                return;
            }
        }
        auto* task = new BibMouseMoveTask { deviceX, deviceY, modifierBits };
        {
            std::lock_guard<std::mutex> lock(g_inputMutex);
            g_openMove = task;
        }
        if (!bibProxyToEngine(bibRunMouseMove, task)) {
            {
                std::lock_guard<std::mutex> lock(g_inputMutex);
                if (g_openMove == task)
                    g_openMove = nullptr;
            }
            delete task; // pre-main: drop, matches !g_engine
        }
        return;
    }
    if (!g_engine)
        return;
    const WebCore::DoublePoint position = bibLogicalPoint(deviceX, deviceY);
    WebCore::PlatformMouseEvent event(position, position, WebCore::MouseButton::None,
        WebCore::PlatformEvent::Type::MouseMoved, 0, modifiersFromBits(modifierBits),
        MonotonicTime::now(), 0, WebCore::SyntheticClickType::NoTap);
    g_engine->mainFrame->eventHandler().mouseMoved(event);
}
static void bibRunMouseMove(void* p)
{
    auto* t = static_cast<BibMouseMoveTask*>(p);
    BibMouseMoveTask ev;
    {
        std::lock_guard<std::mutex> lock(g_inputMutex);
        if (g_openMove == t)
            g_openMove = nullptr; // closed: later moves start a new batch
        ev = *t;
    }
    delete t;
    bib_mouse_move(ev.x, ev.y, ev.mods);
}

struct BibMouseButtonTask { int down; int jsButton; double x; double y; int clicks; int mods; };
static void bibRunMouseButton(void*);
EMSCRIPTEN_KEEPALIVE void bib_mouse_button(int down, int jsButton, double deviceX, double deviceY, int clickCount, int modifierBits)
{
    if (!bibOnEngineThread()) {
        auto* task = new BibMouseButtonTask { down, jsButton, deviceX, deviceY, clickCount, modifierBits };
        if (!bibProxyToEngine(bibRunMouseButton, task))
            delete task;
        return;
    }
    if (!g_engine)
        return;
    auto button = WebCore::MouseButton::Other;
    if (jsButton == 0)
        button = WebCore::MouseButton::Left;
    else if (jsButton == 1)
        button = WebCore::MouseButton::Middle;
    else if (jsButton == 2)
        button = WebCore::MouseButton::Right;
    const WebCore::DoublePoint position = bibLogicalPoint(deviceX, deviceY);
    WebCore::PlatformMouseEvent event(position, position, button,
        down ? WebCore::PlatformEvent::Type::MousePressed : WebCore::PlatformEvent::Type::MouseReleased,
        clickCount, modifiersFromBits(modifierBits), MonotonicTime::now(), 0,
        WebCore::SyntheticClickType::NoTap);
    if (down)
        g_engine->mainFrame->eventHandler().handleMousePressEvent(event);
    else
        g_engine->mainFrame->eventHandler().handleMouseReleaseEvent(event);
}
static void bibRunMouseButton(void* p)
{
    auto* t = static_cast<BibMouseButtonTask*>(p);
    bib_mouse_button(t->down, t->jsButton, t->x, t->y, t->clicks, t->mods);
    delete t;
}

// Wheel batches in flight (enqueued, not yet run). Merging IS the
// backpressure: a saturated engine sums a frame's events into the batch it
// has not run yet instead of queueing them, so this stays at ~1-2 however
// fast the user scrolls. perflog reports the high-water mark.
static std::atomic<int> g_wheelQueued { 0 };
// Set from the last applied wheel's EventHandling: a guest handler that
// preventDefault()s wheels is doing something per-event with them (custom
// scroller, carousel, zoom widget), so stop summing and let it see each one.
// Engine writes, host reads — one event stale by construction, which is the
// best any non-blocking answer can be.
static std::atomic<bool> g_wheelConsumed { false };

// May a (dx, dy, mods) event be summed into the still-open batch `open`?
static bool bibWheelMergeable(const BibWheelTask& open, double dx, double dy, int mods)
{
    if (open.mods != mods) // ctrl+wheel is zoom, not scroll
        return false;
    if (g_wheelConsumed.load(std::memory_order_acquire))
        return false;
    if (open.dx * dx < 0 || open.dy * dy < 0)
        return false; // direction reversal: a sum that cancels renders a state nobody asked for
    // Dominant axis must agree — a vertical batch must not absorb a
    // horizontal flick (WebCore latches a gesture to one scroller by its
    // direction). Dominance, not an exact axis match: trackpads put a little
    // cross-axis noise on nearly every event, and requiring the signature to
    // match would mean never merging.
    return (std::abs(open.dx) > std::abs(open.dy)) == (std::abs(dx) > std::abs(dy));
}

static void bibApplyWheel(double deviceX, double deviceY, double deltaX, double deltaY, int modifierBits, int events);
EMSCRIPTEN_KEEPALIVE void bib_wheel(double deviceX, double deviceY, double deltaX, double deltaY, int modifierBits)
{
    if (!bibOnEngineThread()) {
        {
            std::lock_guard<std::mutex> lock(g_inputMutex);
            if (g_openWheel && bibWheelMergeable(*g_openWheel, deltaX, deltaY, modifierBits)) {
                g_openWheel->x = deviceX; // latest position wins
                g_openWheel->y = deviceY;
                g_openWheel->dx += deltaX;
                g_openWheel->dy += deltaY;
                g_openWheel->events++;
                return;
            }
        }
        auto* task = new BibWheelTask { deviceX, deviceY, deltaX, deltaY, modifierBits, 1 };
        {
            std::lock_guard<std::mutex> lock(g_inputMutex);
            g_openWheel = task;
        }
        g_wheelQueued.fetch_add(1, std::memory_order_relaxed);
        if (!bibProxyToEngine(bibRunWheel, task)) {
            g_wheelQueued.fetch_sub(1, std::memory_order_relaxed);
            {
                std::lock_guard<std::mutex> lock(g_inputMutex);
                if (g_openWheel == task)
                    g_openWheel = nullptr;
            }
            delete task;
        }
        return;
    }
    bibApplyWheel(deviceX, deviceY, deltaX, deltaY, modifierBits, 1);
}

static void bibApplyWheel(double deviceX, double deviceY, double deltaX, double deltaY, int modifierBits, int events)
{
    if (!g_engine)
        return;
    const double _wheelT0 = g_perfLog ? bibNowMs() : 0;
    auto modifiers = modifiersFromBits(modifierBits);
    // Deltas are already LOGICAL px (DOM wheel deltas are CSS px, which is
    // the same space) — only the position needs unscaling. DOM wheel deltas
    // are positive-down; PlatformWheelEvent is positive-up.
    const WebCore::IntPoint position = WebCore::flooredIntPoint(bibLogicalPoint(deviceX, deviceY));
    WebCore::PlatformWheelEvent event(position, position,
        -deltaX, -deltaY, -deltaX / 120.0f, -deltaY / 120.0f,
        WebCore::PlatformWheelEventGranularity::ScrollByPixelWheelEvent,
        modifiers.contains(WebCore::PlatformEvent::Modifier::ShiftKey),
        modifiers.contains(WebCore::PlatformEvent::Modifier::ControlKey),
        modifiers.contains(WebCore::PlatformEvent::Modifier::AltKey),
        modifiers.contains(WebCore::PlatformEvent::Modifier::MetaKey));
    BIB::g_damagePhase = "wheel";
    auto [handled, handling] = g_engine->mainFrame->eventHandler().handleWheelEvent(event,
        { WebCore::WheelEventProcessingSteps::SynchronousScrolling, WebCore::WheelEventProcessingSteps::BlockingDOMEventDispatch });
    BIB::g_damagePhase = "idle";
    (void)handled;
    g_wheelConsumed.store(handling.contains(WebCore::EventHandling::DefaultPrevented),
        std::memory_order_release);
    if (g_perfLog) {
        g_perf.wheelMs += bibNowMs() - _wheelT0;
        g_perf.wheels++;
        g_perf.wheelEvents += events;
    }
}
static void bibRunWheel(void* p)
{
    const int depth = g_wheelQueued.fetch_sub(1, std::memory_order_relaxed);
    if (g_perfLog && depth > g_perf.queueMax)
        g_perf.queueMax = depth;
    auto* t = static_cast<BibWheelTask*>(p);
    BibWheelTask ev;
    {
        std::lock_guard<std::mutex> lock(g_inputMutex);
        if (g_openWheel == t)
            g_openWheel = nullptr; // closed: later wheels start a new batch
        ev = *t;
    }
    delete t;
    bibApplyWheel(ev.x, ev.y, ev.dx, ev.dy, ev.mods, ev.events);
}

// browsception 1.4 (ABI bib_set_focus): host canvas focus/blur -> page focus.
// Blur parks the caret / drops :focus styling; focus restores them. Activation
// stays true for the instance's lifetime (the "window" is never deactivated —
// the viewer tab either shows it or the instance is gone).
static void bibRunSetFocus(void*);
EMSCRIPTEN_KEEPALIVE void bib_set_focus(int focused)
{
    if (!bibOnEngineThread()) {
        bibProxyToEngine(bibRunSetFocus, reinterpret_cast<void*>(static_cast<intptr_t>(focused)));
        return;
    }
    if (!g_engine)
        return;
    g_engine->page->focusController().setFocused(focused != 0);
}
static void bibRunSetFocus(void* p)
{
    bib_set_focus(static_cast<int>(reinterpret_cast<intptr_t>(p)));
}

// browsception 2.3: ABI version probe. The one export that is NOT proxied —
// pure constant, callable from any thread, including before main(). Mirrors
// BIB_ABI_VERSION in browsception's src/abi/bib_abi.h.
EMSCRIPTEN_KEEPALIVE int bib_abi_version(void)
{
    return 1;
}

// browsception 2.3: navigation chrome (fake URL bar back/forward/reload/stop).
static void bibRunGo(void* p)
{
    int delta = static_cast<int>(reinterpret_cast<intptr_t>(p));
    if (g_engine)
        g_engine->page->backForward().goBackOrForward(delta);
}
EMSCRIPTEN_KEEPALIVE void bib_go(int delta)
{
    if (!bibOnEngineThread()) {
        bibProxyToEngine(bibRunGo, reinterpret_cast<void*>(static_cast<intptr_t>(delta)));
        return;
    }
    bibRunGo(reinterpret_cast<void*>(static_cast<intptr_t>(delta)));
}

static void bibRunReload(void*)
{
    if (g_engine)
        g_engine->mainFrame->loader().reload({ }, /* isRequestFromClientOrUserInput */ true);
}
EMSCRIPTEN_KEEPALIVE void bib_reload(void)
{
    if (!bibOnEngineThread()) {
        bibProxyToEngine(bibRunReload, nullptr);
        return;
    }
    bibRunReload(nullptr);
}

static void bibRunStop(void*)
{
    if (g_engine)
        g_engine->mainFrame->loader().stopForUserCancel();
}
EMSCRIPTEN_KEEPALIVE void bib_stop(void)
{
    if (!bibOnEngineThread()) {
        bibProxyToEngine(bibRunStop, nullptr);
        return;
    }
    bibRunStop(nullptr);
}

// browsception 1.5 (ABI bib_crash, DEV): hard-abort on the engine thread —
// exercises the crash -> abort -> host teardown/reload path on demand.
static void bibRunCrash(void*)
{
    WTFLogAlways("BIB: bib_crash — aborting (dev crash hook)");
    abort();
}
EMSCRIPTEN_KEEPALIVE void bib_crash(void)
{
    if (!bibOnEngineThread()) {
        bibProxyToEngine(bibRunCrash, nullptr);
        return;
    }
    bibRunCrash(nullptr);
}

// Diagnostics: dump script/scroll state to stdout (host console).
static void bibRunDiag(void*);
EMSCRIPTEN_KEEPALIVE void bib_diag()
{
    if (!bibOnEngineThread()) {
        bibProxyToEngine(bibRunDiag, nullptr);
        return;
    }
    if (!g_engine)
        return;
    auto& frame = *g_engine->mainFrame;
    RefPtr doc = frame.document();
    printf("DIAG: scriptEnabledSetting=%d\n", frame.settings().isScriptEnabled());
    printf("DIAG: canExecuteScripts=%d\n", frame.script().canExecuteScripts(WebCore::ReasonForCallingCanExecuteScripts::NotAboutToExecuteScript));
    printf("DIAG: sandboxedScripts=%d\n", doc && doc->isSandboxed(WebCore::SandboxFlag::Scripts));
    printf("DIAG: docURL=%s\n", doc ? doc->url().string().utf8().data() : "(null)");
    if (RefPtr view = mainFrameView()) {
        auto contents = view->contentsSize();
        printf("DIAG: contentsSize=%dx%d scrollY=%d\n", contents.width(), contents.height(), view->scrollPosition().y());
        printf("DIAG: isScrollableOrRubberbandable=%d canHaveScrollbars=%d vScrollbar=%d scrollAnimatorEnabled=%d\n",
            view->isScrollableOrRubberbandable(),
            view->canHaveScrollbars(),
            !!view->verticalScrollbar(),
            frame.settings().scrollAnimatorEnabled());
    }
    auto result = frame.script().executeScriptIgnoringException("6*7"_s, JSC::SourceTaintedOrigin::Untainted);
    printf("DIAG: executeScript(6*7) isNumber=%d value=%d\n", result && result.isNumber(), result && result.isNumber() ? (int)result.asNumber() : -1);
}
static void bibRunDiag(void*) { bib_diag(); }

// Diagnostics: programmatic scroll, bypassing the wheel-event path.
static void bibRunScrollTo(void*);
EMSCRIPTEN_KEEPALIVE void bib_scroll_to(int y)
{
    if (!bibOnEngineThread()) {
        bibProxyToEngine(bibRunScrollTo, reinterpret_cast<void*>(static_cast<intptr_t>(y)));
        return;
    }
    if (!g_engine)
        return;
    if (RefPtr view = mainFrameView())
        view->setScrollPosition(WebCore::ScrollPosition(0, y));
}
static void bibRunScrollTo(void* p) { bib_scroll_to(static_cast<int>(reinterpret_cast<intptr_t>(p))); }

// Diagnostic: run a script string in the guest main world. Output channel
// is the guest console (wrap probes in console.log(...) — the forwarder
// puts them on stderr as "BIB: console log: ..."). Returns 0 if the engine
// is not up. Drives DOM/computed-style probes that are otherwise
// impossible from the host side.
// W-B1: proxied cross-thread; the optimistic `1` only means "queued" there
// (results travel via the guest-console forwarder anyway).
static void bibRunEval(void*);
EMSCRIPTEN_KEEPALIVE int bib_eval(const char* source)
{
    if (!bibOnEngineThread()) {
        if (!source)
            return 0;
        char* copy = strdup(source);
        if (!bibProxyToEngine(bibRunEval, copy)) {
            free(copy);
            return 0;
        }
        return 1;
    }
    if (!g_engine || !source)
        return 0;
    g_engine->mainFrame->script().executeScriptIgnoringException(String::fromUTF8(source), JSC::SourceTaintedOrigin::Untainted);
    return 1;
}
static void bibRunEval(void* p)
{
    char* source = static_cast<char*>(p);
    bib_eval(source);
    free(source);
}

// Host-triggered persistence flush (visibilitychange/pagehide): skips the
// 5s throttle but still skips the push when nothing changed.
static void bibRunPersistNow(void*);
EMSCRIPTEN_KEEPALIVE void bib_persist_now()
{
    if (!bibOnEngineThread()) {
        bibProxyToEngine(bibRunPersistNow, nullptr);
        return;
    }
    bibMaybePersist(true);
}
static void bibRunPersistNow(void*) { bib_persist_now(); }

// ---------------------------------------------------------------------------
// Guest WebAssembly shim (decision-006 S-A). JSC's wasm tiers are all
// unavailable on the CLoop port (IPInt has no cloop lowering — NO-GO), so
// guest pages get a polyfill instead: the host page translates module bytes
// to plain JS with Binaryen's wasm2js and the polyfill evals the result.
// Engine side is two dumb pipes, both installed per new window object by
// BibFrameLoaderClient::dispatchDidClearWindowObjectInWorld:
//   1. __bibWasm2js(payload, mode) — native fn on the guest global; ships a
//      base64 module to Module.bibWasm2js in the host realm (same thread:
//      the whole stack is single-threaded, EM_ASM is a synchronous call into
//      the page realm) and returns the host's string, or null.
//   2. the polyfill source (web/wasm-polyfill.js) — provided by the host as
//      Module.bibWasmPolyfill, evaluated before any author script. Hosts
//      that define neither (node gate runner) keep today's no-wasm behavior.

EMSCRIPTEN_KEEPALIVE char* bib_wasm_alloc(int size)
{
    // EM_ASM blocks below allocate engine-heap buffers for returned strings;
    // malloc itself is not in the JS export set, KEEPALIVE exports are.
    return static_cast<char*>(malloc(size));
}

EMSCRIPTEN_KEEPALIVE void bib_wasm_free(char* ptr)
{
    // W-B1: the frame-push / readback EM_ASM blocks free their transfer
    // buffers FROM THE MAIN THREAD — dlmalloc is thread-safe under -pthread.
    free(ptr);
}

// The JSC host function and the WTF/JSC-typed helpers below need C++
// linkage — step outside the export block (reopened after them).
} // extern "C"

JSC_DEFINE_HOST_FUNCTION(bibWasm2jsHostFunction, (JSC::JSGlobalObject* globalObject, JSC::CallFrame* callFrame))
{
    JSC::VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    String payload = callFrame->argument(0).toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    String mode = callFrame->argument(1).toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    CString payloadUTF8 = payload.utf8();
    CString modeUTF8 = mode.utf8();
    char* out = static_cast<char*>(EM_ASM_PTR({
        let result = null;
        try {
            if (Module.bibWasm2js)
                result = Module.bibWasm2js(UTF8ToString($0), UTF8ToString($1));
        } catch (e) {
            (Module.printErr || console.error)("bibWasm2js host error: " + e);
        }
        if (typeof result !== "string")
            return 0;
        const len = lengthBytesUTF8(result) + 1;
        const buf = _bib_wasm_alloc(len);
        // A large translatable module (Discord ships several MB-scale ones)
        // can produce a multi-MB JS string; under wasm32 heap pressure the
        // alloc can fail. Without this guard stringToUTF8 writes through a
        // null pointer -> "memory access out of bounds" (Codex Rank 2).
        if (!buf)
            return 0;
        stringToUTF8(result, buf, len);
        return buf;
    }, payloadUTF8.data(), modeUTF8.data()));
    if (!out)
        return JSC::JSValue::encode(JSC::jsNull());
    JSC::JSString* result = JSC::jsString(vm, String::fromUTF8(out));
    free(out);
    return JSC::JSValue::encode(result);
}

static const String& wasmPolyfillSource()
{
    static NeverDestroyed<String> source = [] {
        char* text = static_cast<char*>(EM_ASM_PTR({
            const text = Module.bibWasmPolyfill;
            if (typeof text !== "string" || !text.length)
                return 0;
            const len = lengthBytesUTF8(text) + 1;
            const buf = _bib_wasm_alloc(len);
            stringToUTF8(text, buf, len);
            return buf;
        }));
        if (!text)
            return String();
        String result = String::fromUTF8(text);
        free(text);
        return result;
    }();
    return source;
}

void BIB::injectWasmPolyfill(WebCore::LocalFrame& frame, WebCore::DOMWrapperWorld& world)
{
    if (&world != &WebCore::mainThreadNormalWorldSingleton())
        return;
    const String& polyfill = wasmPolyfillSource();
    if (polyfill.isEmpty())
        return;
    auto* globalObject = frame.script().globalObject(world);
    if (!globalObject)
        return;
    JSC::VM& vm = globalObject->vm();
    JSC::JSLockHolder lock(vm);
    globalObject->putDirect(vm, JSC::Identifier::fromString(vm, "__bibWasm2js"_s),
        JSC::JSFunction::create(vm, globalObject, 2, "__bibWasm2js"_s, bibWasm2jsHostFunction, JSC::ImplementationVisibility::Public),
        static_cast<unsigned>(JSC::PropertyAttribute::DontEnum));
    // The polyfill consumes (and deletes) __bibWasm2js from the global, then
    // defines WebAssembly. Runs before any author script in this document.
    frame.script().executeScriptIgnoringException(String { polyfill }, JSC::SourceTaintedOrigin::Untainted);
}

extern "C" {

// Phase 4: real navigation. Drives FrameLoader::load -> DocumentLoader ->
// CachedResourceLoader -> EmbedderLoaderStrategy -> BibNetBridge.
static void bibRunLoadUrl(void*);
EMSCRIPTEN_KEEPALIVE void bib_load_url(const char* url)
{
    if (!bibOnEngineThread()) {
        if (!url)
            return;
        char* copy = strdup(url);
        if (!bibProxyToEngine(bibRunLoadUrl, copy))
            free(copy);
        return;
    }
    if (!g_engine)
        return;
    WebCore::ResourceRequest request { URL { String::fromUTF8(url) } };
    WebCore::FrameLoadRequest frameLoadRequest { *g_engine->mainFrame, WTF::move(request) };
    printf("EMBEDDER: loading %s\n", url);
    g_engine->mainFrame->loader().load(WTF::move(frameLoadRequest));
}
static void bibRunLoadUrl(void* p)
{
    char* url = static_cast<char*>(p);
    bib_load_url(url);
    free(url);
}

// type: 0 = RawKeyDown, 1 = KeyUp, 2 = Char. Strings are UTF-8 (use ccall).
// text is only meaningful for Char events.
// W-B1: cross-thread returns 1 optimistically — the engine-side handled
// verdict isn't knowable without a blocking round-trip (deadlock-prone).
// The host only consumes the return for preventDefault, where over-eager
// handling is the safe direction.
struct BibKeyTask { int type; char* key; char* code; char* text; int vk; int repeat; int mods; };
static void bibRunKey(void*);
EMSCRIPTEN_KEEPALIVE int bib_key(int type, const char* key, const char* code, const char* text, int windowsVirtualKeyCode, int isAutoRepeat, int modifierBits)
{
    if (!bibOnEngineThread()) {
        auto* task = new BibKeyTask { type, strdup(key ? key : ""), strdup(code ? code : ""),
            strdup(text ? text : ""), windowsVirtualKeyCode, isAutoRepeat, modifierBits };
        if (!bibProxyToEngine(bibRunKey, task)) {
            free(task->key);
            free(task->code);
            free(task->text);
            delete task;
            return 0;
        }
        return 1;
    }
    if (!g_engine)
        return 0;
    auto eventType = WebCore::PlatformEvent::Type::RawKeyDown;
    if (type == 1)
        eventType = WebCore::PlatformEvent::Type::KeyUp;
    else if (type == 2)
        eventType = WebCore::PlatformEvent::Type::Char;
    String textString = eventType == WebCore::PlatformEvent::Type::Char ? String::fromUTF8(text) : String();
    WebCore::PlatformKeyboardEvent event(eventType, textString, textString,
        String::fromUTF8(key), String::fromUTF8(code), emptyString(),
        windowsVirtualKeyCode, isAutoRepeat, false, false,
        modifiersFromBits(modifierBits), MonotonicTime::now());
    return g_engine->mainFrame->eventHandler().keyEvent(event);
}
static void bibRunKey(void* p)
{
    auto* t = static_cast<BibKeyTask*>(p);
    bib_key(t->type, t->key, t->code, t->text, t->vk, t->repeat, t->mods);
    free(t->key);
    free(t->code);
    free(t->text);
    delete t;
}

} // extern "C"

int main()
{
    // W-B1: record the engine thread FIRST — every export's self-proxy
    // check needs it, and the host page starts calling exports the moment
    // onEngineReady fires.
    g_engineThread = pthread_self();
    g_engineThreadReady.store(true, std::memory_order_release);

    // Install the worker-scope Module hooks (pump, bibWasmPolyfill,
    // bibWasm2js — engine-pre.js) NOW: this EM_ASM runs in the engine
    // pthread's worker scope with Module fully constructed. The pre-js's
    // own eager attempts can fire before the pthread bootstrap builds
    // Module (gate9: empty bibWasmPolyfill got cached for the session).
    EM_ASM({
        if (typeof self !== "undefined" && self.__bibInstallWorkerHooks)
            self.__bibInstallWorkerHooks();
    });
    printf("EMBEDDER: engine thread=%p browser-main=%d\n",
        reinterpret_cast<void*>(g_engineThread), emscripten_is_main_browser_thread());
    // W-B1: all boot flags below live on the PAGE's Module — the engine
    // pthread's worker Module does not inherit them (W-B0 finding).
    // MAIN_THREAD_EM_ASM blocks this thread briefly while the main thread
    // answers; safe at boot, before the page starts driving us.
    //
    // ?perflog=1 on the host page: emit a per-second engine-thread phase
    // breakdown (BIBPERF/s). Read straight from the host URL so no
    // browser.html wiring is needed — purely a diagnostic knob, off by
    // default. See PerfAccum / bib_tick.
    g_perfLog = MAIN_THREAD_EM_ASM_INT({
        try { return new URLSearchParams(location.search).get("perflog") === "1" ? 1 : 0; }
        catch (e) { return 0; }
    });
    printf("EMBEDDER: perflog=%s\n", g_perfLog ? "on" : "off");
    BIB::g_scrollDebug = g_perfLog;
    // ?dmglog=1: per-rect damage tracing (chatty; diagnostic runs only).
    BIB::g_damageLog = MAIN_THREAD_EM_ASM_INT({
        try { return new URLSearchParams(location.search).get("dmglog") === "1" ? 1 : 0; }
        catch (e) { return 0; }
    });

    // Rendering-update throttle config (see g_rcapDynamic). ?rcap absent =>
    // DYNAMIC (default, interactive only — gates render once and must stay
    // deterministic). ?rcap=0 => off (uncapped). ?rcap=N (1..240) => fixed N/s.
    {
        int rcap = MAIN_THREAD_EM_ASM_INT({
            try { var s = new URLSearchParams(location.search).get("rcap");
                  if (s === null) return -1;                 // absent => dynamic
                  var v = parseInt(s, 10);
                  return (v >= 0 && v <= 240) ? v : -1; }
            catch (e) { return -1; }
        });
        const bool inter = MAIN_THREAD_EM_ASM_INT({ return Module.bibInteractive ? 1 : 0; });
        if (rcap < 0)       { g_rcapDynamic = inter; g_rcapFixedMs = 0.0; }
        else if (rcap == 0) { g_rcapDynamic = false; g_rcapFixedMs = 0.0; }
        else                { g_rcapDynamic = false; g_rcapFixedMs = 1000.0 / rcap; }
        printf("EMBEDDER: rcap=%s\n",
            g_rcapFixedMs > 0.0 ? "fixed" : g_rcapDynamic ? "dynamic" : "off");
    }

    // Request blocklist (?noblock=1 on the host page disables it): the loader
    // strategy refuses analytics/ads/telemetry subresources before they
    // download — CLoop parses every script byte on the main thread, so those
    // bundles are pure boot cost.
    bool noBlock = MAIN_THREAD_EM_ASM_INT({ return Module.bibNoBlock ? 1 : 0; });
    BIB::setRequestBlocklistEnabled(!noBlock);
    printf("EMBEDDER: request blocklist=%s\n", noBlock ? "off" : "on");

    // ?gclog=1 (host URL): turn on JSC GC pause logging (JSC_logGC=Basic) to
    // confirm whether the periodic ~1fps stutter is GC stop-the-world vs slow
    // CLoop JS. MUST be set BEFORE JSC::initialize() — Options::initialize()
    // reads JSC_-prefixed env once there. setenv from C (Module.ENV-based
    // getenv proved unreliable here). Diagnostic, off by default.
    if (MAIN_THREAD_EM_ASM_INT({
        try { return new URLSearchParams(location.search).get("gclog") === "1" ? 1 : 0; }
        catch (e) { return 0; }
    })) {
        setenv("JSC_logGC", "1", 1);
        printf("EMBEDDER: gclog=on (JSC_logGC=1)\n");
    }

    JSC::initialize();
    WTF::initializeMainThread();
    WTF::setProcessPrivileges(WTF::allPrivileges());
    WebCore::initializeCommonAtomStrings();
    BIB::installEmbedderStrategies();

    // Event-driven pump: every main-RunLoop wake-up (dispatch, timer start)
    // pokes the host page, which schedules a macrotask calling bib_pump().
    // Without this the engine only made progress once per host display
    // frame (rAF -> bib_tick), quantizing EVERY async hop — bridge
    // completions, callOnMainThread chains, setTimeout(0) — to ~16.7ms each
    // (measured: 13.9ms per setTimeout(0) hop, 93ms for a warm same-origin
    // fetch).
    // The callback fires while the RunLoop lock is held: bibWakeUp must
    // only schedule, never call back into the engine synchronously.
    // W-B1: this EM_ASM executes in the ENGINE pthread's worker scope —
    // Module.bibWakeUp there is installed by engine-pre.js (worker-local
    // MessageChannel calling _bib_pump on this same thread), NOT the page's.
    WTF::RunLoop::setWakeUpCallback([] {
        EM_ASM({ if (Module.bibWakeUp) Module.bibWakeUp(); });
    });

    const bool interactive = MAIN_THREAD_EM_ASM_INT({ return Module.bibInteractive ? 1 : 0; });

    // M-A media bridge gate (?media=1): must be set before the first
    // MediaPlayer construction — buildMediaEnginesVector runs once and
    // caches for the session.
    BIB::g_mediaEnabled = interactive && MAIN_THREAD_EM_ASM_INT({ return Module.bibMedia ? 1 : 0; });
    if (BIB::g_mediaEnabled)
        printf("EMBEDDER: media bridge ENABLED (audio-only, bridge-fetched)\n");

    // Skia GPU boot (decision-005 G2, opt-in via Module.bibGPU / ?gpu=1).
    // Must run before ANY paint: GraphicsContextSkia consults the shared
    // PlatformDisplay. W-B2: under PROXY_TO_PTHREAD the page's #screen
    // arrives on THIS thread as an OffscreenCanvas (transferred at spawn by
    // __wrap_pthread_create) and emscripten_webgl_create_context("#screen")
    // resolves it through GL.offscreenCanvases; the single-threaded build
    // creates the context on the page canvas directly (pre-W-B1 path).
    // With the flag unset nothing here runs — the CPU path is unchanged.
    if (interactive && MAIN_THREAD_EM_ASM_INT({ return Module.bibGPU ? 1 : 0; })) {
        // W-B2 v2: back the GL context with a worker-PRIVATE OffscreenCanvas
        // (we no longer transfer #screen). Register it in emscripten's
        // GL.offscreenCanvases under "bibgpu" so create_context("#bibgpu")
        // resolves to it: findCanvasEventTarget checks GL.offscreenCanvases
        // first, and create unwraps the `.offscreenCanvas` field
        // (libhtml5_webgl.js). This runs on the engine thread (== this GL's
        // owner). The canvas is NEVER displayed — frames reach #screen via the
        // raster readback+putImageData path.
        // NOTE: no object literal here — a brace-comma ({a: x, b: y}) would be
        // split by the C preprocessor as an EM_ASM macro-arg separator (braces
        // don't group for cpp, only parens do). Build the info object with
        // dotted assignments so the only commas are paren-protected.
#ifdef __EMSCRIPTEN_PTHREADS__
        EM_ASM({
            try {
                var oc = new OffscreenCanvas($0, $1);
                var info = {};
                info.offscreenCanvas = oc;
                info.id = 'bibgpu';
                GL.offscreenCanvases['bibgpu'] = info;
            } catch (e) {
                console.error('EMBEDDER: bibgpu OffscreenCanvas create failed: ' + e);
            }
        }, kWidth, kHeight);
        const char* gpuCanvasSelector = "#bibgpu";
#else
        // BIB_PTHREAD=OFF: the engine runs on the browser main thread and owns
        // #screen's WebGL2 context directly (gpu-implicit present — the host did
        // NOT take a 2d/bitmap context). FBO 0 is the visible drawing buffer, so
        // the browser presents it implicitly; no OffscreenCanvas, no transfer.
        const char* gpuCanvasSelector = "#screen";
#endif
        if (WebCore::initializePlatformDisplayEmscripten(gpuCanvasSelector)) {
            // G4 handlers go on FIRST (Codex MEDIUM): a loss between
            // context creation and handler install would miss
            // preventDefault and be unrestorable. A loss DURING the caps
            // setup below now flags g_gpuLost; the boot then either fails
            // here (GrContext caps against a lost context) → host raster
            // reload, or the restored handler rebuilds post-boot.
            installGpuContextLossHandlers();
            // Force SkiaGLContext creation now; a null GrContext means the
            // interface/caps stage failed — fall back to CPU raster.
            auto& display = WebCore::PlatformDisplay::sharedDisplay();
            g_gpu = display.skiaGLContext() && display.skiaGrContext();
        }
        printf("EMBEDDER: gpu=%s\n", g_gpu ? "on" : "REQUESTED-BUT-UNAVAILABLE (cpu fallback)");
        if (!g_gpu) {
            // The host committed to GPU mode (no 2d context, ignores frame
            // pushes) before the engine could fail — an engine-only
            // fallback would leave the canvas permanently blank (Codex
            // HIGH, G3). Tell the host so it can reload with ?gpu=0.
            MAIN_THREAD_ASYNC_EM_ASM({ if (Module.bibGpuFallback) Module.bibGpuFallback(); });
        }
    }

    printf("EMBEDDER: init OK\n");

    // PageIdentifier: the empty-clients recipe (SVGImage) passes nullopt,
    // but Page::mediaSessionManager() hard-returns null for identifier-less
    // pages — playInternal() then parks every <audio>/<video> play() forever
    // ("returning because of interruption", M-A root cause). Real pages
    // always carry one; generating it also unlocks the default
    // PlatformMediaSessionManager factory.
    auto pageConfiguration = WebCore::pageConfigurationWithEmptyClients(WebCore::PageIdentifier::generate(), PAL::SessionID::defaultSessionID());
    pageConfiguration.chromeClient = makeUniqueRef<BIB::BibChromeClient>();
    pageConfiguration.editorClient = makeUniqueRef<BIB::BibEditorClient>();
    // browsception 2.3: real history (EmptyBackForwardClient stores nothing,
    // so traversal silently no-ops) + load-progress chrome signals.
    pageConfiguration.backForwardClient = BIB::BibBackForwardList::create();
    pageConfiguration.progressTrackerClient = makeUniqueRef<BIB::BibProgressTrackerClient>();
    // Real cookie jar over the embedder's in-memory NetworkStorageSession.
    // The empty-clients default wraps EmptyStorageSessionProvider (null
    // session): document.cookie writes vanish, reads return "" — Google
    // serves its "Cookies are disabled" interstitial on exactly that.
    pageConfiguration.cookieJar = WebCore::CookieJar::create(BIB::createEmbedderStorageSessionProvider());
    // Real in-memory localStorage/sessionStorage (root cause #11): the
    // empty-clients provider discards writes, and the WebCore-layer
    // defaults leave both window properties OFF entirely (settings flipped
    // below) — `window.localStorage` was a ReferenceError that modern site
    // bootstraps treat as fatal.
    pageConfiguration.storageNamespaceProvider = BIB::BibStorageNamespaceProvider::create();
    // Real in-process IndexedDB (root cause #13): the empty-clients
    // DatabaseProvider RELEASE_ASSERTs on idbConnectionToServerForSession —
    // any guest JS touching window.indexedDB killed that page's script
    // (discord.com/login went blank exactly there). WebKitLegacy's
    // InProcessIDBServer recipe, in-memory backing store.
    pageConfiguration.databaseProvider = BIB::BibDatabaseProvider::create();
    // Fail-fast WebSocket provider: the empty-clients SocketProvider returns
    // a null channel and WebSocket::create RELEASE_ASSERTs on it — any guest
    // `new WebSocket()` aborted the engine (discord.com/login dies on its
    // remote-auth gateway socket). This one fails the connection like an
    // unreachable server instead. A future channel over a host WebSocket
    // replaces the channel, not this wiring.
    pageConfiguration.socketProvider = BIB::BibSocketProvider::create();

    // pageConfigurationWithEmptyClients hardcodes SandboxFlags::all() on the
    // main frame (it exists for SVGImage, which must never run script) —
    // Document::initSecurityContext copies the frame's flags, silently
    // blocking ALL script regardless of Settings::setScriptEnabled. Clear
    // them for the interactive embedder; gate mode keeps SVG semantics.
    if (interactive) {
        if (auto* localParams = std::get_if<WebCore::PageConfiguration::LocalMainFrameCreationParameters>(&pageConfiguration.mainFrameCreationParameters)) {
            localParams->effectiveSandboxFlags = { };
            // Phase 4: the empty frame client silently kills real loads four
            // ways (dropped policy completions, canHandleRequest=false,
            // canShowMIMEType=false, committedLoad no-op) — install ours.
            localParams->clientCreator = [](auto&, auto& frameLoader) -> UniqueRef<WebCore::LocalFrameLoaderClient> {
                return WTF::makeUniqueRefWithoutRefCountedCheck<BIB::BibFrameLoaderClient>(frameLoader);
            };
        }
    }
    auto page = WebCore::Page::create(WTF::move(pageConfiguration));
    // Script stays OFF in gate mode so the offscreen pixel gate is
    // byte-stable; interactive mode runs JSC (CLoop) inside the page.
    page->settings().setScriptEnabled(interactive);
    page->settings().setAcceleratedCompositingEnabled(false);
    // View transitions need a compositor we don't have (Document's
    // setActiveViewTransition forces compositing mode unconditionally, which
    // used to abort the engine on youtube.com's kevlar bootstrap). The
    // startViewTransition IDL is [EnabledBySetting], so turning it off makes
    // sites feature-detect and take their plain-navigation path instead of
    // getting a half-working API. Re-enable when/if compositing lands.
    page->settings().setViewTransitionsEnabled(false);
    page->settings().setCrossDocumentViewTransitionsEnabled(false);
    // Raw WebCore defaults this to FALSE (embedders must opt in) —
    // without it CachedResourceLoader silently DEFERS every non-data:
    // image load: no request, no error event, blank <img> (root cause #8,
    // empty-defaults family).
    page->settings().setLoadsImagesAutomatically(true);
    // Raw-WebCore defaults again: LocalStorageEnabled/SessionStorageEnabled
    // are FALSE at this layer (the WebKit wrappers flip them on; we must
    // too). The window properties are IDL-gated behind these settings.
    page->settings().setLocalStorageEnabled(true);
    page->settings().setSessionStorageEnabled(true);
    // requestIdleCallback defaults FALSE at every preferences layer (same
    // family as root cause #11) although WebCore fully implements it.
    // Lazy-hydration/scheduler libraries feature-detect it; a missing
    // global silently strands their deferred work.
    page->settings().setRequestIdleCallbackEnabled(true);
    // Raw-WebCore MemoryCache default is 8MB total — one modern page evicts
    // everything, so every in-engine navigation refetched all subresources
    // over the bridge. Still in-memory; sized like a small browser profile.
    WebCore::MemoryCache::singleton().setCapacities(0, 16 * 1024 * 1024, 64 * 1024 * 1024);

    // Persistence seed (cookies + guest localStorage from a previous host
    // session, loaded out of OPFS by browser.html). Must land before the
    // first network request so the initial navigation already attaches the
    // restored cookies. Same SAB string-copy recipe as bibHTML below.
    {
        int seedBytes = MAIN_THREAD_EM_ASM_INT({ return Module.bibSeedState ? lengthBytesUTF8(Module.bibSeedState) + 1 : 0; });
        if (seedBytes > 0) {
            char* seedJSON = static_cast<char*>(malloc(seedBytes));
            if (seedJSON) {
                MAIN_THREAD_EM_ASM({ stringToUTF8(Module.bibSeedState, $0, $1); }, seedJSON, seedBytes);
                bibSeedPersistedState(String::fromUTF8(seedJSON));
                free(seedJSON);
            }
        }
    }

    RefPtr localMainFrame = page->localMainFrame();
    if (!localMainFrame) {
        printf("EMBEDDER: FAIL no localMainFrame\n");
        exit(1); // EXIT_RUNTIME=0: explicit teardown (node gate path)
    }

    localMainFrame->setView(WebCore::LocalFrameView::create(*localMainFrame, WebCore::IntSize(kWidth, kHeight)));
    localMainFrame->init();

    // Re-fetched after init(): the initial-empty-document commit already
    // ran transitionToCommittedForNewPage, which replaced the view above.
    RefPtr frameView = localMainFrame->view();
    frameView->setCanHaveScrollbars(interactive);

    if (interactive) {
        page->focusController().setActive(true);
        page->focusController().setFocused(true);
    }

    Ref loader = localMainFrame->loader();
    RefPtr documentLoader = loader->activeDocumentLoader();
    if (!documentLoader) {
        printf("EMBEDDER: FAIL no activeDocumentLoader\n");
        exit(1); // EXIT_RUNTIME=0: explicit teardown (node gate path)
    }

    // The host page may supply the document via Module.bibHTML (a JS
    // string); without it the built-in gate page loads. Copied out of the
    // JS heap via stringToUTF8 (forced into the runtime by
    // EXPORTED_RUNTIME_METHODS) into a malloc'd UTF-8 buffer.
    char* hostHTML = nullptr;
    int hostHTMLBytes = MAIN_THREAD_EM_ASM_INT({ return Module.bibHTML ? lengthBytesUTF8(Module.bibHTML) + 1 : 0; });
    if (hostHTMLBytes > 0) {
        hostHTML = static_cast<char*>(malloc(hostHTMLBytes));
        if (hostHTML)
            // Sync proxy: stringToUTF8 runs on the main thread, writing
            // through its view into the SHARED heap — visible here on return.
            MAIN_THREAD_EM_ASM({ stringToUTF8(Module.bibHTML, $0, $1); }, hostHTML, hostHTMLBytes);
        else
            printf("EMBEDDER: bibHTML allocation failed (%d bytes) — using built-in page\n", hostHTMLBytes);
    }
    const char* html = hostHTML ? hostHTML : kTestHTML;

    documentLoader->writer().setMIMEType("text/html"_s);
    documentLoader->writer().begin(URL());
    documentLoader->writer().addData(WebCore::SharedBuffer::create(unsafeMakeSpan(reinterpret_cast<const uint8_t*>(html), strlen(html))));
    documentLoader->writer().end();
    free(hostHTML);

    printf("EMBEDDER: HTML loaded\n");

    // Re-fetch: the writer-driven load above may have replaced the view too.
    frameView = localMainFrame->view();
    frameView->resize(kWidth, kHeight);
    localMainFrame->protectedDocument()->updateLayoutIgnorePendingStylesheets();

    printf("EMBEDDER: layout OK\n");

    // Render-tree dump: verifies parsing+style+layout even if glyph raster
    // fails (missing fonts paint nothing but still produce geometry).
    auto treeDump = WebCore::externalRepresentation(localMainFrame.get());
    printf("RENDER TREE:\n%s\n", treeDump.utf8().data());

    auto info = SkImageInfo::Make(kWidth, kHeight, kRGBA_8888_SkColorType, kPremul_SkAlphaType);
    sk_sp<SkSurface> surface;
    if (g_gpu) {
        // Texture-backed backing store (NOT framebuffer 0 directly: with
        // preserveDrawingBuffer off, FBO 0 is undefined after every
        // composite — dirty-rect painting needs stable pixels). Present
        // wraps FBO 0 once; samples=1/stencil=8 match the context attrs
        // (G1: GL_SAMPLES=0 with antialias:false, stencil honored at 8).
        auto* grContext = WebCore::PlatformDisplay::sharedDisplay().skiaGrContext();
        surface = SkSurfaces::RenderTarget(grContext, skgpu::Budgeted::kNo, info, 0, kTopLeft_GrSurfaceOrigin, nullptr);
        if (surface) {
            GrGLFramebufferInfo fbInfo;
            fbInfo.fFBOID = 0;
            fbInfo.fFormat = 0x8058; // GL_RGBA8
            auto target = GrBackendRenderTargets::MakeGL(kWidth, kHeight, 1, 8, fbInfo);
            g_fbo0Surface = SkSurfaces::WrapBackendRenderTarget(grContext, target,
                kBottomLeft_GrSurfaceOrigin, kRGBA_8888_SkColorType, nullptr, nullptr);
        }
        if (!surface || !g_fbo0Surface) {
            printf("EMBEDDER: gpu surface setup failed — cpu fallback\n");
            g_fbo0Surface = nullptr;
            surface = nullptr;
            g_gpu = false;
            // Same split-brain hazard as the boot-init fallback above: the
            // host is in GPU mode with no blit path — engine CPU raster
            // would never reach the screen (Codex HIGH, G3).
            MAIN_THREAD_ASYNC_EM_ASM({ if (Module.bibGpuFallback) Module.bibGpuFallback(); });
        }
        if (g_gpu) {
            // W-B2 software-renderer guard: shielded/forked browsers can
            // hand a worker OffscreenCanvas a SOFTWARE WebGL device
            // (SwiftShader/llvmpipe) — and the same browsers MASK the
            // renderer string, so don't trust it: MEASURE. Three full
            // presents with a 1x1 readback sync: real GPUs run ~1-3ms per
            // frame (G1: 0.9-1.3ms); software takes tens of ms (live
            // report: ~1 frame/MINUTE on a Chromium fork). Slow → raster,
            // which IS the better engine on that hardware.
            char rendererBuf[128] = { 0 };
            EM_ASM({
                var ctx = GL.currentContext && GL.currentContext.GLctx;
                var s = "";
                if (ctx) {
                    var ext = ctx.getExtension("WEBGL_debug_renderer_info");
                    s = String((ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER)) || "");
                }
                stringToUTF8(s.slice(0, 120), $0, 127);
            }, rendererBuf);
            uint32_t benchPixel = 0;
            auto benchInfo = SkImageInfo::Make(1, 1, kRGBA_8888_SkColorType, kUnpremul_SkAlphaType);
            // WARMUP, not measured: the first frames on a fresh context pay
            // one-time pipeline/shader compiles (G1: frame0 ≈ 100ms on real
            // hardware) — measuring them reads a healthy GPU as "software"
            // (observed: Intel UHD 630 "26.67ms/frame" on first-3-frames).
            // Software renderers stay slow on EVERY frame; that's the
            // discriminator, so bench only post-warmup steady state.
            // 8x overdraw per frame: a single fill+quad is so simple that
            // SwiftShader steady-states at ~5ms (measured) — too close to
            // real GPUs for a safe threshold. Overdraw multiplies software
            // raster cost (~40ms) while hardware barely notices (~1ms).
            for (int i = 0; i < 2; ++i) {
                surface->getCanvas()->drawColor(SK_ColorWHITE);
                for (int j = 0; j < 8; ++j)
                    surface->draw(g_fbo0Surface->getCanvas(), 0, 0);
                skgpu::ganesh::FlushAndSubmit(g_fbo0Surface.get());
            }
            g_fbo0Surface->readPixels(SkPixmap(benchInfo, &benchPixel, 4), 0, 0);
            auto benchStart = MonotonicTime::now();
            for (int i = 0; i < 3; ++i) {
                surface->getCanvas()->drawColor(SK_ColorWHITE);
                for (int j = 0; j < 8; ++j)
                    surface->draw(g_fbo0Surface->getCanvas(), 0, 0);
                skgpu::ganesh::FlushAndSubmit(g_fbo0Surface.get());
            }
            // The readback is the sync: WebGL queues are deep and flush is
            // advisory — readPixels forces completion everywhere.
            g_fbo0Surface->readPixels(SkPixmap(benchInfo, &benchPixel, 4), 0, 0);
            double msPerFrame = (MonotonicTime::now() - benchStart).milliseconds() / 3.0;
            printf("EMBEDDER: gpu renderer \"%s\" present-bench %.2fms/frame\n", rendererBuf, msPerFrame);
            // ?gpubench=0 (gate8): measure but don't enforce — playwright
            // headless IS SwiftShader, where the pipeline is correct but
            // raster is the faster engine.
            bool enforceBench = MAIN_THREAD_EM_ASM_INT({ return Module.bibGpuBench === false ? 0 : 1; });
            if (enforceBench && msPerFrame > 12.0) {
                printf("EMBEDDER: gpu looks SOFTWARE-RENDERED — cpu fallback\n");
                g_fbo0Surface = nullptr;
                surface = nullptr;
                g_gpu = false;
                MAIN_THREAD_ASYNC_EM_ASM({ if (Module.bibGpuFallback) Module.bibGpuFallback(); });
            }
        }
    }
    g_blitPixels = static_cast<uint8_t*>(malloc(static_cast<size_t>(g_fbWidth) * g_fbHeight * 4));
    g_presentPixels = static_cast<uint8_t*>(malloc(static_cast<size_t>(g_fbWidth) * g_fbHeight * 4));
    if (!g_blitPixels || !g_presentPixels) {
        printf("EMBEDDER: FAIL framebuffer alloc\n");
        exit(1); // EXIT_RUNTIME=0: explicit teardown (node gate path)
    }
    // Raster: paint DIRECTLY into g_blitPixels (SkSurfaces::WrapPixels) —
    // no per-frame readPixels, no second scroll-blit mirror. The host
    // receives PREMULTIPLIED bytes; that's fine because the root frame is
    // opaque (alpha 255 ⇒ premul == unpremul byte-for-byte) and the WebGL
    // presenter ignores alpha anyway (alpha:false context, no blending).
    if (!g_gpu)
        surface = SkSurfaces::WrapPixels(info, g_blitPixels, static_cast<size_t>(g_fbWidth) * 4);
    if (!surface) {
        printf("EMBEDDER: FAIL SkSurface\n");
        exit(1); // EXIT_RUNTIME=0: explicit teardown (node gate path)
    }

    g_engine = new Engine { WTF::move(page), WTF::move(localMainFrame), WTF::move(surface) };
    BIB::g_logicalFrameSize = bibLogicalFrameRect().size();
    // Fast-scroll shift needs g_engine. GPU mode: the CPU memmove trick is
    // moot (no g_blitPixels mirror) — a null hook makes ChromeClient::scroll
    // fall back to addDamage(clip), i.e. a clipped GPU repaint.
    BIB::g_scrollBlit = g_gpu ? nullptr : bibScrollBlit;

#ifdef __EMSCRIPTEN_PTHREADS__
    // Zero-copy GPU present handshake: tell the page which Emscripten worker is
    // the engine (proxied-main) so it can wire a dedicated MessagePort for
    // ImageBitmap frames. engine-pre.js creates the channel and transfers port2
    // to the page inside this hello (worker→main only — nothing custom crosses
    // Emscripten's worker onmessage). Only in pthread GPU mode: raster delivers
    // via bibBlit, and the BIB_PTHREAD=OFF build presents on #screen directly.
    // The page-side hook (browser.html) ignores this unless presentMode is
    // "gpu-bitmap". Sent now that the bibgpu OffscreenCanvas + both surfaces
    // exist; the first present waits for the page's first {t:"ready"} ack.
    if (g_gpu) {
        EM_ASM({
            if (Module.bibPresentWorkerHello)
                Module.bibPresentWorkerHello($0, $1);
        }, kWidth, kHeight);
    }
#endif

    // G3: guest 2D canvases on Ganesh (host defaults this ON with GPU after
    // the A/B — 600-arc anim 51.97/29.08/18.73 ms per frame cpu/gpu/this,
    // getImageData unregressed; ?canvasgpu=0 escapes).
    // CanvasUsesAcceleratedDrawing defaults FALSE for WebCore-direct
    // embedders, so without this guest canvases paint CPU-raster and
    // re-upload per draw even under GPU. Gated on the SURVIVING g_gpu
    // (after the surface fallback above): texture canvases drawn into a
    // raster window surface would read back on every draw.
    if (g_gpu && MAIN_THREAD_EM_ASM_INT({ return Module.bibCanvasGPU ? 1 : 0; }))
        g_engine->page->settings().setCanvasUsesAcceleratedDrawing(true);

    if (!paintFrame()) {
        printf("EMBEDDER: FAIL paint\n");
        exit(1); // EXIT_RUNTIME=0: explicit teardown (node gate path)
    }
    printf("EMBEDDER: paint OK\n");

    if (interactive) {
        // Browser mode: hand control to the host page's rAF loop. The unwind
        // skips the rest of main and keeps the runtime (and g_engine) alive.
        printf("EMBEDDER: interactive — runtime stays alive\n");
        MAIN_THREAD_ASYNC_EM_ASM({ if (Module.onEngineReady) Module.onEngineReady(); });
        emscripten_exit_with_live_runtime();
    }

    SkPixmap pixmap;
    if (!g_engine->surface->peekPixels(&pixmap)) {
        printf("EMBEDDER: FAIL peekPixels\n");
        exit(1); // EXIT_RUNTIME=0: explicit teardown (node gate path)
    }
    if (!writePPM("/out.ppm", pixmap)) {
        printf("EMBEDDER: FAIL writePPM\n");
        exit(1); // EXIT_RUNTIME=0: explicit teardown (node gate path)
    }

    // Gate assertions are region-specific so a fontconfig/glyph regression
    // cannot hide behind the div: the blue box and the red heading must BOTH
    // be present, independently (Codex review 2026-06-09).
    int nonWhite = 0;
    int exactBlue = 0; // #0066CC <div>, expected exactly 200x100
    int redGlyph = 0; // antialiased #CC0000 "hello" glyphs in the h1 band
    for (int y = 0; y < kHeight; ++y) {
        const uint8_t* row = static_cast<const uint8_t*>(pixmap.addr(0, y));
        for (int x = 0; x < kWidth; ++x) {
            const uint8_t r = row[x * 4], g = row[x * 4 + 1], b = row[x * 4 + 2];
            if (!(r == 0xFF && g == 0xFF && b == 0xFF))
                ++nonWhite;
            if (r == 0x00 && g == 0x66 && b == 0xCC)
                ++exactBlue;
            if (y < 76 && r > 0x90 && g < 0x60 && b < 0x60)
                ++redGlyph;
        }
    }
    printf("EMBEDDER: nonWhitePixels=%d exactBlue=%d redGlyph=%d\n", nonWhite, exactBlue, redGlyph);
    if (exactBlue != 200 * 100) {
        printf("EMBEDDER: FAIL blue div wrong size (%d != 20000)\n", exactBlue);
        exit(1); // EXIT_RUNTIME=0: explicit teardown (node gate path)
    }
    if (redGlyph < 200) {
        printf("EMBEDDER: FAIL heading glyphs missing (fonts broken?)\n");
        exit(1); // EXIT_RUNTIME=0: explicit teardown (node gate path)
    }
    printf("EMBEDDER: DONE\n");
    exit(0); // EXIT_RUNTIME=0: explicit teardown runs Module.onExit (run-embedder.cjs reads /out.ppm there)
}
