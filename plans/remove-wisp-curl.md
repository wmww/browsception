# Remove wisp + the curl transport tier

Goal: the engine's only network path is the host-fetch bridge, in the harness exactly as in the
extension. Delete the upstream WebkitWasm transport stack — wisp dispatcher, SOCKFS sockets,
libcurl, TLS-in-engine (libssl), nghttp2 — from the code, the link, and the docs. This is the
roadmap item "Delete curl from the engine link"; superseded design is networking.md.

## Verified current state (2026-08-12)

- Resource loads (incl. media): already bridge-only. `BibMediaPlayer` fetches via
  `MediaPlayer::mediaResourceLoader()` → loader strategy → BibNetBridge — its "wisp-routed"
  comments are **stale**; the media bridge does NOT depend on curl and survives this cut.
- The only real curl consumer left is **guest WebSockets**: `BibWebSocketChannel.h` (header-only)
  over CurlStream/CurlStreamScheduler → SOCKFS → the harness wisp dispatcher. Works only in the
  dev harness; in the extension guest WS already just fails (no dispatcher).
- Still linked into the shipped 103 MB embedder.wasm: libcurl, libssl, nghttp2, the whole
  `platform/network/curl` transport, the embedded CA bundle (`BIB_CA_BUNDLE`).
- **libcrypto must stay**: PAL links `OpenSSL::Crypto` for `CryptoDigestOpenSSL.cpp` (SRI, WS
  handshake hashing, etc.). WebCrypto's OpenSSL backend was never compiled (deferred, see
  PlatformEmscripten.cmake) — dropping libssl/curl regresses nothing there. Leave
  `USE_OPENSSL ON`.
- `USE(CURL)` stays ON: it guards the port's platform types and the cookie jar, which we keep.

### Keep / trim / delete map for `platform/network/curl` (WebCore)

Verified by grepping each file for real libcurl/OpenSSL bindings:

| Keep as-is | CookieJarDB, CookieUtil, CookieStorageCurl (sqlite/self-contained cookie jar — feeds OPFS persistence), PublicSuffixStoreCurl (+libpsl — cookie-domain security), ResourceRequestCurl, ProtectionSpaceCurl, DNSResolveQueueCurl (no curl symbols — verify at link) |
| Trim (new patch hunks) | NetworkStorageSessionCurl (drop `CurlContext::singleton()` proxy/alt-svc/env-jar-path calls), ResourceResponseCurl (drop CurlResponse/CurlContext conversion — only CurlRequest called it), ResourceErrorCurl (drop CURLcode mapping), CertificateInfoCurl (drop X509/OpenSSL parsing), AuthenticationChallengeCurl (drop curl auth parsing) |
| Delete from build | CurlContext, CurlRequest(+Scheduler/Client), CurlStream(+Scheduler), CurlFormDataStream, CurlMultipartHandle, CurlProxySettings, CurlSSLHandle, CurlSSLVerifier, OpenSSLHelper, `network/emscripten/CurlSSLHandleEmscripten.cpp` |
| Headers that stay | ResourceRequest.h / ResourceResponse.h / ResourceError.h / CertificateInfo.h / AuthenticationChallenge.h / ProtectionSpace.h — they ARE the port's platform types under USE(CURL) |

## Steps

### 1. Embedder (`engine/WebkitWasm/src/embedder/`, tracked)

- Replace `BibWebSocketChannel.h` with a fail-fast channel (the WS-0 shape its header describes:
  implement ThreadableWebSocketChannel, report immediate failure/close — must NOT hit the
  upstream nullptr path, which RELEASE_ASSERTs and kills the engine). `BibSocketProvider.h`
  returns it. Guest `new WebSocket()` then fails cleanly everywhere, matching today's prod.
- `main.cpp`: drop `#include "CurlContext.h"`, the `bib_pump_network` export + `bibRunNetPump` +
  `g_netPumpQueued` + its `g_perf.netCycle/netMax` accounting (harness ws-poke only), the
  curldebug/`DEBUG_CURL`/`isVerbose()` block.
- `BibMediaPlayer.{h,cpp}`: comments only — replace the wisp/curl invariant text with "fetches
  through the guest loader strategy → host-fetch bridge (guest cookies attached)".
- `embedder.cmake`: delete the `BIB_CA_BUNDLE` embed block; fix stale comments (W-B0 wisp
  dispatcher, "future curl threads", `DEBUG_CURL` in the ENV comment).
- `EmbedderStrategies.cpp`: stale comment sweep ("curl=35 noise", "stream churn over wisp").

### 2. WebKit tree (edit `third_party/WebKit` working tree; patch re-exports on build)

