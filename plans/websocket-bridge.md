# Plan: guest WebSocket over a host WebSocket

## Why

Guest `new WebSocket()` fails immediately (`BibWebSocketChannel`, fail-fast by design since the
curl/wisp tier was deleted 2026-08-13). Every chat, live-update and dev-tool site degrades or
breaks (discord, slack, most "live" dashboards, HMR dev servers). The engine has exactly one
network path, the host-fetch bridge, and WebSocket is the one protocol fetch cannot carry —
but an extension page can open a host `WebSocket` to any origin (no CORS on WS,
`<all_urls>` covers ws/wss, the viewer CSP has no `connect-src`), so the bridge grows a second,
message-level channel. No new manifest permission.

## Design

**Message-level, not frame-level.** The host `WebSocket` does the handshake, framing,
masking, ping/pong and permessage-deflate; the engine channel is a thin proxy that maps
`ThreadableWebSocketChannel` calls to host calls and host events to `WebSocketChannelClient`
callbacks. WebCore's `WebSocketHandshake`/`WebSocketFrame`/`WebSocketDeflateFramer` stay
unused (they only matter for a raw-TCP transport we do not have). This is the same split as
WebKit2's `WebSocketChannel` ↔ network-process `NetworkSocketChannel`.

**Engine side** — `BibWebSocketChannel` becomes the real channel (same `BibSocketProvider`
wiring):

- `connect(url, protocol)`: `ThreadableWebSocketChannel::webSocketConnectRequest(document,
  url)` builds the handshake request exactly as WebKit does (Origin, UA, Pragma/Cache-Control
  no-cache, Sec-Fetch `websocket/websocket/<site>`); add the engine-jar Cookie via the
  document's `cookieJar().cookieRequestHeaderFieldValue(...)` (what `clientHandshakeRequest`'s
  `CookieGetter` is for). Emit `bibWsOpen(json)` with `{id, url, protocols: [...], headers:
  [[k,v],...]}`; return `OK`. Mixed-content / CSP `connect-src` / port checks already ran in
  `validateURL`.
- `send(CString)` → `bibWsSend(id, ptr, len, isText)`; `send(ArrayBuffer, off, len)` → the
  same with `isText=0`; `send(Blob&)` → read engine-side with `FileReaderLoader` (as the
  legacy in-WebCore channel did) into a per-channel FIFO so ordering with later sends holds,
  then binary send. `bufferedAmount`: count bytes handed to the host and subtract on
  `bib_ws_sent(id, bytes)` acks; `didUpdateBufferedAmount` on every change.
- `close(code, reason)` → `bibWsClose(id, code, reasonPtr)`; `fail(reason)` → console
  message + `bibWsClose(id, 1006-equivalent abort)`; `disconnect()` drops the client (no
  `didClose`) and closes the host socket.
- `suspend()`/`resume()` (bfcache-style): queue incoming events while suspended, flush on
  resume — the legacy channel's behavior; simplest correct thing.
- Host → engine exports: `bib_ws_connected(id, subprotocolPtr, extensionsPtr)` →
  `didConnect()` (the two strings answer `subprotocol()`/`extensions()`);
  `bib_ws_message(id, ptr, len, isText)` → `didReceiveMessage` / `didReceiveBinaryData`;
  `bib_ws_sent(id, bytes)`; `bib_ws_closing(id)` → `didStartClosingHandshake`;
  `bib_ws_closed(id, wasClean, code, reasonPtr)` → `didClose(unhandled, Complete|Incomplete,
  code, reason)`; `bib_ws_fail(id, kind, msgPtr)` → `didReceiveMessageError` + `didClose(…,
  Incomplete, 1006, …)`. Same self-proxy shape and ownership rules as `bib_net_*`
  (`BibNetBridge.cpp`), registry keyed by id, ids from the same counter namespace or a
  separate one — separate (`bibWs*`) keeps the two registries independent.
- Handshake-response cookies: the host cannot read them from the `WebSocket` object; they
  arrive via the webRequest capture (below) as `[["set-cookie", v], …]` in the `connected`
  JSON and go through the same `setCookiesFromResponse` path `netDidReceiveResponse` uses.

