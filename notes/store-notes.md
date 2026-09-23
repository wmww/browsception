# Store submission reference

Paste-ready text for the Chrome Web Store dashboard, with the AMO equivalents noted. Process,
requirements and checklist: distribution.md. Sources of truth that this file quotes:
`scripts/lib/manifest.mjs` (permissions, CSP), extension-platform.md § Permissions,
security.md, PRIVACY.md. Update this if any of those change.

## Package tab

Upload `dist/browsception-<N>-chrome.zip` from a tagged release (releasing.md), not a local
build.

## Store listing tab

- **Name**: browsception (from the manifest).
- **Summary**: taken from the manifest `description` (≤132 chars): "Runs websites inside a nested
  wasm browser engine."
- **Category**: Privacy & Security.
- **Language**: English.
- **Screenshots**: `store/screenshot-popup.png` (1280×800, no alpha).
- **Icon**: `src/ext/icons/icon-128.png`.
- **Promo tile** (440×280): optional. We don't have one.
- **Homepage / support URL**: https://github.com/wmww/browsception (support:
  https://github.com/wmww/browsception/issues).

**Description** (draft):

> Browsception opens websites inside a second browser engine: WebKit compiled to WebAssembly,
> running in an ordinary tab. The nested engine loads and renders the site; the extension shows
> the result and passes your clicks and keys in. Your real browser never runs the site's own
> code.
>
> Why: a malicious site would have to escape two sandboxes instead of one, and the inner one has
> no JIT, no GPU access and no access to your browser, cookies or other tabs.
>
> Two modes, switched from the toolbar popup:
> • Whitelist (default): every site opens in the sandbox except domains you trust.
> • Blacklist: every site opens normally except domains you list.
> The popup can trust the current site, open it natively once, or switch modes. Back, forward
> and reload work as usual, and logins inside the sandbox persist (separate from your browser's
> own cookies).
>
> Expect it to be slow: the engine is an interpreter drawing on the CPU. Some sites will break.
> Please report them on GitHub.
>
> No data collection, no servers, no analytics. Open source (MIT):
> https://github.com/wmww/browsception

## Privacy practices tab

**Single purpose**:

> Open websites inside a sandboxed browser engine (WebKit compiled to WebAssembly) running in an
> extension tab, instead of in the user's real browser, according to the user's
> whitelist/blacklist settings.

**Permission justifications** (one field each):

- **Host permission `<all_urls>`**: The extension routes top-level navigations to any http(s)
  site into its sandbox viewer, so its redirect rules need access to every host. The sandboxed
  engine's network requests are made by the extension on its behalf, anonymously (credentials
  omitted, private/local networks blocked). That requires CORS-exempt fetch to the sites the
  user visits. It also reads tab URLs to show which tabs are sandboxed.
- **`declarativeNetRequestWithHostAccess`**: One rule redirects top-level page loads into the
  extension's sandbox viewer; allow rules exempt domains the user trusts. Short-lived session
  rules let the user open a page natively once. Header rules set the correct request headers on
  the sandbox's own fetches, scoped to requests initiated by the extension, so normal browsing is
  never modified. No blocking or content filtering.
- **`webRequest`**: Non-blocking observation of the extension's own sandbox fetches only, to read
  Set-Cookie headers and redirect responses that `fetch()` hides. The cookies go into the
  sandbox's separate cookie store. No `webRequestBlocking`; no observation of normal browsing is
  stored or sent anywhere.
- **`storage`**: Saves the user's settings (on/off, mode, site lists) and remembers "open
  natively once" grants for the session.
- **`tabs`**: Reads the URLs of the extension's own viewer tabs to keep the badge and popup
  correct, and to move a tab into the sandbox when a navigation slipped past the redirect (e.g.
  the page restored at browser startup). Chrome hides the extension's own tab URLs without this
  permission.

