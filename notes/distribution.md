# Distribution

How a `dist/` package (release.md) reaches users, from a GitHub release today to the stores.
Facts below were checked 2026-09-09 against the linked policy pages; re-check before acting.

## Where things stand

Done: `npm run release` gives `dist/browsception-<v>-chrome.zip` and `-firefox.xpi` from a
fresh clone; MIT + BSD-2 licensing sorted; repo public at github.com/wmww/browsception;
**packages are id-agnostic** (2026-09-09) — no manifest `key`, no static rulesets, every DNR
rule installed at runtime, so a store-assigned id works unchanged (verified: dist/chrome loaded
unpacked in a throwaway profile gets a path-derived id, intercepts from a fresh profile, and
keeps the rule across a browser restart).

Versioning is settled (release.md § Versioning: integer `VERSION` in manifest.mjs, `v<N>` tags),
and the README has the load-unpacked / temporary-add-on install steps for channel 1.

Blocking the stores (not channel 1):

- **No icons** — no `icons` manifest entry, no icon files. Both stores need a 128 px icon;
  the toolbar action currently shows a placeholder.

## Channel 1: GitHub release, no review (possible today)

Attach the zip and the xpi to a GitHub release with these instructions.

**Chrome** (all OSes): unzip, `chrome://extensions`, Developer mode, Load unpacked, pick the
folder. No account, no review. Costs: no auto-update; Chrome on Windows/macOS shows a
"disable developer mode extensions" bubble at every launch. Off-store **CRX** installs are
refused on Windows/macOS (Linux and enterprise policy only), so a CRX buys nothing.
Edge/Brave/other Chromium: same load-unpacked path.

**Firefox** release builds enforce signing (the pref cannot be flipped there):

- `about:debugging` → This Firefox → Load Temporary Add-on → the xpi. Works in release Firefox
  unsigned, gone on restart. Dynamic DNR rules are installed by the event page on load.
- Developer Edition / Nightly / ESR with `xpinstall.signatures.required = false`: permanent
  unsigned install.
- **Unlisted signing** (below) turns the xpi into a normal double-click install in release
  Firefox and is the one cheap step worth doing before the first GitHub release.

## Channel 2: AMO unlisted signing (self-distributed Firefox)

- Free AMO account. Submit via Developer Hub upload, `web-ext sign --channel unlisted`, or the
  Add-on API (JWT key pair). Automated validation only before signing; typically minutes.
  Mozilla may review manually at any later time; all add-on policies apply regardless of
  distribution.
- The submission asks whether the package contains generated code. The 100 MB `embedder.wasm`
  and the vendored binaryen are generated, so answer yes and provide source: the repo URL at
  the release tag plus README build steps satisfy the form. See "source reviewability" below
  for what a human review would then need.
- Self-hosted **auto-update** is available to unlisted add-ons: add
  `browser_specific_settings.gecko.update_url` pointing at an `updates.json` (GitHub Pages or
  raw release asset) listing each version's signed xpi URL and hash.
- Limits: xpi ≤ 200 MB (ours 35 MB); `strict_min_version` 128 in the manifest, probed only on
  155. CSP `'wasm-unsafe-eval'` is accepted.

## Channel 3: Chrome Web Store

Effectively mandatory for non-technical Chrome users (see CRX note above).

- Developer account: $5 one-time, 2FA required. Package ≤ 2 GB; ours 35 MB.
- Listing assets: 128 px store icon, ≥1 screenshot 1280×800 (or 640×400), optional 440×280
  promo tile, single-purpose description.
- **Privacy policy URL** is required for `<all_urls>`; the dashboard's data-use disclosures
  and the manifest permissions must agree with it. Ours is easy to state: no servers, no data
  leaves the browser, nothing collected.
- **Permission justifications** (dashboard fields): `<all_urls>` + `webRequest` +
  `declarativeNetRequest` redirecting every main frame triggers the "may require in-depth
  review" warning and a human reviewer. Explain the sandbox model up front; point at the
  repo; mention that `eval` in `wasm-polyfill.js` runs inside the nested engine, not on the
  host page. Standing risk (roadmap.md): a rejection of the redirect-everything default would
  mean shipping per-site activation / blacklist mode as the store default.
- Id: no key is needed and the store id is simply whatever is assigned. (If a key were ever
  needed again: upload once unpublished, copy the public key from the dashboard Package tab into
  the manifest, regenerate, re-upload.)
- Store installs auto-update; that plus no dev-mode nag is the whole benefit over channel 1.
- Edge Add-ons store accepts the same zip (separate free account); Edge users can also install
  from the Chrome Web Store directly.

## Channel 4: AMO listed

Same submission as unlisted but with a listing and a human review before publication. The
extra cost is **source reviewability**: Mozilla must be able to rebuild generated code from
source with the instructions provided and diff it against the package. Default reviewer
environment: Ubuntu 24.04, Node 24, 10 GB RAM, 6 vCPU, 35 GB disk. Our engine build is ~1.5 h,
~12 GB of deps (fits disk; RAM for linking WebKit is doubtful), and whether it is
byte-deterministic is unknown (open question). Prerequisites before attempting: the
fresh-clone bootstrap verification (roadmap.md cleanups), a determinism check of two clean
builds, and documented RAM needs. Until then, unlisted signing is the Firefox channel.

## Checklist to first public release

1. Icons (`icons` in COMMON manifest, files under `src/ext/`).
2. `PRIVACY.md` in the repo (served via GitHub Pages or raw URL) and a short reviewer note
   (`docs/store-notes.md` or in README) describing the model and permissions.
3. AMO account, unlisted sign the xpi, attach both packages to a GitHub release with the
   install steps above. Optionally `update_url` + `updates.json` for Firefox auto-update.
4. Chrome Web Store account, upload, justifications, publish. Then Edge if wanted.
5. AMO listed only after the reproducibility prerequisites above.

Sources: [Chrome manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key),
[AMO source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/),
[AMO add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/),
[AMO signing & distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/),
[AMO submitting](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/),
[xpi size limit](https://discourse.mozilla.org/t/xpi-file-size-limit/86189).
