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
 *  - JS → engine: EMSCRIPTEN_KEEPALIVE extern "C" exports, FIRE-AND-FORGET
 *    unless noted (request/response pairs use an id + a result hook). Calls
 *    made before main() are dropped. Shipping (plain) link: the engine runs
 *    on the host Worker's one thread (src/ext/engine-worker.js), the viewer
 *    posts each call as a message and the worker calls the export directly.
 *    Proxy link (-sPROXY_TO_PTHREAD, kept buildable): every export
 *    self-proxies onto the engine pthread.
 *  - engine → JS: calls to hooks installed on Module. All hooks are [host]
 *    hooks: in the plain link every EM_ASM (MAIN_THREAD_* included — they
 *    are plain synchronous EM_ASM without pthreads) runs in the Worker's
 *    scope on the Worker's Module, which forwards to the viewer by message.
 *    In the proxy link MAIN_THREAD_ASYNC_EM_ASM hooks land on the page's
 *    Module and plain-EM_ASM ones on the engine pthread's worker Module
 *    (installed by the pre-js); see the per-hook notes at the bottom.
 *
 * Ownership of pointer arguments (the host end that speaks pointers is the
 * worker, src/ext/engine-worker.js; the bridge and viewer only see bytes and
 * strings):
 *  - engine → JS (hook args): engine mallocs, JS reads/copies, then JS calls
 *    _bib_wasm_free(ptr). Every pointer handed to a hook must be freed by JS.
 *  - JS → engine (export args): JS allocates via _bib_wasm_alloc, writes,
 *    passes the pointer; ownership transfers to the engine, which frees after
 *    consuming. `const char*` export args are ccall-marshalled strings — no
 *    manual allocation.
 *
 * Coordinates — ONE unit crosses this ABI in either direction: framebuffer
 * DEVICE pixels. Viewport size, the bibFrame dirty box and every input
 * position are device px; the host converts its CSS px to device px with the
 * canvas backing/CSS ratio, and the engine converts device px to the LOGICAL
 * (CSS-at-this-dpr) pixels WebCore works in, because only the engine knows
 * the dpr actually in force. Sizes/positions are device px; wheel DELTAS are
 * the exception and are logical px, as the DOM reports them. At dpr 1 the two
 * spaces coincide, so a mix-up here is invisible until someone runs at dpr 2
 * — test/tier2/hidpi.test.mjs is the tripwire.
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

/* Heap scratch allocation (plain malloc/free; never proxied). See ownership
 * rules at the top. */
char* bib_wasm_alloc(int size);
void bib_wasm_free(char* ptr);

/* Signals that the host has consumed the band handed to bibFrame; until then
 * the engine paints no new frame (damage coalesces). Called by the bibFrame
 * wrapper itself right after the handler returns, unless the handler
 * returned true — then the host owns the call (the worker host makes it once
 * the main thread has actually presented the transferred band). */
void bib_present_done(void);

/* There is deliberately NO shutdown/destroy export: the engine runtime is not
 * teardown-safe. Kill = terminate the Worker (viewer-side), then boot a
 * fresh instance. */

/* ========================================================================
 * Input (JS → engine)
 * ========================================================================
 * Positions are framebuffer DEVICE pixels: the shim maps CSS px → device px
 * (backing/CSS ratio) and the engine maps device px → logical px (÷ its live
 * dpr) before hit-testing. All input exports are fire-and-forget.
 *
 * COALESCING: positional input (bib_wheel, bib_mouse_move) may be merged
 * while the engine is behind — consecutive wheels summed into one event,
 * consecutive moves reduced to the latest position — so the guest can see
 * fewer events than were sent (real browsers batch wheel the same way). The
 * merge never crosses another input event, and never applies to keys or
 * buttons: relative order and every discrete event are preserved. Plain
 * link: the viewer does it (one summed wheel / latest move per rAF tick,
 * flushed before any discrete event); the worker runs calls in arrival
 * order. Proxy link: the engine's queued task packs merge the same way.
 * Callers that need an event delivered on its own (a synthetic gesture under
 * test) get that by not sending another one before the engine drains. */

