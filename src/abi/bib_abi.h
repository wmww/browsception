/* bib_abi.h — the versioned engine ⇄ shim ABI (Phase 1.1).
 *
 * Single source of truth for everything that crosses the wasm boundary between
 * the engine (WebKit embedder, engine/WebkitWasm/src/embedder/) and the
 * trusted JS shim (src/shim/). The JS mirror of the constants below lives in
 * src/abi/abi.mjs; test/tier0/abi.test.mjs asserts the two stay in sync.
 *
 * Model (matches the existing embedder's conventions — see
 * notes/engine.md § integration seams and the 1.1 survey):
 *
 *  - JS → engine: EMSCRIPTEN_KEEPALIVE extern "C" exports. Every export
 *    self-proxies onto the engine pthread and is FIRE-AND-FORGET unless noted
 *    (return values cannot cross the proxy; request/response pairs use an id +
 *    a result hook instead). Calls made before main() are dropped.
 *  - engine → JS: calls to hooks installed on Module, via
 *    MAIN_THREAD_ASYNC_EM_ASM ([page] scope) or plain EM_ASM ([worker] scope
 *    — the engine pthread's worker global, installed by the pre-js). The
 *    scope annotation is load-bearing: page hooks land in the viewer,
 *    worker hooks land next to the engine.
 *
 * Ownership of pointer arguments (wasm heap is shared memory; both sides can
 * read it):
 *  - engine → JS (hook args): engine mallocs, JS reads/copies, then JS calls
 *    _bib_wasm_free(ptr). Every pointer handed to a hook must be freed by JS.
 *  - JS → engine (export args): JS allocates via _bib_wasm_alloc (thread-safe,
 *    runs on the caller's thread), writes, passes the pointer; ownership
 *    transfers to the engine, which frees after consuming. `const char*`
 *    export args are ccall-marshalled strings (copied by the proxy pack) —
 *    no manual allocation.
 *
 * Security: every hook here is a capability an owned engine holds. Additions
 * require a matching line in notes/security.md § capability accounting.
 */

#ifndef BIB_ABI_H
#define BIB_ABI_H

#define BIB_ABI_VERSION 1

/* ========================================================================
 * Boot configuration
 * ========================================================================
 * The shim sets `Module.bibConfig` (a JSON string) before loading
 * embedder.js. The engine reads it exactly once, at the top of main(), with a
 * single blocking MAIN_THREAD_EM_ASM (replacing the legacy per-flag
 * Module.bib* boolean reads). Keys, all optional:
 *   url        initial URL to load after boot
 *   width      viewport width,  device px (default 800)
 *   height     viewport height, device px (default 600)
 *   dpr        devicePixelRatio (default 1.0)
 *   userAgent  UA string for the nested profile
 *   dev        1 = enable dev-only surface (bib_query kind "eval", verbose log)
 */