**Remote code**: **No, I am not using remote code.** All extension JS and wasm is in the
package, and CSP is `script-src 'self' 'wasm-unsafe-eval'` with no `unsafe-eval`. A reviewer
may argue that running websites' JavaScript counts. The answer: that JS is *data* to the
packaged engine. JavaScriptCore inside the wasm module interprets it. It never reaches the
extension's JS runtime, the same way a PDF viewer runs a PDF's scripts. Put this in the
reviewer notes below.

**Data usage**: tick **nothing**. Nothing is collected: no servers, nothing transmitted
anywhere except the sandboxed page's own requests to the site being visited. Tab URLs and page
content are handled locally only. Tick all three certifications (no sale/transfer, no
unrelated use, no creditworthiness use). This is my reading of the form. If the reviewer pushes
back on "website content" or "web history", ticking those with "handled locally, never
transmitted" is the honest fallback.

**Privacy policy URL**: https://github.com/wmww/browsception/blob/main/PRIVACY.md (or the raw
URL). It must stay in agreement with the permission text above.

## Test instructions / notes to reviewer

Chrome's "Test instructions" field and AMO's "Notes to reviewer" (paste the same text):

> No account or login needed. After install, the extension is active in whitelist mode, so
> any http(s) page you open is sandboxed: the tab moves to a chrome-extension:// viewer page
> that shows the site rendered by the nested engine. Expect the first load to be slow; the engine
> is a ~100 MB WebAssembly build of WebKit running in an interpreter. The toolbar popup shows
> the current site's status and lets you trust it ("always run natively"), open it natively
> once, switch to blacklist mode, or turn the extension off.
>
> Security model: sites run inside WebKit compiled to wasm (no JIT, no GPU, no access to the
> browser's DOM, cookies or other tabs). The engine's only way out is a short list of typed
> hooks to the viewer: anonymous network fetches (credentials omitted; localhost and private
> networks blocked), pixels out, input in, a namespaced storage snapshot. Only absolute http(s)
> URLs ever cross from the sandbox into real browser navigation.
>
> Code notes:
> • `engine/embedder.wasm` + `embedder.js` are the Emscripten build of WebKit; source and
>   build instructions: https://github.com/wmww/browsception (README § Build from source).
> • `vendor/binaryen/` is the npm `binaryen` package, run in the engine's worker to translate
>   WebAssembly used by sandboxed pages into JS for the nested engine.
> • `wasm-polyfill.js` and `media-stub.js` are never executed by the extension. The engine
>   reads them as text and injects them into sandboxed pages inside the nested engine. The
>   `(0, eval)` in wasm-polyfill.js therefore runs in the nested JavaScriptCore, not in
>   the extension.
> • The extension's pages use CSP `script-src 'self' 'wasm-unsafe-eval'`, required to
>   instantiate the engine's wasm; no `unsafe-eval`, no remote code, no analytics.

AMO only, appended to the above (the uploaded source archive is `git archive v<N>`):

> Build (reproduces the xpi byte for byte; checked on Ubuntu 24.04 / Node 24 with 10 GB RAM,
> 6 vCPU, ~1 h, ~12 GB disk):
>     docker build -t browsception-build . && docker run --rm -v "$PWD:/src" browsception-build
> or without Docker, on Ubuntu 24.04 with Node 24:
>     bash scripts/build-from-source.sh --install-deps firefox
> Output: dist/browsception-<N>-firefox.xpi. The build downloads pinned sources: WebKit
> (git, fixed commit), Emscripten SDK 6.0.0, CMake 3.31.7, ICU, zlib, libpng, libjpeg-turbo,
> libwebp, freetype, harfbuzz, libxml2, sqlite, openssl, brotli, libpsl, fontconfig and
> DejaVu fonts (release tarballs, URLs in engine/WebkitWasm/tools/), plus npm packages from
> package-lock.json.

## Review risks

- In-depth review is certain (`<all_urls>` + webRequest + a DNR redirect on every main frame).
  Expect days to weeks.
- The default sandboxes every site on install. If that's rejected as too invasive, the fallback
  is shipping blacklist mode (or per-site activation) as the store default (roadmap.md risk).
- "Remote code" argument above. If rejected, there's no technical fix short of not running
  sites. Appeal with the PDF-viewer comparison.
