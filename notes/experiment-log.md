# Experiment log

Append-only lab notebook (notes/testing.md § Lab notebook). Raw record here;
distilled conclusions get promoted into the other notes in the same change.

Historical record — entries are not rewritten. Paths have since moved:
`spikes/probe-ext/` → `test/fixtures/probe-ext/`, `spikes/blit/` → deleted
(numbers in open-questions #10, code in `src/ext/blit.mjs`),
`experiments/*.mjs` → `tools/`.

---

## 2026-08-09 — Phase 0 spikes: harness, networking (0.2), interception (0.3)

**Setup**: Chromium 150.0.7871.186 (Arch), Node 26.5, playwright-core 1.62 driving
system Chromium headless; fixture server + oracle (`test/fixtures/server.mjs`); probe
extension `spikes/probe-ext/` (pinned id `niccekiafgllmlhjohknnkaemmedldgo`).

**Headless parity (open-questions #19)** — hypothesis: headless=new supports our whole
stack. Ran `test/tier1/parity.test.mjs`. Result: PASS on all four load-bearing pieces
(unpacked extension + SW, manifest COOP/COEP → crossOriginIsolated + SAB + shared wasm
memory + worker Atomics, DNR main_frame regexSubstitution redirect, host-resolver-rules
with two mappings incl. port override). CI can be pure headless; guibox fallback not
needed for tiers 0–1.

**Networking probes (0.2)** — scripts (throwaway, scratchpad): probe-net, probe-wr,
probe-rederr, probe-pna; graduated into `test/tier1/bridge-probe.test.mjs` (7 tests).
Full result table + decisions promoted to **notes/bridge-probe.md**. Headlines:
redirect:'manual' is opaque even for extensions; Set-Cookie invisible to fetch but fully
readable (incl. HttpOnly, per hop) via observational webRequest `extraHeaders`;
redirect:'error' + webRequest gives engine-driven redirects (3xx captured, next hop never
on wire); DNR modifyHeaders rewrites UA/Cookie/Referer/Origin scoped by
initiatorDomains=extension, zero leakage to native traffic; Chrome applies no PNA to
extension fetches (guard list is alone); observed cross-origin cookie-carry hazard with
host-followed redirects → per-request cookie rules + engine-driven hops.

**Interception matrix (0.3)** — `test/tier1/interception.test.mjs` (6 tests): static
blacklist redirect fires with SW force-killed (CDP Target.closeTarget); http and https
both intercepted; attachment/download navigations redirect at request time (response
type irrelevant); history entries hold viewer URLs, back/forward clean;
whitelist-mode shape works (static catch-all + priority-10 allow + priority-100
session escape hatch scoped to tabId — other tabs unaffected); view-source: of an
intercepted domain redirects its inner request (invariant holds).

**guibox recipe check (0.5)** — launched windowed Chromium + extension in guibox,
screenshot, F5 via wdotool, screenshot again, stop. Recipe works as documented.
FOUND: first navigation on a fresh profile races static ruleset registration and loads
natively (reload intercepts) → chased down 2026-08-14 below (it is every browser start,
not just fresh profiles).

**Engine build (0.1)** — WebkitWasm cloned (repo is ~3.5 MB of scripts/patches, not a
WebKit fork; `main` is the pthread branch now, `wb1-pthread` is a stale snapshot).
Pins: WebKit `webkitglib/2.52 @ aec9d2ad95`, Emscripten 6.0.0. bootstrap + build
running in background (`engine/logs/build-0.1.log`) — still in WebKit clone stage at
time of writing.

## 2026-08-09 — Spike 0.4: blit + input harness (delegated agent)

Built spikes/blit/ (viewer skeleton + fake SAB engine worker + dep-free CDP bench).
Measured headless (SwiftShader) AND windowed guibox (AMD 890M/radeonsi), Chromium 150:
WebGL2 full-frame 0.65–0.68/1.31–1.02 ms avg (1080p/1440p); putImageData 1.3–3.2 ms and
45 fps at 1440p headless (only failing config); dirty rows (~10%) 0.10–0.22 ms everywhere;
input round-trip avg 5–14 ms p95 19–31 ms (rAF quantization), zero ring drops. Chromium
accepts SAB-backed views in texSubImage2D directly (scratch-copy fallback unused).
Decision → open-questions #10 answer; raw JSON in spikes/blit/bench/data/.

## 2026-08-10 — 0.1 fresh-bootstrap failure: dep-order bug in WebkitWasm

First full run of `tools/bootstrap.sh` on a truly fresh checkout died in
webcore-deps at freetype: `FT_REQUIRE_BROTLI=ON` but brotli is built by
curl-tier.sh, which bootstrap runs *after* webcore-deps (fontconfig↔freetype
forces that order). Upstream never hit it — their comment ("brotli is already
in the sysroot of every existing checkout") shows the brotli requirement
postdates their last fresh bootstrap. Workaround that keeps their scripts
untouched (all dep steps are idempotent): run curl-tier.sh once first — it
builds openssl→nghttp2→brotli→libpsl→curl and dies at fontconfig (missing
freetype, expected) — then re-run the normal bootstrap chain. Relaunched as
build-0.1b.log. Goes in the 0.1 build-reproduction notes; worth reporting
upstream.

## 2026-08-10 — 0.1 second fresh-bootstrap failure + fix; bootstrap complete

After the brotli-ordering workaround, curl-tier died at fontconfig: fc-cache link
failed with undefined brotli symbols — libbrotlidec.a needs libbrotlicommon.a, but
brotli's `libbrotlidec.pc` declares it only in `Requires.private`, which non-static
pkg-config resolution drops (harmless with shared libs, fatal in a static-only wasm
sysroot). Same root cause as before: upstream's tree predates freetype-with-brotli, so
their fontconfig never linked brotli at all. Fix (documented, no upstream script edits):
promote the dep to public `Requires:` in the sysroot copy —
`sed -i 's/^Requires.private: libbrotlicommon/Requires: libbrotlicommon/'
wasm-sysroot/lib/pkgconfig/libbrotlidec.pc` — then rerun the idempotent chain.
Result: fontconfig built, `bootstrap complete` (build-0.1d.log). WebCore build now
running (BIB_JOBS=12). Both fixes + the curl-tier-first ordering go into the 0.1
reproducible-build script; report both upstream.

## 2026-08-10 — 0.1 two more host-environment fixes; WebCore compile started

- **Arch font paths**: build-webcore.sh stages DejaVu faces from the Debian path
  `/usr/share/fonts/truetype/dejavu/`. Arch keeps them in `/usr/share/fonts/TTF/`.
  Fix without touching the script: pre-stage `build/embedder-fs/` (9 faces +
  etc-fonts tree from the sysroot) so the script's guard skips its own staging.
- **CMake 4 incompatibility**: host cmake 4.4.0 fails configuring the pin at
  `WebKitMacros.cmake:311` (`_WEBKIT_TARGET_LINK_FRAMEWORK`) — unquoted empty
  `${_linked_into}` in an `if()`; only the Emscripten port leaves that property
  unset, and CMake ≤3.x tolerated it. No cmake pin in their decision-002. Fix:
  local CMake 3.31.7 binary in `engine/cmake-3.31.7-linux-x86_64/`, prepended to
  PATH for the build. CONFIGURE: OK; ninja running (BIB_JOBS=12, build-0.1f.log).

Fresh-bootstrap fix list for the 0.1 deliverable so far: (1) curl-tier before
webcore-deps for brotli, (2) libbrotlidec.pc Requires promotion, (3) font path
staging on non-Debian hosts, (4) cmake <4 required.

- **Ruby erb missing** (fix #5): Arch's ruby 3.4 no longer ships `erb` in the base
  package; WebCore's GenerateSettings.rb dies at `require 'erb'` ~1.7k targets in.
  Fix: `gem install --user-install erb`. Build resumed incrementally (build-0.1g.log).

## 2026-08-10 — 0.1 COMPLETE: engine built and verified

erb fix let the incremental build finish: NINJA OK, embedder.wasm 103 MB. Verified
with system Chromium headless: hello-demo gate PASS (exactBlue=20000, redGlyph=1962,
ticks alive), then https://example.com rendered through the engine over Wisp
(screenshot engine/logs/example-com.png; crossOriginIsolated true). Reproducible
build script: tools/build-engine.sh (5 fixes). Distilled → notes/engine-build.md;
open-questions #3 answered. WebCore compile itself ≈45 min wall at BIB_JOBS=12 —
much better than feared. Phase 0 exit gate: all five spikes done, tiers 0–1 green.

## 2026-08-10 — 1.5 leak check: 50 fixture navigations, heap flat

tools/smoke-leak.mjs: 50 engine navigations cycling grid/input/app.bstest
through the bridge (fixture-only). Reserved wasm heap (HEAPU8.length) stayed
at the initial 256 MB from boot through nav 50 — zero growth, so cumulative
leakage over 50 navs is bounded by the boot headroom. Caveat: reserved-heap
granularity can't see malloc churn inside the initial reservation; re-measure
with real malloc stats once bib_query "metrics" lands. Verdict: no leak
signal at MVP scale; bounds live in the script as tripwires (final <2.5 GB,
second-half growth <256 MB).

## 2026-08-10 — Phase-1 exit gate: 10-min real-site browse

tools/smoke-browse.mjs (real sites, sparing): Wikipedia (search by typing →
article → follow link), HN (front → comments), MDN (article → doc link),
TodoMVC ES6 (add 2 todos by typing, toggle by click) + mixed filler to the
10-minute mark, all input host-injected through the canvas.

Run 1: 10.2 min, engine alive throughout, 1 failure — TodoMVC load stalled
>180 s. Debug: loads fine standalone AND mid-MDN-load (4 s); transient
upstream stall + the dev transport has no request timeout (dev-only gap; the
extension bridge's idle-timeout guard covers this in production). Run 2
(site legs only, fixed a polling assertion): ALL PASS. Verdict: gate passed.

Findings for Phase 2: guest history.back() does not traverse (BackForwardList
wiring is part of 2.3, together with bib_stop/reload/go); MDN telemetry CORS
preflights fail loudly in-engine (harmless, blocklist candidates).

## 2026-08-10 — Phase-2 exit gate (MVP done): whitelist-by-default, real sites

2.6 flipped the shipping default: DEFAULT_STATE.mode = 'whitelist' and the
static catch-all is enabled in the manifest (fresh install intercepts with
zero stored state, SW not required). tools/smoke-mvp.mjs (real sites,
sparing) on a fresh profile: example.com omnibox-style nav → viewer,
nested commit + title→tab-title + pixel probe (#eee) all ok;
en.wikipedia.org sandboxed concurrently; whitelist edit swept the open
example.com viewer tab native, fresh example.com nav native, unlisted
wikipedia tab stayed sandboxed. ALL PASS. Tier 0–1: 28/28. Tier 2: 12/12
(new "default posture" scenario asserts the pre-storage fresh-install
redirect). Verdict: MVP gate passed.

## 2026-08-11 — Scroll perf at dpr != 1 (user report: loginasroot.net ~1fps)

Probe (experiments/perf-scroll-probe.mjs, ?perflog=1, synthesized wheel,
1600x860): dpr=1 scrolled fine (2-3ms strips, 8% busy) but any other dpr hit
~100ms full-viewport repaints at 98% busy (~10fps; ~1fps at real 4K) —
bibScrollBlit bailed whenever g_dpr != 1. Fix (engine af6f559): shift in
device px snapped to whole pixels with carried residual; axis-only damage
inflation (both-axes united strip+scrollbar into a frame-covering rect →
full-repaint chain, BIBSCROLL tracing found it); latched settle repaint
after fractional scrolling quiets; paintFrameRect culls +1 logical px at
fractional dpr (partial vs full paint AA hairlines — pre-existing). Viewer
coalesces wheel deltas per rAF tick. Verified: 2-5ms strips / ~12% busy at
dpr 1/1.25/1.5/2; scroll-roundtrip byte-identical at 1.5/1.25 (settle path;
dpr 1/2 leave the pre-existing header text-AA specks); post pages fine
(opacity:0 fixed overlay skipped via NotCompositedForNoVisibleContent).
Tier 0-1: 28/28, tier 2: 13/13.

## 2026-08-13 — Fast-scroll collapse: the engine renders stale scroll positions (user report)

User: "scroll is smoothish until I start scrolling faster, then it really slows down… it should not
drop to ~1fps". Reproduced and attributed with new instrumentation
(`experiments/scroll-speed-probe.mjs` + `scroll.bstest` fixture + BIBPERF wheel/blit counters).

Cause (design, not cost): `bib_wheel` applies one queued event at a time with no collapse and no
backpressure, so with events queued behind a paint the engine walks the framebuffer through every
intermediate scroll position — ~4 full-framebuffer shifts per presented frame, 3 of them computed
from input already known to be superseded. What makes that visible: `bibScrollBlit` does
O(framebuffer) work per event, and ~90% of it is
`SkCanvas::writePixels` mirroring the shift onto the SkSurface — an unpremul→premul per-pixel
conversion of nearly the whole framebuffer (9x the cost of the identical-size memmove into
`g_blitPixels`). The viewer's own per-rAF coalescing is verified working; nothing coalesces below
that boundary. At 60 events/s × ~15 ms (5.6 Mpx) that's ~900 ms/s of blitting whatever the frame
rate, and HiDPI multiplies the per-event constant by 4.

Numbers (fixture, plain text page, dpr 1, no sampler): 1600x860 holds ~59 fps to 14400 px/s but
already burns 190-210 ms/s in the blit vs 104-173 ms/s painting; 3200x1760 gives **15 fps at 900
px/s** with 749 ms/s in the blit vs 79 ms/s painting. Decisive control at 3600 px/s / 5.6 Mpx:
56 wheel events/s → 96% busy, 9 events/s (same distance) → **28% busy**. Real site
(en.wikipedia.org/wiki/Web_browser @1600x860, 3600 px/s): 10 fps at 96% busy.

Also found: BIBPERF's `busy%` excluded every proxied input task (all of `bib_wheel`), so a
scroll-saturated thread reported ~50% idle — now folded in. Measurement traps that faked earlier
results are in notes/perf-measurement.md (readback sampling was 70% of the signal; inherited input
backlog swung runs 2-8x; wheel at a canvas corner scrolled Wikipedia's sticky sidebar instead;
`Emulation.setDeviceMetricsOverride` left the framebuffer size unchanged so the dpr sweep measured
nothing).

Filed issues/engine-renders-stale-input-state.md. Fix: collapse pending positional input (wheel,
mouse move) to the latest known state before rendering — discrete input (keys, clicks) still
replays one by one. Secondary: shift the surface in place via `peekPixels` instead of
`writePixels`, or wrap the surface over `g_blitPixels` and drop the second mirror. Not fixed here.

## 2026-08-14 — Startup race: is it real, and does the sweep actually catch it?

Question left open by spike 0.5 (one blacklisted startup URL loaded natively): install-only
or not? unpacked-only or not?

Ran three probes against Chromium 151 (scripts were throwaway; recipe below is enough to redo).

1. **Startup URL, unpacked (`--load-extension`) + packed.** Chromium spawned directly (playwright
   refuses a positional URL; attach over CDP afterwards) with `https://grid.bstest/startup-race` as
   the startup arg. Packed variant: fresh RSA key → manifest `key` + regenerated catchall for that
   id → `--pack-extension` → install via `<user-data-dir>/External Extensions/<id>.json`. The
   fixture-server oracle recorded a `sec-fetch-dest: document` hit **plus a favicon fetch** in
   every run — the target loaded, committed and rendered natively — and the tab was only then in
   the viewer. Same on install *and* on the 2nd/3rd launch of an already-installed packed
   extension. So: not install-only, not an unpacked-loading artifact; every browser start with a
   startup/handoff URL burns one native page load.
2. **How big is the window?** Startup page beaconing `fetch('/b')` every 10 ms from a local
   server: first beacon ~25 ms after the document request, last beacon 61-116 ms after it (5 runs
   each, pre- and post-fix). ~100 ms of native JS, once per browser start.
3. **What does the sweep see?** A tab mid-navigation (server accepts, never answers) is reported
   by `chrome.tabs.query` as `url: 'about:blank'` + `pendingUrl: <target>`. `sw.mjs` read
   `tab.url ?? tab.pendingUrl` — nullish, so 'about:blank' won — meaning **the sweep missed
   exactly the tab it exists for** whenever the racing navigation hadn't committed yet, and that
   tab then stayed native indefinitely. Also found while fixing it: the sweep ignored escape
   hatches, so the next reconcile (any storage write / SW wake) yanked an "open natively" tab back
   into the viewer.

Fixed both (`sweepAction()` in dnr-rules.mjs; grants mirrored in `storage.session`); tier-0 unit
tests + tier-1 `sweep.test.mjs` (both regressions fail on the old code). Also tried sweeping the
sandbox direction *before* the DNR round-trips in `doApply` — no measurable effect (the window is
SW-startup-bound, probe 2), so it was reverted rather than kept as complexity. The residual
~100 ms is a hard MV3 limit; documented in security.md § Startup race and issue deleted.
Tier 0-1: 78/78, tier 2: 21/21.

## 2026-08-14 — youtube.com aborts the engine (user report: "engine crashed — reload")

Reproduced in ~3 s, first try: `youtube.com/watch?v=…` in the dev harness → `[bib] abort: ` (empty
reason) → `Aborted()` → dead worker. No message anywhere, because the build has no `-sASSERTIONS`
and a bare `RELEASE_ASSERT` carries no text.

Triage trick (now permanent, testing.md § Crash triage): the wasm has a 12 MB name section, and
Emscripten calls `Module.onAbort` *synchronously* from `abort()` — so a `new Error().stack`
captured there is a named C++ backtrace. It read, bottom-up:
`jsDocumentPrototypeFunction_startViewTransition` → `Document::setActiveViewTransition` →
`RenderLayerCompositor::enableCompositingMode` → `ensureRootLayer` → `GraphicsLayer::create` →
`WTFCrashWithInfo`. YouTube's kevlar bootstrap calls `document.startViewTransition()`;
`GraphicsLayer::create` is our `RELEASE_ASSERT_NOT_REACHED` stub (no compositor in this port), and
`setActiveViewTransition` forces compositing mode without consulting
`hasAcceleratedCompositing()`.

Fix, two layers: embedder turns the feature off (`setViewTransitionsEnabled(false)` +
cross-document; the IDL is `[EnabledBySetting]`, so YouTube feature-detects and takes its plain
path), and the WebKit patch makes `enableCompositingMode(true)` a no-op while accelerated
compositing is off — `LocalFrameView::enterCompositingMode` is the same unguarded shape and would
have been the next crash. Result: watch page and home page render fully and survive; playback
fails cleanly as designed ("Your browser can't play this video"). Tier-2 scenario 17 pins the API
absent; scenario 12 now also asserts the named abort stack.

Trap found while wiring the stack hook: Emscripten proxies the page Module's `onAbort` into the
pthread worker, but only into a slot that is empty or `.proxy`-marked — a plain assignment in
pre-js swallowed the crash notification outright (crashed-UI never appeared, tier-2 scenario 12
caught it). The hook is an accessor that captures the stub and chains it.
