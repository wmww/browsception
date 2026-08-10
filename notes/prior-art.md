# Prior art

Survey as of 2026-08-09. Headline: the core premise (real browser engine in wasm, nested in a
browser) was proven **twice in June–July 2026**, but nobody has shipped it **as an extension** with
full navigation takeover. That combination is unclaimed. The two proven halves:

1. Engine-in-wasm-to-canvas exists (firefox-wasm, WebkitWasm).
2. "Wasm runtime renders foreign content to canvas, shipped as an extension" is production-proven
   (Ruffle, CheerpJ Applet Runner) — but only as in-page polyfills, not navigation takeover.

## Real browser engines compiled to wasm

### WebkitWasm (theogbob, June 2026) — our starting point
- https://github.com/theogbob/WebkitWasm
- Custom `PORT=Emscripten` of upstream WebKit. Embeds **WebCore directly, WebKit1-style,
  single-process** — bypasses the WebKit2 UIProcess/WebProcess/NetworkProcess machinery entirely.
- JSC in **CLoop** interpreter mode (`ENABLE_JIT=OFF`). Skia rendering (currently presents via a
  WebGL2/Ganesh context; CPU raster is a supported upstream config we'd switch to).
- Networking: WebKit's real **curl backend** (curl 8.17 + OpenSSL 3.5 + nghttp2) over Emscripten
  SOCKFS, transported via **Wisp** (TCP-mux-over-WebSocket) to an external proxy. TLS terminates
  inside the guest.
- Cookies/localStorage persisted to OPFS.
- Two branches: pthreads + `PROXY_TO_PTHREAD` (needs COOP/COEP; renders from a worker via
  OffscreenCanvas) and a single-threaded `non-pthread` branch (~109 MotionMark, but guest JS blocks
  the tab).
- Loads real sites including a live Discord session. Video incomplete. ~11 GB build tree.
- Research prototype: no hosted demo, small star count, ported substantially with LLM agents (~$5k).

### firefox-wasm (HeyPuter/Puter Labs, July 2026)
- https://github.com/HeyPuter/firefox-wasm — demo: https://developer.puter.com/labs/firefox-wasm/
- Writeup: https://simonwillison.net/2026/Jul/16/firefox-in-webassembly/
- Full **Gecko + SpiderMonkey + Firefox UI** via Emscripten. ~233 MB `gecko.wasm`. Requires JSPI.
- Gecko chosen over Chromium specifically for its viable single-process mode (Fission disabled).
- Same networking answer: Wisp to a Puter-hosted proxy, TLS inside the guest (wasm OpenSSL).
- Experimental SpiderMonkey→wasm JIT behind a flag; unstable, "not usable on many websites."
- MPL-2.0, active, working public demo. Ported largely by Claude agents (~$25k in tokens).
- Relevance: existence proof + the lowest-effort fork path if we ever abandon WebKit.

### Others
- **Puter × Ladybird port** (June 2026): tweet/screenshot only, never released. Precursor stunt to
  firefox-wasm. https://x.com/HeyPuter/status/2065114471589089729
- **webkit.js** (Trevor Linton, 2014): WebCore→asm.js ancestor. No networking, abandoned 2018.
  https://github.com/trevorlinton/webkit.js
- **Kitesurf** (Cloudflare, announced 2026-08-06): new Rust engine (Blitz DOM + Stylo CSS + Parley
  text + Boa JS) compiled to wasm — but runs **server-side** in Workers, speaks CDP. 215k+ WPT
  subtest passes, no video/WebGL. Open-sourcing promised. **Watch this** — if it lands open-source
  with client-side support it could become a lighter nested engine option.
  https://blog.cloudflare.com/kitesurf/
- Verified negatives: no wasm port exists of Blink/Chromium (impossible — see engine.md), Servo,
  Ladybird/LibWeb, NetSurf, litehtml, Ultralight, lexbor, or Flow. The lightweight-engine lane is
  empty.

## Emulation-based approaches (whole OS in browser, browser inside)

- **oldweb.today** (Webrecorder) — the strongest "more than a demo" precedent. Fully client-side:
  Basilisk II (classic MacOS + Netscape/Mosaic/IE) and a v86 fork (Win98 + IE5/6) in wasm. Network
  stack: **picotcp compiled to wasm in a worker**, guest HTTP rewritten to Wayback Machine URLs or a
  live CORS proxy. Its worker/SAB networking topology is directly relevant to us.
  https://github.com/oldweb-today/oldweb-today
- **v86** (copy.sh) — active; official images run Firefox 2/IE6/Opera in emulated x86 at late-90s
  speeds. Probably the source of "browser in a browser" screenshots. https://copy.sh/v86/
- **WebVM / CheerpX** (Leaning Tech) — x86 Linux + Xorg fully client-side; production product; no
  browser-inside demo published. https://webvm.io
- **anuraOS** (Mercury Workshop) — v86-based web desktop; lasting contribution is the **Wisp
  protocol** ecosystem everyone now uses. https://github.com/MercuryWorkshop/wisp-protocol
- Boxedwine (Wine in wasm), JSLinux, Infinite Mac, container2wasm/qemu-wasm: substrates exist, no
  meaningful browser-inside-browser use.

## Extension precedents (wasm renders foreign content to canvas)

- **Ruffle** (Flash, Rust→wasm) — gold standard. Content script polyfills `<object>/<embed>` via
  `replaceWith()` + MutationObserver; direct `.swf` navigations captured via **DNR responseHeaders
  matching (Chromium 128+)**. Renders wgpu-over-WebGL with canvas-2D fallback. Very active.
  Caveat vs us: it's an in-page polyfill — the host page still parses and runs.
  https://github.com/ruffle-rs/ruffle
- **CheerpJ Applet Runner** — JVM in wasm, replaces `<applet>` tags, renders Swing via mixed
  DOM/canvas. ~80k users. Documented MV3 pain: install-time host permissions broke "enable once,
  run everywhere" → per-site activation gestures. Their postmortem is required reading for our
  permissions UX: https://labs.leaningtech.com/blog/the-bottomless-pit-of-disappointment-a-chrome-extension-tale
- **pdf.js** (Chrome extension flavor) — intercepts by content-type and redirects to `viewer.html`;
  the closest shipping analog to our navigation-takeover flow.
  https://github.com/mozilla/pdf.js/wiki/PDF-Viewer-(Chrome-extension)

## Remote browser isolation (commercial cousins)

Same idea, engine runs on a server instead of in wasm. Useful for UX/threat-model reference.

- **Cloudflare Browser Isolation** (ex-S2 Systems): the interesting one — streams **Skia draw
  commands**, replayed client-side by a **wasm module with embedded Skia**. Architecturally the
  nearest shipping relative of a nested wasm engine.
  https://blog.cloudflare.com/cloudflare-and-remote-browser-isolation/
- Menlo (sanitized DOM mirror), Ericom/Zscaler/Forcepoint/Symantec (pixel streaming), Kasm/KasmVNC
  (VNC-lineage pixels), neko (WebRTC video), BrowserBox (CDP screencast frames; went closed 2025/26).

## JS-engines-in-wasm precedent (why interpreter-only is credible)

- **SpiderMonkey wasm builds in production**: Bytecode Alliance `spidermonkey-wasi-embedding` /
  StarlingMonkey power Fastly JS Compute. Interpreter-only; Portable Baseline Interpreter + **weval**
  AOT gives 2.2–4.4x over plain interpreter (PLDI 2025). https://cfallin.org/blog/2024/08/28/weval/
- **QuickJS**: quickjs-emscripten, Shopify Javy — production sandboxing workhorses.
- **JSC**: mbbill/JSC.js proved JSC compiles to wasm via CLoop (2019, unmaintained); WebkitWasm uses
  the same path in-tree.
- **V8: cannot target wasm at all** (no wasm backend; even `--jitless` runs on native-code builtins
  baked by mksnapshot). Confirmed wontfix: https://github.com/emscripten-core/emscripten/issues/9314
- JIT-inside-wasm (generating and instantiating new wasm modules at runtime) is possible in principle
  (Wingo's prototype: 2–11x) but unproductized, and **out of scope for us on attack-surface grounds**.