#ifdef __cplusplus
extern "C" {
#endif

/* ========================================================================
 * Lifecycle & scheduling (JS → engine)
 * ======================================================================== */

/* Returns BIB_ABI_VERSION. The one export that is NOT proxied: pure constant,
 * callable from any thread, including before main(). The shim must check this
 * before using anything else. */
int bib_abi_version(void);

/* rAF-cadence tick: run-loop cycle + rendering update + frame push. */
void bib_tick(void);

/* Run-loop cycle only (event-driven wake-ups; paired with bibWakeUp). */
void bib_pump(void);

/* Navigate the main frame. Scheme policy is the shim's job (guard list);
 * the engine loads what it is told. */
void bib_load_url(const char* url);

void bib_stop(void);
void bib_reload(void);
/* Back/forward: delta -1 = back, +1 = forward (BackForwardList traversal). */
void bib_go(int delta);

/* Flush cookie jar / storage to the persistence hook now (pagehide). */
void bib_persist_now(void);

/* Visibility hint: 0 = hidden (engine may throttle timers/paint), 1 = shown.
 * v1 engines may no-op. */
void bib_set_visible(int visible);

/* Viewport resize, device pixels. Engine reallocates its framebuffer,
 * resizes the frame view, and answers with a full-frame bibFrame. */
void bib_set_viewport(int widthPx, int heightPx, double dpr);

/* Shared-heap scratch allocation (thread-safe, runs on the calling thread —
 * NOT proxied). See ownership rules at the top. */
char* bib_wasm_alloc(int size);
void bib_wasm_free(char* ptr);

/* There is deliberately NO shutdown/destroy export: the engine runtime is not
 * teardown-safe under PROXY_TO_PTHREAD. Kill = terminate the workers and
 * drop the Module (viewer-side), then boot a fresh instance. */

/* ========================================================================
 * Input (JS → engine)
 * ========================================================================
 * Coordinates are framebuffer device pixels (the shim maps CSS px → device px
 * before injecting). All input exports are fire-and-forget. */

#define BIB_MOD_SHIFT 1
#define BIB_MOD_CTRL 2
#define BIB_MOD_ALT 4
#define BIB_MOD_META 8

/* bib_key `type` values (WebKit PlatformKeyboardEvent mapping): a printable
 * keydown is sent as RAWDOWN followed by CHAR carrying the text. */
#define BIB_KEY_RAWDOWN 0
#define BIB_KEY_UP 1
#define BIB_KEY_CHAR 2

void bib_mouse_move(double x, double y, int modifierBits);
/* button: 0 = left, 1 = middle, 2 = right (DOM MouseEvent.button). */
void bib_mouse_button(int down, int button, double x, double y, int clickCount,
                      int modifierBits);
/* Wheel deltas in DOM sign convention (positive = down/right); the engine
 * negates for WebCore internally. Scrolling happens inside the engine. */
void bib_wheel(double x, double y, double deltaX, double deltaY,
               int modifierBits);
/* Returns an optimistic 1 (cross-thread; real consumption is async). */
int bib_key(int type, const char* key, const char* code, const char* text,
            int windowsVirtualKeyCode, int isAutoRepeat, int modifierBits);
/* Page focus/blur (FocusController activation). v1 engines may no-op. */
void bib_set_focus(int focused);

/* Reserved for fast-follow (declared so names are stable, may be absent in
 * v1 builds): composition/IME events, touch. */

/* ========================================================================
 * Networking — the fetch bridge (both directions)
 * ========================================================================
 * Design: notes/networking.md. The engine's loader emits requests through the
 * [page] hook bibNetBegin; the shim guards + fetches them and streams results
 * back through the bib_net_* exports. Everything is async on the engine
 * run loop (this port has no separate network thread; sync XHR remains
 * unsupported). One request id maps to exactly one terminal event:
 * bib_net_done, bib_net_fail, or bib_net_redirect.
 *
 * Request JSON (engine → JS via bibNetBegin, engine-malloc'd):
 *   { "id": int, "method": str, "url": str,
 *     "headers": [[name, value], ...],       // includes engine-jar Cookie
 *     "bodyPtr": int, "bodyLen": int }       // 0/0 when no body
 * JS copies the body bytes out of HEAPU8, then frees bodyPtr and the JSON
 * pointer. The Cookie header must never be set on fetch() directly (forbidden
 * header) — the shim transports it via a scoped DNR session rule.
 *
 * Response headers JSON (JS → engine, ownership → engine):
 *   { "status": int, "statusText": str, "url": str,
 *     "headers": [[name, value], ...] }      // includes captured Set-Cookie
 * Bodies are delivered DECODED (the host fetch stack decompresses); the shim
 * strips content-encoding/content-length/transfer-encoding so the engine
 * never tries to re-decode or trust a stale length.
 *
 * Redirects are ENGINE-DRIVEN (bridge-probe decision 1): the shim fetches
 * with redirect:'error', recovers the 3xx (status/Location/Set-Cookie) from
 * its webRequest capture, and reports it via bib_net_redirect. The engine
 * applies its own redirect policy + jar updates and issues the next hop as a
 * fresh request with a fresh id.
 *
 * Flow control: after the engine consumes a bib_net_data chunk it emits
 * bibNetAck(id, bytes); the shim keeps at most BIB_NET_WINDOW_BYTES unacked
 * in flight per request before pausing its body reader. */

#define BIB_NET_WINDOW_BYTES (4 * 1024 * 1024)

/* bib_net_fail error kinds. */
#define BIB_NET_ERR_GUARD 1     /* refused by the shim guard list */
#define BIB_NET_ERR_NETWORK 2   /* fetch/transport failure */
#define BIB_NET_ERR_TIMEOUT 3   /* idle timeout (guard cap) */
#define BIB_NET_ERR_TOO_LARGE 4 /* response cap exceeded (guard cap) */
#define BIB_NET_ERR_CANCELLED 5 /* engine cancelled via bibNetCancel */
#define BIB_NET_ERR_PROTOCOL 6  /* malformed/unexpected response */

/* headersJson ownership → engine (JS allocates via bib_wasm_alloc). */
void bib_net_response(int reqId, char* headersJson);
/* Chunk ownership → engine. */
void bib_net_data(int reqId, char* bytes, int len);
/* metricsJson nullable, ownership → engine. Terminal. */
void bib_net_done(int reqId, char* metricsJson);
/* messageUtf8 nullable, ownership → engine. Terminal. */
void bib_net_fail(int reqId, int errKind, char* messageUtf8);
/* 3xx recovered from webRequest capture; headers include location and any
 * set-cookie values. Ownership → engine. Terminal for reqId. */
void bib_net_redirect(int reqId, int status, char* headersJson);

/* ========================================================================
 * Query — async request/response channel (JS → engine → JS)
 * ========================================================================
 * Backs the __bs dev/test hook (notes/testing.md) and runtime metrics.
 * Result arrives via bibQueryResult(queryId, jsonPtr). Kinds (v1):
 *   "text"     → {"text": str}          innerText walk of the main frame
 *   "state"    → {"url","title","phase"} load phase: idle|loading|complete
 *   "metrics"  → engine counters (frames, net, memory) — shape may grow
 *   "eval"     → {"value": str} — DEV BUILDS ONLY; must be compiled out of
 *                release along with the rest of the dev surface.
 */
void bib_query(int queryId, const char* kind, const char* argJson);

/* DEV BUILDS ONLY: hard-abort on the engine thread. Exercises the crash →
 * abort → host teardown/reload path (tier-2 scenario 12) without waiting for
 * a real crash. Compiled out of release with the rest of the dev surface. */
void bib_crash(void);

#ifdef __cplusplus
} /* extern "C" */
#endif

