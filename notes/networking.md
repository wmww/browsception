# Networking: the fetch bridge

## Design

Replace WebKit's platform network backend (curl in WebkitWasm) with a **host-fetch bridge**: the
engine's resource loader emits abstract requests; a small trusted JS shim in the viewer performs
them with extension-privileged `fetch()` (CORS-exempt via host permissions) and streams the bytes
back into engine memory.

Why this beats the Wisp/WebSocket-proxy approach used by WebkitWasm and firefox-wasm:
- **No server.** Those projects are plain web pages, so they can't escape CORS and must tunnel raw
  TCP to an external proxy. An extension can fetch anything directly. Zero infrastructure, no
  proxy-operator trust question, works offline-network-wise wherever the browser works.
- **Less wasm surface.** Deletes curl + OpenSSL + nghttp2 + SOCKFS from the module — a big chunk of
  parser/TLS attack surface and binary size gone.
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
   engine-internal and never hits the bridge, no `ws(s):` until WebSocket bridging lands).
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

- Engine network threads block on Atomics waiting for bridge completions (pthread build); the shim
  streams `response.body` reader chunks into a SAB ring buffer → engine copies into its own heap.
  No Asyncify. Single-threaded fallback build uses callback-style async loads (WebKit's loader is
  async anyway; only sync XHR needs special handling — rare, can be emulated with a spin +
  event-pump or just unsupported in fallback mode).
- Backpressure: reader pull only when the ring has room, so a fast server can't OOM the engine.

## What the nested site can and cannot reach (summary)

Can: fetch any public http(s) resource, as an anonymous client from the user's IP.
Cannot: the user's cookies/sessions/auth on any real site; localhost/intranet (guarded); non-HTTP
protocols; the host DOM; host storage. Residual: user's IP as origin, abuse-as-proxy (same as any
browser), DNS-rebinding gaps in guard 3.