#define BIB_MOD_SHIFT 1
#define BIB_MOD_CTRL 2
#define BIB_MOD_ALT 4
#define BIB_MOD_META 8

/* bib_key `type` values (WebKit PlatformKeyboardEvent mapping): a printable
 * keydown is sent as RAWDOWN followed by CHAR carrying the text. */
#define BIB_KEY_RAWDOWN 0
#define BIB_KEY_UP 1
#define BIB_KEY_CHAR 2

void bib_mouse_move(double deviceX, double deviceY, int modifierBits);
/* button: 0 = left, 1 = middle, 2 = right (DOM MouseEvent.button). */
void bib_mouse_button(int down, int button, double deviceX, double deviceY,
                      int clickCount, int modifierBits);
/* The position is device px like every other one; the DELTAS are logical
 * (CSS) px in DOM sign convention (positive = down/right) — pass
 * e.deltaX/deltaY through unscaled, the engine negates for WebCore
 * internally. Scrolling happens inside the engine. */
void bib_wheel(double deviceX, double deviceY, double deltaX, double deltaY,
               int modifierBits);
/* Returns an optimistic 1 (cross-thread; real consumption is async). */
int bib_key(int type, const char* key, const char* code, const char* text,
            int windowsVirtualKeyCode, int isAutoRepeat, int modifierBits);
/* Page focus/blur (FocusController activation). v1 engines may no-op. */
void bib_set_focus(int focused);

/* Editing ops (host → engine). json {"op": str, ...}; bytes/len an optional
 * payload the op's JSON indexes into (ownership → engine, JS allocates via
 * bib_wasm_alloc; NULL/0 when none). Unknown ops are ignored. Ops:
 *   {"op":"copy"} / {"op":"cut"}   run the editor's Copy/Cut command (the
 *        guest's copy/cut event first); what lands on the pasteboard comes
 *        back as a bibChrome "clipboard" signal. The engine key map runs the
 *        same commands for Ctrl/Cmd+C/X, Ctrl+Insert, Shift+Delete.
 *   {"op":"paste", "plain": bool, "items":[...]}  replace the engine
 *        pasteboard with the host clipboard (no "clipboard" echo), then run
 *        Paste / PasteAsPlainText: the guest's paste event sees the items and
 *        can preventDefault the insertion. Items: {"type","text"} or
 *        {"type","name","off","len"} naming a range of `bytes` (images).
 *        The ONLY way host clipboard data enters the engine: the host sends
 *        it from its own paste event (a user gesture), never on its own.
 * Reserved (plans/text-input.md): composition, commit, delete, select. */
void bib_edit(const char* json, char* bytes, int len);

/* Reserved for fast-follow (declared so names are stable, may be absent in
 * v1 builds): touch. */

/* ========================================================================
 * Networking — the fetch bridge (both directions)
 * ========================================================================
 * Design: notes/networking.md. The engine's loader emits requests through the
 * bibNetBegin hook; the worker host forwards them (bytes + parsed JSON) to the
 * bridge on the main thread, which guards + fetches them and streams results
 * back through the bib_net_* exports (worker-marshalled). Everything is async on the engine
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

/* Load-failure kinds: bib_net_fail (1-6, shim → engine) and the bibChrome
 * "loadfailed" signal (any of them, engine → shim). */