/* ========================================================================
 * Hooks (engine → JS, on Module) — names + scopes
 * ========================================================================
 * [page]   installed by the viewer, delivered via MAIN_THREAD_ASYNC_EM_ASM.
 * [worker] installed by the pre-js in the engine pthread's worker scope.
 *
 * bibNetBegin(reqJsonPtr)                       [page]  request out (above)
 * bibNetCancel(reqId)                           [page]  abort in-flight fetch
 * bibNetAck(reqId, bytes)                       [page]  chunk consumed (flow)
 * bibFrame(fbPtr, fbW, fbH, strideBytes,        [page]  frame ready; fbPtr is
 *          dirtyX, dirtyY, dirtyW, dirtyH)              a stable heap buffer
 *          (RGBA8888, row 0 = top) valid until the next bib_set_viewport;
 *          the viewer uploads the dirty box at rAF straight from the heap
 *          view (the heap is a SAB in pthread builds). Do NOT free fbPtr.
 * bibChrome(kindPtr, jsonPtr)                   [page]  chrome signal; kinds:
 *          "title" {"title"}         "url" {"url","canGoBack","canGoForward"}
 *          "progress" {"p": 0..1}    "cursor" {"cursor": css-name}
 *          "hover" {"url"|null}      "favicon" {"ptr","len","mime"} (bytes
 *          engine-malloc'd, JS frees)
 *          reserved (fast-follows): "open", "download", "dialog", "caret"
 * bibQueryResult(queryId, jsonPtr)              [page]  bib_query answer
 * bibPersist(jsonPtr)                           [page]  storage snapshot to
 *          persist (until storage moves fully to engine-side OPFS)
 * bibReady()                                    [page]  boot complete; safe to
 *          call exports (replaces legacy onEngineReady)
 * bibWakeUp()                                   [worker] RunLoop wake request
 * bibArmTimer(ms)                               [worker] RunLoop timer arm
 *
 * All string hook args are engine-malloc'd UTF-8 freed by JS (rules above).
 */

#endif /* BIB_ABI_H */