**Host side** — `src/shim/ws-bridge.mjs`, constructed next to the `Bridge` in `viewer.mjs`
(and the tier-1 `__bsBoot` stub), driven through `EngineLink` (`onWsOpen/onWsSend/onWsClose`
in, `wsConnected/wsMessage/wsSent/wsClosing/wsClosed/wsFail` out; worker marshals strings and
transfers byte buffers exactly like `netIn`/`bibNetBegin`):

- **Guard**: `evaluateRequest` gets a `kind: 'ws'` option that allows `ws:`/`wss:` (and only
  there — the fetch path keeps refusing them); the private-network, userinfo and bad-port
  rules apply unchanged (`allowPrivateNetwork` override honored). Caps: connections per
  viewer (64; a 65th fails with `GUARD`), inbound message size (64 MB → `TOO_LARGE` closes the
  socket), outbound buffered bytes (host `bufferedAmount` > 64 MB → close), idle is NOT a cap
  (idle sockets are normal). Every refusal is `bib_ws_fail` — `new WebSocket()` then fires
  `error`+`close`, like an unreachable server, never an engine abort.
- **Headers**: a host `WebSocket` from an extension page stamps `Origin:
  chrome-extension://…`, the host UA, host client hints, host Sec-Fetch — and **the host
  jar's cookies for the target site** (WebSocket has no `credentials: 'omit'`). So:
  - `bridgeCondition` grows `resourceTypes: ['xmlhttprequest', 'websocket']` and the base
    rule additionally `remove`s `cookie` — for the websocket type only (a second base rule,
    id 9002, so the fetch path's semantics are untouched: fetch never sends host cookies,
    structurally). Per-connection rule (same id ring as per-request rules, same
    `perRequestHeaderRule` shape with the exact `wss://…` URL) sets the engine's Cookie,
    Origin, UA and Sec-Fetch-\*. Verified on Chrome for fetch (`xmlhttprequest`); verify on
    both browsers for `websocket` before building (probe step 0). If Firefox cannot strip
    the host Cookie on WS handshakes, WS stays disabled on Firefox — leaking the host jar is
    the one thing the design forbids (security.md).
  - Subprotocols go through the constructor's second argument (the only way to set
    `Sec-WebSocket-Protocol`); extensions are the host's business.
  - `Authorization` from cached HTTP auth and client certs would ride too; both need a prior
    host-side interactive auth on that origin, and DNR `remove`s `authorization` as well.
    Documented residual.
- **Capture**: `RedirectCapture` listens on `types: ['xmlhttprequest', 'websocket']`; a WS
  handshake's `onHeadersReceived` (101) yields the entry; the ws-bridge `take()`s it at
  `onopen` (or `onclose`/`onerror` when the handshake failed — then it is a plain failure,
  there is no redirect following for WS). The entry's `set-cookie` values go to the engine
  in `bib_ws_connected`. `discard()` on every terminal path, as the fetch bridge does.
- **Lifecycle**: `open` → connected; `message` → transferred `ArrayBuffer` or string;
  `close` → closing (if the server initiated, i.e. we did not call close) then closed with
  `wasClean/code/reason`; `error` → fail (the browser gives no detail; `NET_ERR.NETWORK`).
  `bufferedAmount` polling is not available as an event: after each send, `queueMicrotask`
  a check of `ws.bufferedAmount` and report the delta as `wsSent` when it drains (poll every
  animation frame while nonzero; cheap, bounded). Engine cancel/close → `ws.close(code,
  reason)`; `dispose()` closes all with 1001. Viewer pagehide/crash teardown already disposes
  the bridge; do the same here.
- **Provenance/security accounting**: new hooks in `bib_abi.h` § Hooks and rows in
  security.md § Capability accounting: `bibWsOpen/Send/Close` = "open outbound WebSocket
  connections to public ws(s) origins as an anonymous client, subject to the guard list;
  never with host credentials". Sandbox→host sinks unchanged (no URL reaches a host
  navigation).

