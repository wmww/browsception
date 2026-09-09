# Networking: the fetch bridge

## Design

Replaced WebKit's platform network backend (curl in WebkitWasm) with a **host-fetch bridge**: the
engine's resource loader emits abstract requests; a small trusted JS shim in the viewer performs
them with extension-privileged `fetch()` (CORS-exempt via host permissions) and streams the bytes
back into engine memory.

Why this beats the Wisp/WebSocket-proxy approach used by WebkitWasm and firefox-wasm (kept as
design rationale; the curl/wisp tier was deleted from the engine on 2026-08-13):
- **No server.** Those projects are plain web pages, so they can't escape CORS and must tunnel raw
  TCP to an external proxy. An extension can fetch anything directly. Zero infrastructure, no
  proxy-operator trust question, works offline-network-wise wherever the browser works.
- **Less wasm surface.** Deleted libcurl + libssl + nghttp2 + SOCKFS from the module — a big
  chunk of parser/TLS attack surface and binary size gone. (libcrypto stays: PAL's CryptoDigest
  uses it for SRI and friends.)
- **Better integration.** Host browser handles TLS, HTTP/2/3, connection pooling, proxies, HSTS.

Tradeoffs to be aware of:
- TLS trust moves from in-guest OpenSSL to the host browser. For our threat model that's fine
  (we already trust the host); we lose per-request cert introspection unless we add it via other
  means (deferred).
- The engine no longer sees raw sockets → anything needing non-HTTP TCP/UDP (WebRTC, custom
  protocols) is out of scope. WebSocket: bridge engine WebSocket to a host `WebSocket` — the
  extension origin can open cross-origin WS connections. (MVP: defer.)
- Request fidelity: `fetch()` can't set forbidden headers; a scoped DNR `modifyHeaders` rule
  rewrites UA/Cookie/Referer/Origin on bridge requests (see extension-platform.md). We control UA
  string per-profile.

## Where the boundary sits (important)

Bridge at the **NetworkDataTask / ResourceHandle** level — i.e. below WebKit's loader, above the
socket. Everything security-relevant in the web platform model then still runs *inside* the engine,
unchanged: same-origin policy, CORS enforcement for the nested page's own subresource/XHR/fetch
requests, CSP, mixed-content blocking, referrer policy, cookie scoping rules, redirect handling
policy. The shim never needs to understand web security — WebKit already implements it. The shim's
own guard list (below) is coarse, capability-style, and short enough to audit.

Redirects: let the engine drive them (bridge uses `redirect: 'manual'` and reports the 3xx to the
engine loader) so WebKit's redirect security logic stays in charge. If `manual` proves too lossy
(opaqueredirect limitations on the extension origin need a spike — see open-questions.md), fall
back to host-followed redirects with the final URL reported, and document the delta.

## Shim guard list (host-side, mandatory)

Applied to every bridge request, before fetch:

1. **`credentials: 'omit'` always.** The host browser's cookie jar, HTTP auth, and client certs are
   never attached. This is the single most important line in the shim: it's what prevents a
   malicious nested site from riding the user's real logged-in sessions. Enforced structurally
   (the fetch call site literally hardcodes it), not per-request.
2. **Scheme allowlist**: `https:` and `http:` only (no `file:`, `chrome-extension:`, `data:` is
   engine-internal and never hits the bridge, no `ws(s):` until WebSocket bridging lands). The
   guard must stay the *first* thing a main-frame request meets: the 2.4 native-handoff policy is
   consulted only for http(s) URLs, so a non-http(s) top-level load ends here rather than at
   `location.replace` on the real tab (security.md § Sandbox→host sinks).
3. **Private-network blocking** (default-on, per-profile override): reject hostnames that are IP
   literals in loopback/RFC1918/link-local/ULA ranges, `localhost`, `.local`, `.internal`. Known
   residual risk: DNS rebinding (fetch hides resolution) — document, and revisit if Chrome's PNA
   protections apply to extension fetches (open question). Extensions bypass much of the host
   browser's private-network protection, so this guard is on us.
4. **Bad-port blocklist**: the standard fetch bad-ports list (25, 6379, etc.) — the host fetch
   already enforces most of this; keep our own list anyway (defense in depth, and it documents
   intent).
