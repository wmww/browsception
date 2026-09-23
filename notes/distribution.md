# Distribution

How a `dist/` package (release.md) reaches users. Targets: **Chrome Web Store** and **AMO
listed** (decided 2026-09-22: no unlisted/self-distributed Firefox channel). The GitHub release
stays as the developer channel. Facts below were checked 2026-09-09 against the linked policy
pages; re-check before acting.

## Where things stand

Done: `npm run release` gives `dist/browsception-<v>-chrome.zip` and `-firefox.xpi` from a
fresh clone; MIT + BSD-2 licensing sorted; repo public at github.com/wmww/browsception;
**packages are id-agnostic** (2026-09-09) — no manifest `key`, no static rulesets, every DNR
rule installed at runtime, so a store-assigned id works unchanged (verified: dist/chrome loaded
unpacked in a throwaway profile gets a path-derived id, intercepts from a fresh profile, and
keeps the rule across a browser restart).

Versioning is settled (release.md § Versioning: integer `VERSION` in manifest.mjs, `v<N>` tags),
and the README has the load-unpacked / temporary-add-on install steps for channel 1.

Icons: `icon.svg` (repo root) is the source; `node scripts/gen-icons.mjs` (rsvg-convert)
renders the committed `src/ext/icons/icon-{16,32,48,128}.png` used by both manifests (`icons`
+ `action.default_icon`). Rerun after editing icon.svg — tier-0 manifest.test.mjs fails on a
stale `source.sha256` stamp. The 128 px PNG doubles as the store icon.

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
- Once the AMO listing is live, the README's Firefox install line becomes the AMO link and the
  GitHub xpi is for Developer Edition/Nightly only.

## Channel 2: Chrome Web Store

Effectively mandatory for non-technical Chrome users (see CRX note above).

- Developer account: $5 one-time, 2FA required. Package ≤ 2 GB; ours 35 MB.
- Listing assets: 128 px store icon (have), ≥1 screenshot 1280×800 (or 640×400), optional
  440×280 promo tile, single-purpose description.
- **Privacy policy URL** is required for `<all_urls>`; the dashboard's data-use disclosures
  and the manifest permissions must agree with it. Ours is easy to state: no servers, no data
  leaves the browser, nothing collected. Use PRIVACY.md's raw GitHub URL.
- **Permission justifications** (dashboard fields): one line per entry is in the
  extension-platform.md § Permissions table — quote it. `<all_urls>` + `webRequest` +
  DNR redirecting every main frame triggers the "may require in-depth
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

## Channel 3: AMO listed

Submit via Developer Hub upload or `web-ext sign --channel listed`; automated validation, then a
human review before publication; Mozilla signs the xpi and hosts it, auto-update included.
Limits: xpi ≤ 200 MB (ours 35 MB); `strict_min_version` 128 in the manifest, probed only on
155. CSP `'wasm-unsafe-eval'` is accepted. Listing fields: name, summary, description,
categories, screenshots (same PNGs as Chrome), license (MIT), support URL (repo issues),
privacy policy (paste PRIVACY.md).

The real cost is **source reviewability**. The submission asks whether the package contains
generated code; the 100 MB `embedder.wasm` and the vendored binaryen are, so source must be
uploaded as an archive with build instructions, and Mozilla must be able to **rebuild it and
diff against the package** in their default environment: Ubuntu 24.04, Node 24, 10 GB RAM,
6 vCPU, 35 GB disk. What we know vs. what that needs:

| Requirement | Status |
|---|---|
| Builds from a clean clone | Believed (engine-build.md spike; `npm run release` from fresh clone). Unverified since the third_party import: `tools/bootstrap.sh` must recreate third_party/ from nothing (roadmap.md cleanups) |
| Fits 10 GB RAM | Unknown. Compile is ~1.2 GB RSS per unified TU (6 jobs ≈ 7 GB); the WebKit link + wasm-opt on a 100 MB module is the unmeasured peak |
| Fits reviewer time | Unknown. ~1.5 h here at 12 jobs on 24 threads; expect several hours on 6 vCPU. Must be stated in the instructions |
| Byte-identical output | Unknown. Archives are reproducible given identical build output (release.md), but engine determinism across machines is untested; known hazard: absolute paths baked into the build graph (roadmap.md cleanups) |
| Network during build | bootstrap.sh clones WebKit + emsdk at pinned commits and downloads cmake. Pinned fetches are normally accepted; state every URL/commit in the instructions, or vendor them into the source archive if the reviewer objects |

