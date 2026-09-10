# Browsception

A browser extension that runs websites inside a **nested browser engine compiled to
WebAssembly**. WebKit — running as wasm inside a normal browser tab — parses, executes, and
renders the target site to a pixel buffer; the extension blits it to a canvas and forwards
your input in. The outer browser never runs a byte of the site's own code.

Why:

- **Security** — escaping two browser sandboxes is much harder than one, especially when the
  inner engine has no JIT, no GPU, and no access to the outer DOM.
- **Compatibility** — one engine inside another (WebKit inside Chrome and Firefox, from one build).
- **Experiment** — because as far as we know this exact combination has never been shipped.

## How it works

The extension (Chrome MV3) intercepts navigations with declarativeNetRequest and redirects
them to its viewer page. The viewer boots a ~100 MB wasm build of WebKit (WebCore + JSC in
CLoop interpreter mode, Skia CPU raster) and drives it through a small versioned ABI
(`src/abi/bib_abi.h`): frames come out through a shared-memory framebuffer, input events go
in, and all networking rides the extension's own CORS-exempt `fetch()` — no external proxy
servers, TLS terminates in the host browser. Cookies/localStorage persist to OPFS. The
engine's history mirrors into real tab history, so back/forward/reload just work.

Two modes: **whitelist** (default — everything runs sandboxed except domains you trust) and
**blacklist** (everything native except listed domains).

## Installing a release

Grab the package for your browser from the [releases page](https://github.com/wmww/browsception/releases).
Releases are numbered v1, v2, v3, … (no semver — there's no API to be stable about), and every
release is rough until it isn't; expect it to be slow (the engine is an interpreter with CPU
rasterization) and to break on some sites. Please report what breaks in
[issues](https://github.com/wmww/browsception/issues), with your browser and the extension
version from your extensions page.

**Chrome / Edge / Brave** (any OS):

1. Download `browsception-<N>-chrome.zip` and unzip it somewhere permanent (the browser loads
   the folder in place).
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**,
   pick the unzipped folder.
3. Chrome on Windows/macOS will show a "disable developer mode extensions" prompt at each
   launch; dismiss it. There is no auto-update: for a new release, unzip over the folder and
   hit the reload button on the extension's card.

**Firefox**: release builds only run signed add-ons, and the xpi is unsigned for now, so:

- Any Firefox: `about:debugging` → **This Firefox** → **Load Temporary Add-on** → pick
  `browsception-<N>-firefox.xpi`. Gone on restart; repeat each session.
- Developer Edition, Nightly or ESR: set `xpinstall.signatures.required` to `false` in
  `about:config`, then open the xpi (File → Open, or drag it into the window) for a permanent
  install.

Once installed, the toolbar popup shows whether it's active and which mode you're in. The
default is **whitelist**: every site runs inside the sandboxed engine until you add its domain
to the trusted list.

## Repo layout

| Path | What |
|---|---|
| `src/` | The extension (unpacked root): viewer, service worker, popup/options, engine shim |
| `src/abi/` | The C ⇄ JS ABI contract (`bib_abi.h` + mirrored `abi.mjs`) |
| `engine/WebkitWasm/` | The engine: embedder C++, WebKit patch, build scripts, dev harness |
| `scripts/` | Engine build/staging, extension generation + release packaging, real-site smoke tests |
| `test/` | Tiered suites: tier 0–1 headless (no engine), tier 2 against the real engine |
| `notes/` | Design docs and distilled project knowledge |

## Building & running

**Release packages**, from a fresh clone, for both browsers:

```sh
npm run release                  # or release:chrome / release:firefox
```

That runs every step below in order and skips the ones already done, so re-running it after a
JS-only change takes seconds and never rebuilds the engine. Out come `dist/chrome/` +
`dist/firefox/` (loadable unpacked) and `dist/browsception-<version>-chrome.zip` /
`-firefox.xpi` (byte-reproducible archives). The first run on a machine with no engine build
costs the ~1.5 h / ~12 GB below.

**Step by step**, which is also the dev loop:

```sh
bash scripts/build-engine.sh     # one-time ~1.5 h: fetches pinned WebKit + emsdk,
                                 # builds ~12 GB of deps, then the engine (Linux host)
node scripts/stage-engine.mjs    # hardlink engine artifacts into src/engine/
node scripts/gen-ext.mjs         # generate manifest + DNR rulesets
# then load src/ as an unpacked extension (chrome://extensions, Developer mode)
node scripts/pack-ext.mjs firefox   # Firefox needs its own manifest: dist/firefox/
```

Tests: `npm test` (headless tiers, no engine needed), `npm run test:tier2` (against the
staged engine). Incremental engine rebuilds after embedder changes are ~2–3 min.

## Credits

The engine is a hard fork of [**WebkitWasm**](https://github.com/theogbob/WebkitWasm) by
**theogbob** — the port that first got WebKit building and running under Emscripten, and the
foundation this project stands on (imported at `825c260`; provenance and what we've rewritten
since in [`engine/WebkitWasm/LICENSING.md`](engine/WebkitWasm/LICENSING.md)). Thanks to
theogbob for BSD-licensing it on request. Related:
[HeyPuter/firefox-wasm](https://github.com/HeyPuter/firefox-wasm), a sister port of Gecko.

Built on [WebKit](https://webkit.org) (LGPL-2.1/BSD), Skia, and Emscripten.

## License

[MIT](LICENSE), except `engine/WebkitWasm/`, which is a fork of upstream's BSD-2-Clause code
(notice retained in [`engine/WebkitWasm/LICENSE`](engine/WebkitWasm/LICENSE)) and whose WebKit
patch inherits WebKit's LGPL-2.1/BSD terms. Shipping a *built* extension additionally carries
LGPL-2.1's relink obligation for the statically linked WebCore — see
[`engine/WebkitWasm/LICENSING.md`](engine/WebkitWasm/LICENSING.md).