5. **Size/time caps**: per-response max bytes and idle timeout so a nested page can't balloon the
   viewer process.
6. **Provenance**: bridge only accepts requests from the engine worker's port; the message channel
   is created by the viewer at engine boot and never exposed.

Things deliberately **not** in the shim: per-origin request policies, CORS, CSP — that's the
engine's job (see above). Keep the guard list boring.

## Cookies & credentials model

- **Isolated jar inside the engine**, persisted to OPFS under a profile namespace. The nested
  browser is logically a separate browser: separate cookies, separate localStorage/IDB, separate
  cache, separate history. This is both the security model and the honest UX ("this is a browser
  in a browser").
- Cookie header assembly happens inside WebKit (its jar) → the value rides the bridge as a plain
  header → DNR rewrites it onto the real request (Cookie is a forbidden header for fetch).
  Set-Cookie comes back in response headers — requires exposing them to the shim: fetch on an
  extension origin does surface `Set-Cookie`? **Open question**; if not readable, use DNR/
  `webRequest` `onHeadersReceived` capture or Reporting-header workaround. Must be resolved in the
  first networking spike.
- Optional future feature (explicit user action, per-site): import host cookies via `chrome.cookies`
  to "log in" the nested browser. Never automatic.

## Streaming & threading shape

Decided at 1.1 (ABI: src/abi/bib_abi.h), revising the earlier SAB-ring/Atomics-blocking sketch:
**fully async proxied-call delivery, no sync blocking anywhere.**

- Rationale: the port has no separate network thread to block — WebkitWasm deleted curl's thread
  and pumps the scheduler on the engine run loop; the WebCore-facing loader interface
  (`didReceiveResponse/Buffer/FinishLoading/Fail`) is already fully async, and sync XHR is already
  unsupported in this embedder (`loadResourceSynchronously` errors). Blocking on Atomics would add
  deadlock risk (the embedder treats blocking cross-thread calls as forbidden) for zero benefit.
- Request out: engine → `bibNetBegin(reqJson)` hook in the engine worker, which parses it,
  copies the body out and posts `{req, body}` to the bridge on the main thread. Response in: the
  bridge calls the link's `netResponse/netData/netDone/netFail/netRedirect` (strings and
  `Uint8Array`s; chunks are transferred), and the worker allocates in the heap via
  `bib_wasm_alloc`, copies, and calls the matching `bib_net_*` export with ownership transfer.
  One copy per byte, no shared memory (src/shim/bridge.mjs header for the interface).
- Backpressure: engine acks consumed chunks via `bibNetAck(id, bytes)`; the shim pauses its
  `response.body` reader when a request has ≥ `NET_WINDOW_BYTES` (4 MB) unacked in flight, so a
  fast server can't OOM the engine. Delivery is sliced to ≤64 KB per `bib_net_data` call (bounded
  engine-side copies; window stays honest against coalesced fetch chunks).

