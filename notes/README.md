# browsception — notes

A web extension that runs websites inside a **nested browser engine compiled to WebAssembly**. The
top-level browser never parses or executes anything from the target site; the nested engine renders
the page to a pixel buffer that we blit to a canvas, and we forward input events in. To the user it
should feel like a normal (slow) web page.

## Motivations

- **Compatibility** — run one engine inside another (e.g. WebKit inside Firefox).
- **Security** — escaping two browser sandboxes is much harder than one, especially when the inner
  one has no JIT, no GPU, and no direct access to the top-level DOM or JS. See [security.md](security.md).
- **Experiment** — because it's cool and (as of mid-2026) the exact combination has never been shipped.

Performance should be as good as possible *within* those constraints, but we never trade attack
surface for speed (no WebGPU for the nested engine, no nested-wasm-runs-natively, no JIT).

## Index

| File | Contents |
|---|---|
| [prior-art.md](prior-art.md) | Existing projects: engine-to-wasm ports, emulation approaches, extension precedents, RBI products |
| [architecture.md](architecture.md) | System overview, components, data flows, hosting-mode variants |
| [engine.md](engine.md) | Engine choice (WebKit) and evaluation of alternatives; wasm porting constraints; integration seams |
| [extension-platform.md](extension-platform.md) | What extension APIs allow: interception, CORS, SAB/threads, limits; Chrome vs Firefox |
| [ui.md](ui.md) | Activation states, whitelist/blacklist modes, list semantics, toolbar UI, DNR mapping, shipping default |
| [networking.md](networking.md) | The fetch bridge design, cookie model, shim guard list |
| [bridge-probe.md](bridge-probe.md) | Spike 0.2 results: verified platform behaviors the bridge rests on + redirect/cookie design decisions |
| [engine-build.md](engine-build.md) | Reproducible engine build (pins, fixes, sizes, divergences, build traps); incremental-iteration recipe |
| [engine-internals.md](engine-internals.md) | Hard limits of the wasm engine, WebKit-internals gotchas that re-bite on rebases, perf constraints |
| [perf-measurement.md](perf-measurement.md) | How to get trustworthy engine perf numbers: BIBPERF counters, pixel-encoded page state, exact input rates, the traps that faked results, and the **bench suite** (`scripts/bench/run.mjs`: scenario matrix, saved results + delta tables, the contract that keeps it runnable against old commits) |
| [rendering-input.md](rendering-input.md) | Blit paths, input forwarding, IME, find-in-page, clipboard, audio, popups |
| [security.md](security.md) | Threat model, trust boundaries, what we must enforce ourselves |
| [testing.md](testing.md) | Automated test tiers (unit/bridge/full-integration), fixture+oracle design, agent iteration loop |
| [release.md](release.md) | Release packaging: the `npm run release` step chain and its fast paths, what each browser's package contains, the deterministic zip writer; integer versioning |
| [releasing.md](releasing.md) | **"Make a release" checklist**: preconditions, tests on both browsers, version bump, build, notes, tag/push, GitHub release, redo/rollback |
| [distribution.md](distribution.md) | Getting packages to users: GitHub release + load-unpacked/temporary install today; targets are Chrome Web Store + AMO listed — requirements, the AMO source-reviewability work items, checklist |
| [worktrees.md](worktrees.md) | Ephemeral-worktree workflow: wt-setup, building your branch's engine sources against the shared tree, WebKit-patch ownership, artifact snapshots, per-checkout ports |
| [open-questions.md](open-questions.md) | Unverified assumptions and spikes to run (answers appended in place) |
| [experiment-log.md](experiment-log.md) | Append-only lab notebook: dated entries (hypothesis → what ran → numbers → decision) behind the distilled notes |
| [roadmap.md](roadmap.md) | Post-MVP fast-follows, cleanups, standing risks, working agreements |

## Status

