# Browsception

A browser extension that opens websites inside a second browser engine: WebKit compiled to
WebAssembly, running in a normal tab. The nested engine loads and renders the site; the
extension shows the result and passes your clicks and keys in. Your real browser never runs
any of the site's own code.

Why: a site would have to escape two sandboxes instead of one, and the inner one has no JIT,
no GPU, and no access to your browser. Also because nobody seems to have tried it.

Expect it to be slow (the engine is an interpreter drawing on the CPU) and to break on some
sites. Please report what breaks in [issues](https://github.com/wmww/browsception/issues),
with your browser and the extension version.

## Install

Download the package for your browser from the
[releases page](https://github.com/wmww/browsception/releases). There is no auto-update;
repeat these steps for a new release.

**Chrome, Edge, Brave**

1. Unzip `browsception-<N>-chrome.zip` somewhere permanent; the browser loads the folder in place.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the folder.
3. On Windows and macOS, Chrome shows a "disable developer mode extensions" prompt at every
   launch. Dismiss it.

**Firefox**

The xpi is unsigned, and release Firefox only runs signed add-ons, so:

- Any Firefox: `about:debugging` → **This Firefox** → **Load Temporary Add-on** → pick
  `browsception-<N>-firefox.xpi`. This is gone on restart.
- Developer Edition, Nightly or ESR: set `xpinstall.signatures.required` to `false` in
  `about:config`, then open the xpi for a permanent install.

## Use

The toolbar popup has an on/off switch and shows what happens to the current site. Two modes:

- **Whitelist** (default): every site opens in the sandbox, except domains you have marked as
  trusted.
- **Blacklist**: every site opens normally, except domains you have listed.

The popup can add the current site to the active list, switch modes, or open the current page
normally just once. "Site lists & settings" edits both lists; a domain covers all of its
subdomains. Back, forward and reload work as usual inside sandboxed pages, and cookies and
logins persist.

## Build from source

```sh
npm run release
```

This produces loadable folders in `dist/chrome/` and `dist/firefox/` plus the release archives.
The first run builds the engine, which takes about an hour and 12 GB on a Linux host; later
runs reuse it. See [`notes/engine-build.md`](notes/engine-build.md) for details.

The build is reproducible: a release's archives can be rebuilt byte for byte from its tag.
The reference environment is Ubuntu 24.04 with Node 24 (at least 10 GB RAM):

```sh
docker build -t browsception-build .
docker run --rm -v "$PWD:/src" browsception-build   # or, on the host itself:
bash scripts/build-from-source.sh --install-deps    # apt-gets the build tools first
```

## Credits and license

The engine is a fork of [WebkitWasm](https://github.com/theogbob/WebkitWasm) by theogbob, the
port that first got WebKit running under Emscripten. Built on [WebKit](https://webkit.org),
Skia, and Emscripten.

[MIT](LICENSE), except `engine/WebkitWasm/`, which is BSD-2-Clause and carries WebKit's
LGPL-2.1/BSD terms. See [`engine/WebkitWasm/LICENSING.md`](engine/WebkitWasm/LICENSING.md).