Implemented (1.2a) in `src/shim/bridge.mjs` (+ redirect-capture.mjs, bridge-rules.mjs,
engine-stub.mjs); asserted by test/tier1/bridge.test.mjs against the real extension in `src/`.
Implementation notes: `cache:'no-store'` on bridge fetches (a host-cache hit would skip webRequest
and lose Set-Cookie capture; engine has its own HTTP cache anyway); `referrer:''` + base DNR rule
strips Origin/Referer/sec-ch-ua* so the extension origin and host browser never leak when the
engine didn't send those headers; per-request DNR session rule (priority 2, exact urlFilter)
carries engine-sent Cookie/Referer/Origin and beats the base strips; webRequest capture matches on
`initiator` only (extension-page fetches carry the tab's id, so never filter on tabId).

Redirect capture, per browser (redirect-capture.mjs feature-detects; verified 2026-09-09):

- **Chrome**: 3xx entries come from **`onBeforeRedirect`**, not `onHeadersReceived`. Some
  redirects are synthesized by the network stack and receive no response headers at all (HSTS
  upgrade of a preloaded or previously-seen host, DNR redirect rules) — `redirect:'error'` still
  aborts on those, and listening only to `onHeadersReceived` reported every such load as a bare
  network failure. `onBeforeRedirect` carries the same `responseHeaders` (hop `Set-Cookie`
  included) for server redirects plus the resolved `redirectUrl`, handed to the engine as
  `Location`; `onHeadersReceived` remembers a 3xx-with-`Location` per requestId so the two
  events yield one entry. Accepted delta: a redirect Chromium refuses outright
  (`net::ERR_UNSAFE_REDIRECT`, e.g. `Location: data:…`) fires `onHeadersReceived` but never
  `onBeforeRedirect`, so it reaches the engine as a network failure — the load fails either way.
- **Firefox**: `onBeforeRedirect` never fires for a server 3xx under `redirect:'error'`, so the
  entry is complete from `onHeadersReceived` alone. A stack-synthesized redirect (dynamic HSTS)
  is `onBeforeRedirect` with `statusCode: 0` **and the same request continues to the target
  inside the same fetch** — the capture records it as the 307 Chrome reports, marks the
  requestId `continued` and drops the continuation's events; the bridge treats a redirect entry
  the same whether the fetch then rejected or *resolved* (in which case it cancels the target's
  body). The engine re-issues the target as its own request, so the jar and every origin /
  mixed-content decision see the URL actually loaded (a 200 attributed to the http URL would
  not). Repeated headers arrive as one `\n`-joined value and are split per line: the engine
  refuses a header value with a newline, which is how every multi-cookie site failed on
  Firefox. A DNR redirect on a bridge fetch fires nothing there (extension-platform.md).
- Both: `isRedirectEntry()` (3xx + `Location`) is the one predicate the bridge uses.

Two hygiene rules fall out of the same design, both tier-0 tested:

- **Keys are normalized** (`new URL(url).href` on both sides). webRequest reports the URL Chromium
  normalized (`:443` dropped, dot segments resolved, spaces/non-ASCII percent-encoded); the engine
  sends whatever string it has. WebCore happens to canonicalize the same way today, so a raw-key
  mismatch was latent — it would have cost a dropped `Set-Cookie`, an 800 ms stall (the success
  path awaits `take()`), and a redirect misread as a network failure.
- **Every request claims or discards its entry** (`capture.discard()` from `Bridge.#finish`). A
  request cancelled between the webRequest event and its `take()` used to orphan an entry, and the
  next fetch of the same URL would take it — stale `Set-Cookie` into the engine jar, or a stale 3xx
  read as a redirect. A 30 s sweep on unclaimed entries backstops whatever else leaks.

A failed top-level load is visible from **both** sides, into the same viewer error strip (retry
button; no "open natively" — that escape hatch is the popup's, ui.md):

- the bridge calls `onMainLoadFailed` for every non-cancelled `main` request failure — DNS/TLS,
  guard denials, the size cap, idle timeouts;
- the engine emits `bibChrome` `"loadfailed"` `{url, kind, message}` from `BibFrameLoaderClient`
  (`dispatchDidFailProvisionalLoad` / `dispatchDidFailLoad` / `dispatchUnableToImplementPolicy`)
  for everything WebCore refuses after or without a successful fetch — unsupported top-level MIME
  type, undisplayable hop, internal abort. `kind` is a `BIB_NET_ERR_*` value, `ENGINE` (7) when the
  refusal was the engine's own.

Two of those refusals tell *no* client at all upstream, so the patch adds the notification (see
engine-build.md § Divergences): a navigation to a blocked port / disallowed IP / local resource
returns straight out of `FrameLoader::loadFrameRequest`, and a main resource the cache layer
refuses to even start makes `DocumentLoader::loadMainResource` fall through to
`maybeLoadEmpty()` — an empty commit is the only trace. Both now dispatch a failed provisional
load first.

A bridge failure fires both; the strip just shows the last one. Cancellations are reported by
neither: superseded loads, `bib_stop`, and the policy-change unwind that follows an unshowable MIME
type would all otherwise flash a bogus error. That unwind is exactly why
`dispatchUnableToImplementPolicy` has to be hooked — it is the only non-cancellation notification
of that failure.

## What the nested site can and cannot reach (summary)

Can: fetch any public http(s) resource, as an anonymous client from the user's IP.
Cannot: the user's cookies/sessions/auth on any real site; localhost/intranet (guarded); non-HTTP
protocols; the host DOM; host storage. Residual: user's IP as origin, abuse-as-proxy (same as any
browser), DNS-rebinding gaps in guard 3.