#define BIB_NET_ERR_GUARD 1     /* refused by the shim guard list */
#define BIB_NET_ERR_NETWORK 2   /* fetch/transport failure */
#define BIB_NET_ERR_TIMEOUT 3   /* idle timeout (guard cap) */
#define BIB_NET_ERR_TOO_LARGE 4 /* response cap exceeded (guard cap) */
#define BIB_NET_ERR_CANCELLED 5 /* engine cancelled via bibNetCancel */
#define BIB_NET_ERR_PROTOCOL 6  /* malformed/unexpected response */
#define BIB_NET_ERR_ENGINE 7    /* engine refused the load itself (unsupported
                                 * top-level MIME type, undisplayable hop,
                                 * internal abort). "loadfailed" only — never a
                                 * bib_net_fail argument. */

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
 * [host]   plain link: the Worker's Module (src/ext/engine-worker.js),
 *          called synchronously; proxy link: the page's Module, delivered
 *          via MAIN_THREAD_ASYNC_EM_ASM.
 * [worker] installed by the pre-js next to the engine (both links).
 *
 * bibNetBegin(reqJsonPtr)                       [host]  request out (above)
 * bibNetCancel(reqId)                           [host]  abort in-flight fetch
 * bibNetAck(reqId, bytes)                       [host]  chunk consumed (flow)
 * bibFrame(fbPtr, fbW, fbH, strideBytes,        [host]  frame ready (RGBA8888,
 *          dirtyX, dirtyY, dirtyW, dirtyH)              row 0 = top). The
 *          engine treats the frame as in flight until _bib_present_done():
 *          the wrapping EM_ASM calls it right after the handler returns,
 *          unless the handler returns `true` to take ownership and call it
 *          later (the worker host does, after the main thread presented).
 *          Plain link: the handler runs synchronously on the engine thread
 *          and fbPtr is the LIVE framebuffer — copy the band out before
 *          returning; nothing can mutate it during the call. Proxy link:
 *          fbPtr is a present SNAPSHOT the engine filled before posting and
 *          will not touch again until _bib_present_done() — reading the live
 *          framebuffer across threads was the scroll-up duplicated-band tear
 *          (fixed 2026-08-15). Do NOT free fbPtr.
 * bibChrome(kind, json)                         [host]  chrome signal. Unlike
 *          the other hooks, both args arrive as JS STRINGS (decoded + freed
 *          engine-side, bibPersist-style delivery). kinds:
 *          "title" {"title"}
 *          "url" {"url","canGoBack","canGoForward","kind","index","length"}
 *                kind: what the navigation did to the back/forward list —
 *                "new" (entry appended) | "replace" (current entry
 *                overwritten: replaceState, client redirect) | "traverse"
 *                (back/forward) | "reload". index = current entry's position,
 *                length = entry count; together they let the host mirror the
 *                engine's history into the real tab's session history. On a
 *                "new" cross-document load the commit signal fires before the
 *                entry is added, so index (like canGoBack) is one navigation
 *                stale until the didFinishLoad re-emit.
 *          "progress" {"p": 0..1}    "cursor" {"cursor": css-name}
 *          "hover" {"url"|null}      "favicon" {"ptr","len","mime"} (bytes
 *          engine-malloc'd, JS frees)
 *          "loadfailed" {"url","kind","message"}
 *                a TOP-LEVEL load died and the committed document stayed on
 *                screen. kind is a BIB_NET_ERR_* value: 1-6 when the failure
 *                came back through bib_net_fail, BIB_NET_ERR_ENGINE when the
 *                engine itself refused it. Cancellations (superseded loads,
 *                bib_stop, policy-change unwinds) are NOT reported. Bridge
 *                failures reach the shim twice — once here, once from the
 *                shim's own fetch — deliberately: the two paths cover each
 *                other's blind spots and the host renders the last one.
 *          "clipboard" {"items":[{"type","text"} | {"type","name","ptr","len"}]}
                the engine pasteboard changed from inside (Copy/Cut, a guest
                copy handler's setData, execCommand('copy'),
                navigator.clipboard writes): at most one per bib_tick, the
                store's whole content. Binary items are engine-malloc'd — JS
                copies ptr/len out and frees each. The host writes it to the
                real clipboard only under a fresh user activation.
          reserved (fast-follows): "open", "download", "dialog", "caret"
 * bibQueryResult(queryId, jsonPtr)              [host]  bib_query answer
 * bibPersist(jsonPtr)                           [host]  storage snapshot to
 *          persist (until storage moves fully to engine-side OPFS)
 * bibReady()                                    [host]  boot complete; safe to
 *          call exports (replaces legacy onEngineReady)
 * bibWakeUp()                                   [worker] RunLoop wake request
 * bibArmTimer(ms)                               [worker] RunLoop timer arm
 *
 * All string hook args are engine-malloc'd UTF-8 freed by JS (rules above).
 */

#endif /* BIB_ABI_H */