**v1 released** (2026-09-09) — the first public packages: [releases/tag/v1](https://github.com/wmww/browsception/releases/tag/v1), Chrome zip + Firefox xpi, 33.5 MB each, both browsers from one build. Checklist in [releasing.md](releasing.md).

**MVP complete** (2026-08-10, all gates passed). The MVP plan is retired; its surviving content
lives in [roadmap.md](roadmap.md). Phase summaries:

- **Phase 0 spikes**: engine build reproduced (engine-build.md, `scripts/build-engine.sh`); bridge
  design verified — engine-driven redirects, webRequest Set-Cookie capture (bridge-probe.md);
  interception matrix + blit path + test harness stood up (testing.md).
- **Phase 1 engine⇄shim**: versioned ABI (`src/abi/bib_abi.h` + abi.mjs mirror); engine fork
  (engine/WebkitWasm — absorbed into this repo 2026-08-12, sources tracked, no inner git;
  provenance in its LICENSING.md) transplanted networking onto the host-fetch bridge
  (BibNetBridge; the curl/wisp transport was later deleted outright), rendering to a
  runtime-sized shared-heap framebuffer
  (`bibFrame` zero-copy present), input through WebCore's EventHandler, crash/heartbeat recovery,
  flat-heap leak check. Exit gate: 10.2-min crash-free real-site browse (experiment-log.md).
- **Phase 2 extension**: viewer hosts the engine (src/ext/viewer.mjs + blit.mjs, OPFS persistence,
  `__bs` test hook); SW reconciles storage.sync state → DNR + symmetric tab sweep (sw.mjs);
  browser chrome v1 (true-URL bar, back/forward/reload via real BackForwardList, progress, nested
  title — the buttons later gave way to native history, below); activation & modes UI (popup/options/badge, actions.mjs matrix);
  sandboxed→native boundary (engine flags top-level loads, bridge policy natives them);
  guard-rail invariants green (hostile.bstest full pass, no top-level target docs); **2.6
  whitelist-by-default** — `DEFAULT_STATE.mode='whitelist'`, so a fresh install sandboxes
  everything (ui.md § shipping default; the catch-all was a static ruleset then, dynamic since
  2026-09-09). Exit
  gate: scripts/smoke-mvp.mjs real-site pass — sandboxed example.com/wikipedia, whitelist→native
  sweep (experiment-log.md 2026-08-10).

Tests: `npm test` = tiers 0–1, pure headless, per-commit. `npm run test:tier2` = 30 Chrome
scenarios (incl. 6 HiDPI at dpr 2/1.5) + a 10-scenario Firefox subset (`test/tier2/firefox.test.mjs`,
system Firefox over BiDi) against the staged engine artifact (~2 min; restage with
scripts/stage-engine.mjs after engine rebuilds — it also stages the extension's host-root assets;
src/engine/, src/vendor/ and the two injection payloads are gitignored). Engine iteration is
genuinely incremental (~90 s for embedder-only changes; engine-build.md fix 6) and works from any
worktree branch (worktrees.md § Engine work).

Load-bearing implementation facts:

- `?url=` has exactly one owner: `src/ext/viewer-url.mjs`. Format is **raw** — DNR `\0`
  substitution is un-encoded, so our own params must precede `url=` and everything after it is the
  target; a percent-encoded absolute http(s) target is tolerated on read (old tabs/bookmarks) and
  canonicalized back to raw on rewrite. Viewer, sweep and popup all read it through that module,
  and every host-world sink is gated by its `isHttpUrl` (security.md § Sandbox→host sinks).
- src/manifest.json is **generated** by scripts/gen-ext.mjs (CSP needs `'wasm-unsafe-eval'`).
  Nothing pins the extension id: every DNR rule, catch-all included, is installed at runtime.
- Icons: `icon.svg` is the source; `scripts/gen-icons.mjs` renders the committed
  `src/ext/icons/*.png` (not run by release; tier-0 test catches staleness).
- The engine runs in a dedicated Worker (`src/ext/engine-worker.js`, classic script: it
  `importScripts` the plain-link `embedder.js`); the viewer talks to it only through
  `src/ext/engine-link.mjs` (`__bs.link.call('bib_x', …)`), and the bridge/stub speak a
  bytes/strings interface — no code outside the worker touches the wasm heap. One artifact for
  Chrome and Firefox; a proxy-link (`-sPROXY_TO_PTHREAD`) artifact is refused by stage-engine.
- Portability gotchas: extension schemes are non-special in Node's URL (`.origin` is "null"),
  compare extension URLs by prefix; assigning a class's `.prototype` throws in ESM strict mode.
- bibChrome/bibPersist callbacks deliver kind/json as JS strings (ABI docs in bib_abi.h). The
  `url` signal carries `kind`/`index`/`length` so the viewer can mirror the engine's history into
  real tab history; the commit-time index (like canGoBack) is one navigation stale.
- Boot is fast (~620 ms cold / ~360 ms warm to interactive) — module caching / eager boot dropped
  (open-questions #11).
- Test-posture rule: suites that need native fixture traffic must pin a posture (tier-1 bridge:
  blacklist+empty; tier-2: fixture-domain blacklist) now that the default sandboxes everything.

**Post-MVP landed**: *native history* (2026-08-11) — the tab's session history mirrors the
engine's back/forward list, so the browser's own back/forward/reload drive the engine and the
viewer's own buttons are gone; the tab URL now always carries the live engine URL, which also
fixed the popup escaping to the stale entry-point URL (ui.md § Viewer chrome & native history).
*Scroll blit at any dpr* (2026-08-11, engine af6f559) — was dpr==1-only, every HiDPI/zoomed
scroll a full-viewport repaint (~1fps at 4K); now device-px snapped shift + settle repaint +
viewer wheel coalescing, 2-5ms strips at any dpr (rendering-input.md § scrolling).
*Engine fork absorbed* (2026-08-12) — engine/WebkitWasm sources are tracked in this repo
(squashed import, upstream docs/spikes pruned, gems distilled into engine-internals.md);
build state stays a main-checkout singleton (worktrees.md).

*HiDPI mouse mapping fixed* (2026-08-13) — input positions cross the ABI in framebuffer DEVICE
px, but the engine fed them straight into WebCore, whose events are LOGICAL px: on any dpr != 1
screen every click/wheel landed dpr times too far down and right (dpr 2, click 150 px in → hit
300,300). The engine now converts at the edge (`bibLogicalPoint`); the ABI states the contract;
tier-2 `hidpi.test.mjs` runs render/input/resize at dpr 2 + 1.5, because at dpr 1 the CSS,
logical and device spaces are the same numbers and nothing can catch a unit bug (testing.md
§ dpr != 1 is a coverage axis; rendering-input.md § Input coordinates).

*Wisp + curl transport removed* (2026-08-13) — the engine has no network transport at all:
libcurl, libssl, nghttp2, SOCKFS and the harness wisp dispatcher are gone from the code, the
link and the dep tier (`curl-tier.sh` → `ssl-tier.sh`). embedder.wasm 103 MB → 100 MB, WebKit
patch 68 files/3.5k lines → 67/3.1k. `USE(CURL)` stays ON for the port's platform types +
CookieJarDB; libcrypto stays for PAL digests. Guest `new WebSocket()` now fails cleanly
everywhere (tier-2 scenario 15); engine-side WS-over-host-WS is the only future path.

*Engine-side load failures surface* (2026-08-13) — `bibChrome` `"loadfailed"` from
BibFrameLoaderClient feeds the same viewer error strip as the bridge's own failures, so loads the
shim never sees (unsupported top-level MIME type, blocked port, any WebCore refusal) no longer
leave the viewer on "booting…". Two of those refusals dispatch to no client upstream — the patch
adds the notification (networking.md, engine-internals.md; tier-2 scenario 16).

*Repo hygiene* (2026-08-13) — one convention per kind of thing: Binaryen is an exact-pinned npm
dependency served at `/vendor` by the dev server and staged into `src/vendor/` for the extension
(no vendored blob); `engine-pre.js` moved to
`src/embedder/`, so `engine/WebkitWasm/web/` is harness-only and everything under `src/` is a
build input; the probe extension is a test fixture (`test/fixtures/probe-ext/`); `spikes/` and
`experiments/` are gone (blit numbers → open-questions #10, probes → `scripts/`, lab notebook →
[experiment-log.md](experiment-log.md)).

*Startup race pinned down and the sweep fixed* (2026-08-14) — the "does the first navigation beat
the rules?" issue is real and bigger than filed: **every** browser start with a startup/handoff URL
(not just install, not just `--load-extension`) loads that page natively for ~100 ms before the SW
sweep redirects it. That part is a hard MV3 limit (security.md § Startup race); what was fixable
was the sweep itself — it read `tab.url ?? tab.pendingUrl`, so a racing tab (still pre-commit:
`'about:blank'` + `pendingUrl`) was skipped entirely and stayed native, and it ignored escape
hatches, so any later reconcile revoked "open natively". Both fixed via `sweepAction()` +
`storage.session` grants (tier-1 `sweep.test.mjs`).

*View transitions disabled — youtube.com crash fixed* (2026-08-14) — `document.startViewTransition()`
drove `Document::setActiveViewTransition` → `RenderLayerCompositor::enableCompositingMode()` →
`GraphicsLayer::create`, which is a `RELEASE_ASSERT_NOT_REACHED` stub in this compositor-less port:
the whole engine aborted ~3 s into youtube.com/watch ("engine crashed — reload"). The embedder now
turns the feature off (`setViewTransitionsEnabled` + cross-document; the IDL is `[EnabledBySetting]`
so sites feature-detect and take their plain path) and the patch makes `enableCompositingMode(true)`
a no-op while accelerated compositing is off, so the remaining unconditional caller
(`LocalFrameView::enterCompositingMode`) degrades instead of crashing. YouTube's watch page now
renders fully; playback still fails cleanly (no codecs). Tier-2 scenario 17
(engine-internals.md § Hard limits).

Fallout tooling from that hunt: **an engine abort now logs a stack with named C++ frames**
(`engine-pre.js` hooks the engine worker's `Module.onAbort`, which Emscripten calls synchronously
from `abort()`; the wasm carries a name section). A no-ASSERTIONS `RELEASE_ASSERT` used to be an
empty `Aborted()` with nowhere to start — testing.md § Crash triage.

*Scroll input stops re-deriving superseded states* (2026-08-14) — `bib_wheel`/`bib_mouse_move`
packs stay open for merging while their proxied task is queued (sealed by any other posted task,
so order and discrete input are untouched), and `bibScrollBlit` shifts the SkSurface's own pixels
instead of `writePixels`-ing an unpremul→premul conversion of the framebuffer onto it. At 5.6 Mpx
fast scrolling went 2 → 18 fps with the input backlog 74 → 2 and the post-input tail 1.7 s →
0.16 s; distance is conserved exactly (rendering-input.md § scrolling, tier-2 scenario 19).

*Sticky-page scroll perf* (2026-08-14) — three general paint-path wins: waste-based 8-slot
damage merging (the old merge-any-overlap policy collapsed sticky-page damage to a
frame-covering rect and killed the scroll blit), the raster SkSurface now wraps `g_blitPixels`
directly (per-frame readPixels unpremultiply readback + the blit's second row walk deleted; the
premul "blocker" was moot — opaque frames, alpha-ignoring presenter), and BIBPERF gained
painted-area counters + `?dmglog=1` phase-tagged damage tracing. On top of that, a WebKit patch refinement (+173 patch lines) stops
self-laid-out block containers whose children repaint themselves from issuing blanket
full-viewport repaints, and skips the decoration-delta repaint for boxes with no visible
decorations — Wikipedia's per-scroll-tick layout dirtying went from 1.38 Mpx painted/frame
(full viewport) to 0.30. Net Wikipedia scroll: **30 → 60 fps at 1600×900 (99% → ~33% busy)**;
at 2560×1330 headless SwiftShader capped the bench at ~36 fps (a real GPU holds 60 —
experiment-log.md 2026-09-11). Mechanisms + rebase notes in engine-internals.md;
run log in experiment-log.md. New tier-2 scenario 20 (sticky-chrome scroll fixture
scroll-sticky.bstest).

*Scroll-up duplicated-band glitch fixed — presents are coherent snapshots* (2026-08-15) — the
raster present was zero-copy from the live framebuffer, and the async `texSubImage2D` raced
engine mutations: scroll-up's bottom-up blit memmove crossing the top-down upload read spliced
two scroll positions into one presented frame (clean full-width seam, content duplicated by the
scroll delta — invisible to CDP-driven repros; needs in-page trackpad-rate wheels + a multi-ms
read). Now `bibFrame` points at an engine-thread band snapshot with one-frame-in-flight
backpressure (`_bib_present_done`); fps unchanged, engine busy +3pp/+7pp (1600/2560 wide).
Tier-2 scenario 21 is the tripwire (pre-fix it tore on 13-60% of presents). Forced readbacks
also no longer swallow pending canvas damage (rendering-input.md § present snapshot).

*Viewer `?url=` contract + scheme gates* (2026-08-15) — one codec module (`src/ext/viewer-url.mjs`)
replaced three slightly different `?url=` parsers, and every sandbox→host sink got an explicit
http(s) gate. Two real bugs died: the sweep couldn't parse a percent-encoded target, so it declared
a perfectly healthy viewer tab "not sandboxable" and `tabs.update`d the raw `https%3A…` string —
which resolves against the extension origin and ERR_FILE_NOT_FOUNDs the tab; and the bridge
consulted `navigationPolicy` *before* the scheme guard, so any non-http(s) top-level load
(`ftp://`, `bsx://` — `file:` is refused earlier by WebCore) was dispositioned `'native'` and handed
to `location.replace` on the real tab. Gates now live at `tabs.update`, `location.replace`, the
popup's disposition, and `bib_load_url`. Tier-0 `viewer-url.test.mjs`, tier-1 native-handoff test,
tier-2 `scheme gates` scenarios (security.md § Sandbox→host sinks).

*Guest wasm + media stubs reached the extension* (2026-08-15) — the engine worker's pre-js fetches
its guest-injection payloads and the wasm2js translator from **origin-absolute host-root** paths
(`/wasm-polyfill.js`, `/media-stub.js`, `/vendor/binaryen/index.js`). Only the dev harness served
them: in the extension all three 404'd, so every viewer load logged three worker warnings (the
errors the user sees in chrome://extensions) and guest pages ran with no `WebAssembly` and no
`Audio`/`HTMLMediaElement` at all — a top-level `new Audio()` probe collapses a whole script
bundle. `scripts/stage-engine.mjs` now stages all three into the extension root alongside the engine
artifact, and binaryen moved devDependencies → dependencies (it ships, 13 MB against a 100 MB
wasm). Guest wasm now compiles and runs end-to-end in the extension. Tier-2 scenario 22;
contract table in engine-build.md § Host-root asset contract.

*The GPU path is gone — no GL in the imports* (2026-08-15) — security.md says the engine has "no
WebGL/WebGPU imports", but the link still carried `-sMAX_WEBGL_VERSION=2 -sFULL_ES3=1` from the
retired Ganesh present, so the module imported emscripten's whole GL table (278 `gl*` + 5 `egl*`
+ 3 `emscripten_webgl_*` — 289 of the wasm's 377 imports) and only the viewer's `bibGPU: false`
kept anything from *calling* it: the claim rested on reachability, not on the import list.
Removed at every layer: the link flags and the `--wrap=pthread_create`/`OFFSCREENCANVAS_SUPPORT` canvas-transfer machinery, ~690
lines of Ganesh/present/context-loss code in `main.cpp`, the worker's ImageBitmap present bridge,
the harness's two GPU present modes, and — on the WebCore side — `PlatformDisplay.cpp`,
`egl/GLDisplay.cpp`, `PlatformDisplayEmscripten.*` and Skia's `SkiaGLContext` world, replaced by
GL-free stubs. Wasm imports 377 → 88, `embedder.js` 268 KB → 159 KB, `embedder.wasm` 104.1 →
103.4 MB, WebKit patch 77 files → 75. Perf unchanged (same-session bench A/B; nothing deleted
ran). Tripwire: tier-0 `engine-imports.test.mjs`; contract in engine-build.md § No-GPU link
contract.

*Reconcile no longer un-intercepts mid-flight* (2026-08-15) — the DNR apply turned the static
catch-all **off before** installing the new dynamic rules, so every whitelist→blacklist edit had a
few ms in which nothing intercepted and a navigation started there ran natively (the sweep then
rescued it, aborting that navigation — the intermittent tier-1 sweep flake). Ordering logic fixed
it then; the static ruleset is gone since 2026-09-09 (below), so the reconcile is one atomic call
and the gap does not exist. The test's other half was its own bug: a sweep that re-navigates a
pre-commit tab rejects `page.goto` with ERR_ABORTED even when the tab lands correctly, so tier-1
asserts on the settled URL now (security.md § reconcile gap, testing.md 6b).

*One engine build, worker-hosted, on Chrome and Firefox* (2026-09-09) — the `-sPROXY_TO_PTHREAD`
link and every SharedArrayBuffer dependency are gone. The object tree still compiles `-pthread`;
`embedder.cmake` now links two targets from it — the shipping **plain link** (`-no-pthread`,
`-sENVIRONMENT=worker,web,node`) and the proxy link as an `EXCLUDE_FROM_ALL` target for a future
Chrome-only experiment (`scripts/build-engine.sh --proxy`; `meta.json` carries `"link"`, stage-engine
refuses proxy artifacts). The viewer hosts the plain link in a dedicated Worker
(`engine-worker.js`) and drives it through `EngineLink` messages: input/control as export calls,
frames as one transferred band buffer per present (the worker's `bibFrame` copies the band out
synchronously and returns `true` to own `_bib_present_done`, so one-frame-in-flight
backpressure follows the real present across the hop), network bytes transferred in and copied
into the heap by the worker — same copy count as the shared heap had. The bridge and the
tier-1 stub became a bytes/strings interface (`heap.mjs` deleted). Firefox then needed only
manifest generation (`scripts/lib/manifest.mjs`, `scripts/pack-ext.mjs` → `dist/firefox/`) plus
three feature-detected differences: the catch-all is a **dynamic** rule there (per-profile UUID),
`onHeadersReceived` alone delivers the 3xx (no `onBeforeRedirect` under `redirect:'error'`), and
`originUrl`/no-`extraHeaders` in the capture. Probed 2026-09-09 on Firefox 155 (open-questions #13):
DNR redirect/allow/session rules, session `modifyHeaders`, webRequest capture, OPFS, 4 GB
non-shared memory in a worker, WebGL2 presenter all work. Tier-2: 29 Chrome scenarios + the
9-scenario Firefox subset green from one tree (testing.md); bench A/B in experiment-log.md.
Scenario 21 retired (tearing is structurally impossible now).

*Firefox on real sites* (2026-09-09, later) — `http://google.com/` failed on Firefox with a bare
"network error" while Chrome was fine. Two Firefox-only network-stack shapes, neither reachable
by the fixture-only tier-2 subset: webRequest joins repeated `Set-Cookie` into one `\n`-joined
value (the engine refuses the response), and a dynamic-HSTS upgrade is `onBeforeRedirect`
status 0 with the fetch carrying on to https inside the same request (the bridge read status 0
as "not a redirect"). Fixed in redirect-capture.mjs + bridge.mjs (307 hop, continuation
dropped, body cancelled); tier-0 `bridge.test.mjs` (stubbed fetch) and two Firefox tier-2
scenarios, the HSTS one made possible by trusting the fixture CA for real in the Firefox profile
(pkix refuses the old self-signed `*.bstest` leaf). Details: extension-platform.md § Firefox,
networking.md § redirect capture, experiment-log.md.

*No pinned extension id* (2026-09-09) — the Chrome manifest `key` existed for exactly one reason:
a **static** catch-all ruleset needs an absolute `regexSubstitution`, so the id had to be known at
build time — and a store-assigned id would then have redirected every navigation to a dead URL.
Firefox already ran the catch-all as a dynamic rule; Chrome now does too, and `key`,
`rule_resources`, `src/rules/`, `applyPlan` and the SW's ruleset-toggle calls are all gone. Both
packages are id-agnostic (distribution.md). Two consequences: the reconcile is ONE atomic
`updateDynamicRules` (no half-applied window to order around — security.md), and a fresh install
has a millisecond window before `onInstalled` installs the rule, with no navigation in flight and
the sweep as backstop. Tests read the id from the running extension (`extensionId(context)`);
the probe extension keeps its key, because tier-1 deliberately tests static rules with the SW
killed.

*One release command per browser* (2026-09-09) — `npm run release [chrome|firefox]`
(scripts/release.mjs) takes a fresh clone to `dist/browsception-<version>-chrome.zip` /
`-firefox.xpi`. It orchestrates only: build-engine → wt-setup → stage-engine → gen-ext →
pack-ext → zip, each already idempotent, so a re-run is ~7 s and never rebuilds the engine.
`pack-firefox.mjs` generalized to `pack-ext.mjs <target>` (dist/chrome/ too — it drops
Chrome's own `_metadata/`), and `scripts/lib/zip.mjs` writes reproducible archives with no npm
dep and no `zip` binary. [release.md](release.md).

*Wire UA = engine UA* (2026-09-10) — the bridge stamped the HOST browser's `navigator.userAgent`
on every request while guest JS read WebKit's own Safari-17-on-Linux string, and the base rule
strips `sec-ch-ua*`: "Chrome with no client hints, whose JS says Safari". Google's sorry page
looped on exactly that (A/B: old headers → `/sorry/index` on first load, new → results). The
engine's User-Agent now rides DNR like Cookie/Referer, adopted into the base rule on first sight
(networking.md). The remaining `Sec-Fetch-*` infidelity is NOT second-order: Chrome stamps
extension-page fetches `sec-fetch-site: none` where Firefox says `same-origin`, and GitHub's
`/_graphql` 422s on `none` — the issues page shows GitHub's error boundary on Chrome and works
on Firefox. DNR can rewrite all four headers (verified both as fix and as cause). The 2026-09-10 wire audit
found two more (cache headers, Accept-Language); all fixed or documented since (below).

*Permission trim* (2026-09-10) — `declarativeNetRequest` → `declarativeNetRequestWithHostAccess`
(same API under `<all_urls>`, drops "Block content on any page"); `tabs` stays because Chrome
hides the viewer tabs' own `chrome-extension://` URLs from the sweep without it. Chrome's install
prompt was and is the single `<all_urls>` line; the gain is Firefox's list and Chrome's details
page. Tier-0 `manifest.test.mjs` pins the set (extension-platform.md § Permissions,
distribution.md § Permission warnings).

*Wire-header fidelity* (2026-09-10) — the wire now carries WebCore's own fetch metadata
(Sec-Fetch-Dest/Mode/Site via the per-request DNR rule, one shared `DNR_REQUEST_HEADERS` list),
URL-bar loads say `Sec-Fetch-Site: none` (`bib_load_url` is a client load) and user-caused
top-level navigations carry an embedder-added `Sec-Fetch-User: ?1`; guest `navigator.language` is
the host's list and `navigator.platform` `Linux x86_64`. GitHub's issues page works on Chrome
(its `/_graphql` 422'd on the host's `none`). `Pragma`/`Cache-Control: no-cache` from
`cache:'no-store'` are stamped below DNR — residual (networking.md § Design, experiment-log).

*Clipboard* (2026-09-10) — copy/cut/paste between the host clipboard and guest pages, no new
permission on either browser. The engine's WebKit pasteboard (a no-op stub until now) is an
in-memory store; engine-side writes (Ctrl/Cmd+C/X through the engine key map, guest copy
handlers, `execCommand('copy')`, `navigator.clipboard.write*`) come back as one
`bibChrome("clipboard")` per tick and are written with the async Clipboard API under a fresh
user input; host data enters only through the host's own paste event (`bib_edit` "paste",
images included). The viewer now forwards Ctrl/Cmd combos (it dropped all of them) behind a
host-key deny list, `src/ext/keys.mjs`. Probes first (open-questions #21): Firefox fires the
paste event at the body, and BiDi can't send input to extension pages — the Firefox harness now
synthesizes trusted keys from the chrome window. rendering-input.md § Clipboard; tier-2
scenario 25 on both browsers.

*Wheel scrolling on `overscroll-behavior` pages* (2026-09-11) — `html { overscroll-behavior:
contain|none }`, the standard "no bounce, no pull-to-refresh" rule (tumblr.com ships it), made a
page completely unscrollable by wheel while `scrollTo()`, Space and inner overflow scrollers
worked. Our wheel path is synchronous, and the sync path applies the ROOT's value twice to the
step *into* the viewport: the frame view's propagation filter ran before the view scrolled
itself (upstream's bug — backported 314170@main), and the DOM default handler's containing-block
walk blocked at the document element's placeholder `RenderLayerScrollableArea` (still unfixed
upstream — our hunk skips it). Subframe containment still blocks at the frame view, where it
belongs. tumblr.com wheel-scrolls; tier-2 scenario 26 (engine-internals.md § WebKit-internals
gotchas, rendering-input.md § scrolling).

Open issues in issues/ (guest-JS wedge, rcap dynamic budget, CLoop `join` returned a
non-string, host access revocation silently un-sandboxes, editing-key gaps, keyboard scroll
keys). Plans in plans/, in intended order: firefox-harness-reload (tiny, test-only: real BiDi
reload for the flaky crash scenario), WebSocket bridge (largest; nothing waits on it),
touch-input (viewer-only pointer-event
recognizer: tap → click, drag → wheel, fling; no ABI change), text-input (the host editable
proxy: engine editor state → hidden mirror textarea → IME/OSK/composition → caret-relative edit
ops over the existing `bib_edit`; its touch stage waits on touch-input). Next work:
[roadmap.md](roadmap.md).

## Key decisions

- **Engine: WebKit**, via the WebkitWasm lineage (WebCore embedded WebKit1-style, JSC CLoop
  interpreter, Skia). See [engine.md](engine.md).
- **Chrome MV3 and Firefox from one tree**, both with the extension-page viewer (DNR main_frame
  redirect). No SharedArrayBuffer anywhere, so Firefox's non-isolated extension pages are no
  obstacle; the only divergence is manifest generation. The stay-on-origin "mode B" is rejected.
  See [extension-platform.md](extension-platform.md), [architecture.md](architecture.md).
- **Fake in-page URL bar is acceptable** for the MVP; the address bar showing the extension URL is a
  permanent platform constraint of the extension-page mode.
- **No external servers**: networking goes through the extension's own CORS-exempt `fetch()`, not a
  Wisp/WebSocket proxy. See [networking.md](networking.md).
- Printing: out of scope. Find-in-page: reuse WebKit's engine-side implementation.
- **Activation/modes**: extension is active or inactive; when active, default is **whitelist mode**
  (sandbox-by-default — whitelist holds trusted domains that run natively, empty on install), with
  an optional **blacklist mode** (native-by-default — only listed domains run sandboxed). Shipping
  default landed with 2.6. See [ui.md](ui.md).