Work items to close this (in order):

1. **Reviewer build recipe**: a `Dockerfile` (Ubuntu 24.04, Node 24) that runs `npm run release`
   from a clean clone at a tag, with job count pinned to 6. This is the build-instructions
   artifact for the submission, and also the fresh-clone bootstrap verification.
2. **Measure** peak RSS (`/usr/bin/time -v` or cgroup memory.peak) and wall time inside that
   container. If the link exceeds 10 GB, find the fix (fewer link-time jobs, split
   wasm-opt passes) — reviewers won't raise the limit.
3. **Determinism**: two container builds at the same tag, compare `embedder.wasm` + the zip
   hashes. Chase any diff to its source (timestamps, `__FILE__`/absolute paths, hash-map
   iteration order in binaryen). Then compare the container build to the host build that
   produced the release asset — that is the diff Mozilla will run.
4. Fold the result into README § Build from source (exact versions, resource needs, expected
   duration) and record it here.

Fallback if reviewability can't be met in their environment: Mozilla's policy allows asking
for a different reviewer setup in the notes-to-reviewer; failing that the Firefox channel is
the GitHub xpi for Developer Edition/Nightly. (Unlisted signing — `--channel unlisted`,
self-hosted `update_url` — would also work but is not planned.)

## Permission warnings (what users see)

Measured 2026-09-10 (Chrome 152, Firefox 155), after the `declarativeNetRequestWithHostAccess`
swap. Neither install dialog was reachable for a screenshot here (unpacked/temporary installs
don't prompt; release Firefox refuses unsigned xpis), so Chrome's prompt text comes from
`chrome.management.getPermissionWarningsByManifest` (the dialog's own message provider) and
Firefox's from about:addons → Permissions and data.

| Where | Before (plain DNR) | Now |
|---|---|---|
| Chrome install prompt | "Read and change all your data on all websites" | same — `<all_urls>` absorbs both the DNR and `tabs` warnings (with or without either) |
| Chrome extension details | "Read your browsing history", "Block content on any page" + Site access "On all sites" | "Read your browsing history" + Site access |
| Firefox about:addons | Required: "Block content on any page", "Access browser tabs"; Optional (on): "Access your data for all websites", (off) "Access local files" | Required: "Access browser tabs"; Optional unchanged |

So the trim is a Firefox win and a Chrome details-page tidy-up; Chrome's install prompt was
already one line. Dropping `tabs` on Firefox only would clear its last Required line
(it's not needed there — extension-platform.md § Permissions) at the cost of a manifest
divergence; not done.

## Checklist to the stores

1. ~~Icons~~ (done 2026-09-22, see above).
2. ~~`PRIVACY.md`~~ (done 2026-09-10).
3. **Reviewer note** `docs/store-notes.md`: the sandbox model, why each permission, where
   `eval` runs, link to security.md. Feeds the Chrome justification fields and the AMO
   notes-to-reviewer.
4. ~~Screenshots~~ (done 2026-09-22): `store/screenshot-popup.png` is the 1280×800 RGB
   (no alpha) upload: Google sandboxed + popup.
   Same PNG serves AMO.
5. **AMO reviewability** work items 1–4 above (Dockerfile, RAM/time, determinism, README).
   Independent of 3–4; the long pole.
6. Tag and release v2 (releasing.md) — first packages with icons, built the way the Dockerfile
   documents so the asset matches a reviewer rebuild.
7. Chrome Web Store: upload, listing, justifications, publish. Edge afterwards if wanted.
8. AMO listed: upload xpi + source archive (repo at the tag incl. Dockerfile), listing, submit.
9. On both approvals: README install section → store links.

Sources: [Chrome manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key),
[AMO source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/),
[AMO add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/),
[AMO signing & distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/),
[AMO submitting](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/),
[xpi size limit](https://discourse.mozilla.org/t/xpi-file-size-limit/86189).