- `Source/WebCore/PlatformEmscripten.cmake`: stop `include(platform/Curl.cmake)`; instead append
  the keep+trim sources and the `platform/network/curl` include dir directly. Drop
  `CURL::libcurl`, `OpenSSL::SSL`, `${NGHTTP2_LIBRARY}` from the link; keep `LibPSL::LibPSL`.
  **Keep brotli on the link**: it sits under the "libcurl transitive deps" comment but freetype
  (WOFF2) references it — naive deletion likely breaks the final link; verify, then re-comment it
  as a freetype dep.
- Apply the trim edits from the table above (they become patch hunks; the old hunks in
  CurlRequestScheduler/CurlStream/socket-poke code disappear with the deleted files — net patch
  size should shrink).
- Leave `OptionsEmscripten.cmake` flags alone (`USE_CURL ON`, `USE_OPENSSL ON`).

### 3. Dep tier + build scripts

- `tools/build-deps/curl-tier.sh`: remove the nghttp2 and curl stages; keep OpenSSL (libcrypto for
  PAL), brotli, libpsl, fontconfig. Rename to reflect contents (e.g. `ssl-tier.sh`) and update
  the header comment + `tools/build-engine.sh` step 2a (its brotli/fontconfig dep-order note and
  the preflight lib list at line ~103: `libcurl.a` → out, keep `libbrotlidec.a`).
- `tools/build-webcore.sh`: remove CA-bundle staging (lines ~50–55) and `-DBIB_CA_BUNDLE`.
- Full WebCore reconfigure + rebuild (file-list change — not the 90 s embedder loop). Main
  checkout only (worktrees.md). Sysroot keeps stale libcurl/libssl archives harmlessly; optionally
  `rm` them so a regression fails loudly at link.

### 4. Harness (`web/`)

- `browser.html`: delete the wisp dispatcher (WebSocket wrapper + `bib-sockfs` marker), the
  `Module.websocket` config, `?wisp=`/`?curldebug=` params, `scheduleNetPump` + its ws listeners,
  `__bibWispBytes`/`__bibStreamBytes` accounting and the #78 perflog byte dump, the wisp-client
  script tag; update the header comment ("navigates to a REAL page over Wisp") and the media
  WISP-INVARIANT comment (now: bridge-fetched).
- Delete `web/vendor/wisp-client.js`.
- `engine-pre.js` is clean (pump only) — no change.

### 5. Verify

- Rebuild, `node tools/stage-engine.mjs`, then: `npm test`, `npm run test:tier2`,
  `node tools/smoke-bridge.mjs`, `node tools/smoke-mvp.mjs`. Tier-2 exercises cookie
  persistence — the jar trim (step 2) is the riskiest edit.
- Guest-WS regression check: a page doing `new WebSocket("wss://...")` gets a clean error event,
  no engine abort (harness + extension; worth a tier-2 scenario since nothing covers it).
- Media still works in the harness (`?media=1` audio) — proves the "media never needed curl"
  reading, and that node gate mode still boots (no CurlContext init left anywhere).
- Record the new embedder.wasm size and patch stats in engine-build.md.

### 6. Docs / notes

- engine-build.md: build-config table row (drop curl+OpenSSL+Wisp networking → "host-fetch bridge;
  libcrypto for PAL digest"), sizes, divergence breakdown, fork-state para, opening line
  ("Wisp networking, TLS in-engine").
- engine.md ("deletable in one cut" — mark done), networking.md (wisp comparison stays as design
  rationale; fix any "still linked" claims), LICENSING.md provenance line, viewer.mjs line-6
  comment ("no wisp" → historical), tools/smoke-bridge.mjs comments.
- roadmap.md: delete the curl-link item; keep "WebSocket bridging (engine-side, over host WS)" as
  the future path — after this cut it's the ONLY path to guest WS. Optional follow-up note:
  libcrypto could go too if PAL CryptoDigest gets a small vendored SHA/MD5 backend.
- Delete this plan when done.

## Risks / verify-before-relying

- **brotli link ordering** (freetype WOFF2) — check before deleting from WebCore_LIBRARIES.
- **DNSResolveQueueCurl** — greps show no curl symbols, but confirm at link; stub if wrong.
- **Cookie-jar trim** — NetworkStorageSessionCurl's CurlContext calls are proxy/alt-svc config;
  make sure nothing embedder-side calls `setProxySettings` (grep first).
- WebSocketHandshake/Frame/DeflateFramer stay compiled in WebCore (upstream, harmless; the future
  bridge-WS channel will reuse them — that was the point of BibWebSocketChannel's design).