**Tests** — a fixture WS server is needed and Node 26 has no server-side WebSocket: add
`test/fixtures/ws.mjs`, a minimal RFC 6455 server on the fixture https/http ports via
`server.on('upgrade')` (handshake, unmask, text/binary/ping/pong/close frames, fragmentation
assembly; echo semantics plus `/ws/subproto` (accepts `bs.v1`), `/ws/set-cookie` (101 with
Set-Cookie), `/ws/close?code=4000`, `/ws/big` (sends N MB), `/ws/echo-headers` (first message
is the handshake headers JSON)). ~150 lines, no dependency (the deterministic zip writer set
the precedent). Chrome's `--host-resolver-rules` mapping already covers `wss://*.bstest`.

- tier-0 `ws-bridge.test.mjs`: guard kinds (ws allowed here only, private-network refused,
  connection cap), header partition into the per-connection rule, lifecycle event mapping
  with a fake `WebSocket` class, capture take/discard.
- tier-1 (`__bsBoot` stub engine, real Chrome): echo text + binary round trip; subprotocol
  negotiated; handshake `echo-headers` shows engine Cookie/Origin/UA/Sec-Fetch and NO
  extension origin, NO host cookie (seed one into the host jar for `app.bstest` first —
  the WS twin of "host jar never rides the bridge"); 101 Set-Cookie reaches the engine;
  server close code/reason delivered; `/ws/big` past the cap closes with `TOO_LARGE`;
  rules cleaned up after close; `dnr bridge rules do not touch native traffic` extended
  to a native WS.
- tier-2 (real engine): scenario 15 flips from "fails cleanly" to "guest WebSocket echoes
  text and binary, `protocol`/`extensions` populated, `close` event carries the server's
  code, `bufferedAmount` returns to 0"; a second probe keeps the old assertion for a refused
  URL (`ws://127.0.0.1:1/`: error+close, engine alive). Firefox subset: the same scenario
  or the documented skip (probe step 0).
- Real-site smoke (manual, `scripts/smoke-browse.mjs`): a site with a visible WS feature
  (discord.com/login's gateway, a Vite dev page's HMR socket).

## Steps

0. **Probe** (both browsers, `scripts/probe-firefox.mjs` style + a Chrome twin): from the
   viewer origin open `wss://app.bstest/ws/echo-headers` with (a) no rules, (b) a websocket-
   type `modifyHeaders` rule removing `cookie` and setting `origin`/`user-agent`/
   `sec-fetch-*`/`cookie`; assert on the fixture's echo. Also that `onHeadersReceived` fires
   for the 101 with `Set-Cookie` under `types: ['websocket']`. Record in extension-platform.md
   § Forbidden headers / § Firefox. Gate: host Cookie strippable on both, else Firefox WS off.
1. **Fixture** `test/fixtures/ws.mjs` + hookup in `server.mjs` (`upgrade` on both servers).
2. **ABI** — `bib_abi.h`: § WebSockets (hooks, exports, JSON shapes, ownership, caps, error
   kinds reuse `BIB_NET_ERR_*`); `abi.mjs` mirror. Additive → no version bump.
3. **Engine** — `BibWebSocketChannel.{h,cpp}` real implementation; `BibSocketProvider` unchanged;
   exports in a new `BibWsBridge.cpp` mirroring `BibNetBridge.cpp`. Rebuild, restage.
4. **Worker + link** — `engine-worker.js` hooks/marshalling; `engine-link.mjs` events/methods.
5. **Host** — `src/shim/guard.mjs` (`kind`), `src/shim/ws-bridge.mjs`, `bridge-rules.mjs`
   (websocket type, base rule 9002), `redirect-capture.mjs` (types), `viewer.mjs` + `__bsBoot`.
6. **Tests** as above; `npm test`, tier-2 both browsers.
7. **Notes** — networking.md § Design tradeoffs (WebSocket now supported; the message-level
   design) + a § WebSocket bridge section (guard, headers, caps, capture, Firefox status);
   security.md capability rows + residuals (auth/client-cert on WS handshakes); ui.md if the
   options page gains nothing (it should not); extension-platform.md probe results; testing.md
   fixture + scenario 15; README status + key decisions ("no external servers" still true);
   experiment-log entry. Retire `BibWebSocketChannel.h`'s "fail-fast" header text and the
   "Guest `new WebSocket()` now fails cleanly everywhere" README line. Delete this plan.

## Not in scope

WebTransport (stays unsupported, `initializeWebTransportSession` rejects), WebRTC, `ping`
loads, Server-Sent Events (already work: they are fetch).
