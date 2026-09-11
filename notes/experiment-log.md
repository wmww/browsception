# Experiment log

Append-only lab notebook (notes/testing.md § Lab notebook). Raw record here;
distilled conclusions get promoted into the other notes in the same change.

Historical record — entries are not rewritten. Paths have since moved:
`spikes/probe-ext/` → `test/fixtures/probe-ext/`, `spikes/blit/` → deleted
(numbers in open-questions #10, code in `src/ext/blit.mjs`),
`experiments/*.mjs` → `scripts/`.

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
build script: scripts/build-engine.sh (5 fixes). Distilled → notes/engine-build.md;
open-questions #3 answered. WebCore compile itself ≈45 min wall at BIB_JOBS=12 —
much better than feared. Phase 0 exit gate: all five spikes done, tiers 0–1 green.

## 2026-08-10 — 1.5 leak check: 50 fixture navigations, heap flat

scripts/smoke-leak.mjs: 50 engine navigations cycling grid/input/app.bstest
through the bridge (fixture-only). Reserved wasm heap (HEAPU8.length) stayed
at the initial 256 MB from boot through nav 50 — zero growth, so cumulative
leakage over 50 navs is bounded by the boot headroom. Caveat: reserved-heap
granularity can't see malloc churn inside the initial reservation; re-measure
with real malloc stats once bib_query "metrics" lands. Verdict: no leak
signal at MVP scale; bounds live in the script as tripwires (final <2.5 GB,
second-half growth <256 MB).

## 2026-08-10 — Phase-1 exit gate: 10-min real-site browse

scripts/smoke-browse.mjs (real sites, sparing): Wikipedia (search by typing →
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
zero stored state, SW not required). scripts/smoke-mvp.mjs (real sites,
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

## 2026-08-14 — Fix: collapse positional input; shift the surface in place

**Hypothesis** (from the 08-13 write-up): the scroll defect is *rendering superseded states*, not
slow scrolling. Merging queued positional input should raise the frame rate without touching the
paint path, and shifting the SkSurface's own pixels should remove the unpremul→premul conversion
that made each blit expensive.

**Changes** (engine `src/embedder/main.cpp`): wheel/mouse-move argument packs stay *open* for
merging while their proxied task is queued; `bibProxyToEngine` seals them when any other task is
posted (order preserved, discrete input never merged). Batch breaks on modifier change, direction
reversal, dominant-axis change, or a guest `preventDefault()` (`EventHandling::DefaultPrevented`).
`bibScrollBlit` mirrors its row walk onto the surface via `notifyContentWillChange` +
`peekPixels` instead of `SkCanvas::writePixels`.

**A/B** — same session, staging the pre-change artifact and the new one alternately
(`scripts/scroll-speed-probe.mjs`, `scroll.bstest`, dpr 1). Note the 5.6 Mpx rows are *sampled*
runs (the sampler costs a full-frame readback per sample — it perturbs both sides equally and is
what exposes the backlog):

| fb | px/frame | fps before → after | busy | wheel ms/s | blit ms/s (mv/wr) | queue max | tail ms |
|---|---|---|---|---|---|---|---|
| 3200x1760 | 60 | **2.0 → 18.1** | 96 → 56% | 968 → 111 | 913 → 90 (97/816 → 38/52) | 74 → 2 | 1684 → 160 |
| 3200x1760 | 240 | **0.5 → 12.0** | 80 → 86% | 984 → 71 | 905 → 53 (234/669 → 25/28) | 47 → 3 | 4538 → 296 |
| 1600x860 | 60 | 58.6 → 57.2 (60 cap) | 49 → 32% | 274 → 106 | 209 → 42 (18/190 → 22/19) | 2 → 1 | — |
| 1600x860 | 240 | 57.2 → 57.7 | 75 → 69% | 232 → 112 | 176 → 49 (21/155 → 19/29) | 2 → 2 | — |
| 1600x860 | 960 | 39 → 34 | 99 → 99% | 46 → 34 | all fallbacks (full repaints) | 3 → 2 | — |

`efficiency` (scrolled px / dispatched px) stays **1.0** on both sides: merging loses no distance.
The 960 px/frame row is paint-bound — every delta exceeds the viewport, so the blit never runs and
the fix has nothing to do there (the 39 vs 34 spread is run-to-run noise; a repeat of the same
pair gave 33.6/33.7 new vs 39.2/28.0 old). 1.4 Mpx never backlogged, so it shows the *cost*
falling, not the frame rate rising — and the second old-engine run of each pair degraded (45 fps
at 85% busy, 26 fps at 91%) where the new engine repeated within 0.5 fps, which is the headroom
showing up as stability.

**Care needed**: a neighbouring worktree built + staged its own artifact mid-run, and the first A/B
round silently measured *its* engine (identical numbers to the old one, since it lacked this
change). Tooling closed this 2026-08-14: stamps name their builder, `stage-engine --list` shows
identity, pins (`--from`, sticky vs `--if-stale`) print provenance, and engine-backed runs print
the staged stamp + a warning if a build is concurrently running. For an A/B: pin each side by
stamp, and check the printed `engine:` line in the probe output.

**Also**: tier-2 scenario 19 (wheel burst → click) guards the two invariants no perf number covers
— distance conserved, and nothing merged past a discrete event. `bib_abi.h` documents the
coalescing as guest-visible.

## 2026-08-14 — JS speed: us (JSC CLoop) vs firefox-wasm (SpiderMonkey PBL) vs V8

**Hypothesis** (from the firefox-wasm comparison, prior-art.md): Gecko's Portable Baseline
Interpreter is a real no-JIT tier and should beat our CLoop by ~2-4x, making "their JS feels
better" true and Gecko-for-PBL a live option. **Result: false on measurement — our CLoop is
1.3-3x FASTER than their PBL on the same bodies.**

**Method.** Eleven small bodies (property mono/poly, call, int/float arith, dense array, alloc,
string scan/build, JSON round-trip, Octane Richards), best-of-2 (Richards best-of-3), each shipped
as ONE eval and timed by the host wall clock around that eval, guest-reported `Date.now()` printed
alongside. Ours: `scripts/js-speed-probe.mjs` (dev harness `__bib.eval`, engine
`20260814-083049-d1ff7e9-main`). Theirs: the public demo (developer.puter.com/labs/firefox-wasm/)
driven via its `window.geckoEvalChrome` hook, defaults = GPU on / **wasm JIT off** → PBL; their
eval buffer is 8190 B and each eval gets a fresh sandbox (no state persists), so every body had to
be self-contained (Richards minified to 7.7 KB). Same machine, same Chromium, same session.

| bench | V8 (ms) | ours CLoop | their PBL | ours ÷ V8 | theirs ÷ ours |
|---|---|---|---|---|---|
| prop-mono | 2 | 82 | 137 | 41x | 1.7 |
| prop-poly | 1 | 42 | 56 | 42x | 1.3 |
| call | 2 | 55 | 146 | 28x | 2.7 |
| arith-int | 2 | 73 | 158 | 37x | 2.2 |
| arith-float | 2 | 25 | 75 | 13x | 3.0 |
| array-dense | 3 | 23 | 70 | 8x | 3.0 |
| alloc | 3 | 32 | 97 | 11x | 3.0 |
| string-scan | <1 | 11 | 33 | ~20x | 3.0 |
| string-build | 15 | 23 | 27 | 1.5x | 1.2 |
| json | 7 | 23 | 16 | 3.3x | 0.7 |
| richards | <1 | 2 | 9 | — | 4.5 |

**Reading it.** Interpreted JS is 10-40x V8 on tight loops and only 1.5-3x on builtin-dominated
work (string-build, JSON) — i.e. our real cost is *bytecode dispatch*, not the runtime. The two
interpreters are in the same league and ours is ahead; the published "PBL is 2.2-4.4x an
interpreter" figure is **PBL + weval** (AOT partial evaluation), and firefox-wasm ships PBL
*without* weval.

**Caveats** (do not over-claim this): their engine ran the whole Firefox front-end + WebRender
threads concurrently while ours sat idle on about:blank (contention inflates their side by an
unknown amount, plausibly tens of percent, not 3x); their eval runs in the chrome sandbox; their
build sets `GECKO_COARSE_CLOCK=1` (host wall times tracked the inner numbers, so ordering holds);
these are micros — real-page JS is megamorphic/DOM-bound, exactly where PBL's CacheIR ICs should
show best, so the gap could narrow or reverse there. A real-page A/B is the follow-up if this ever
matters.

**Decisions.** (1) The perceived smoothness of firefox-wasm is NOT JS — it is compositing/APZ/GPU
and host WebCodecs (prior-art.md). (2) "Adopt Gecko for JS speed" is off the table until someone
measures a real page; the interesting AOT target was always weval, not PBL. (3) `scripts/
js-speed-probe.mjs` kept as the repeatable half.

**Fallout:** the engine links emscripten's full GL library (WebGL context creation + GL calls are
live imports) though `bibGPU:false` — issues/engine-links-webgl-imports.md. And one run showed
`Array.prototype.join` returning a non-string under CLoop inside a long eval —
issues/cloop-join-returned-nonstring.md.

---

## 2026-08-14 — Bench suite bring-up: is it repeatable, and does it see a planted regression?

**Setup**: `scripts/bench/run.mjs` (new), headless Chromium 151, engine
`20260815-024910-d1ff7e9-dirty-wt_exGITbYkRGPnAr4G`, 1600x900 unless noted, 3 reps x 4 s
windows, osprey (Ryzen AI 9 HX 370, 24 threads). Numbers are per-machine and live in the
main checkout's gitignored `bench/`; this entry keeps the ones the questions below turn on.

**Baseline** (`bench/quiet1.json`, medians):

| scenario | fps | busy% | paint ms/s | frame ms | host present ms/s | other |
|---|---|---|---|---|---|---|
| text-scroll | 60.0 | 18 | 107 | 1.8 | 27 | eff 1.000, tail 4 ms, 0.10 Mpx/frame |
| article-scroll | 59.9 | 34 | 193 | 3.2 | 26 | 1.9x text-scroll on paint and frame ms |
| text-scroll-2560 | 37.0 | 19 | 87 | 2.4 | 45 | host present 1.6x the 1600x900 pass |
| article-scroll-2560 | 34.7 | 28 | 142 | 4.1 | 43 | |
| app-update (Preact) | 29.7 | 34 | 36 | 1.2 | 7 | 30 updates/s |
| input-latency | — | ~0 | 2 | 0.6 | 1 | click 16.1 ms, key 16.2 ms, burst 15 ms |
| boot-trivial | | | | | | ready 383 ms, load complete 539 ms, page pixels 534 ms |
| boot-article | | | | | | ready 329 ms, load complete 724 ms, page pixels 559 ms |

**Q1 — repeatable?** Two back-to-back full runs on the same staged engine (`quiet1` ->
`quiet2`, machine load ~3): **every headline metric inside the noise band, zero flags.** The
earlier attempt at load ~20 vs ~8 flagged app-update (fps +20%, updates/s +25%) — the machine,
not the engine, which is why load1 is recorded per run and `--compare` now warns when it moved.

**Q2 — planted regression?** `--viewer-params 'rcap=5'` vs baseline: app-update 24.8 -> 5.0 fps
and 24.0 -> 5.0 updates/s (flagged WORSE); `rcap=1` takes it to 1.0/1.0. Scroll and input were
untouched at both settings — the rendering-update cap prices rAF-driven rendering only, not the
scroll blit path or input-response repaints (measured table in
issues/rcap-dynamic-budget.md; the latency half of the plan's expectation was wrong about this
engine, not unmeasured).

**Q3 — decoupled from the target?** Ran the *current* runner against a worktree of `890f17b`
(pre input-collapse) via `--ext .../bs-retro/src`: all 8 headline scenarios completed, the
record carries target `890f17b` vs runner `ee64673`, every host hook was present on that older
viewer, and the delta table against `quiet1` came out clean. Note the engine was NOT
contemporaneous — no archived artifact matches those sources any more, so `stage-engine` fell
back to today's build. That is the retro depth limit in practice, and the reason
`engine/artifacts/keep/` (pruning-exempt) now exists.

**Instrument checks worth keeping**: input latency is timestamped on the frame carrying the
response pixel (read out of the framebuffer inside the `bibFrame` wrapper), so its floor is one
frame — 16 ms here, unchanged at a 3840x2160 framebuffer where only the small dirty rect
repaints (host longtask ms/s went 0 -> 187 in that run: the *host's* 4K blit is the cost, not
the engine's). Response colours must be matched exactly: with a tolerance, the pixel already on
screen answers instantly and every latency reads ~0.

**Diagnostic tier** (1 rep, for the record): paint-heavy-scroll 45.6 fps / 97% busy / 918 ms/s
paint / 20.1 ms per painted frame — box-shadow+blur+gradient raster is ~9x text-scroll's paint
cost and is the only headline-or-diagnostic workload that saturates the engine thread;
image-scroll 55.5 fps / 47% busy / 250 ms/s; sticky-scroll 59.9 fps / 35% busy / 181 ms/s,
within ~6% of article-scroll's paint cost — a hint that the TOC scroll handler is not where
article-scroll's cost sits, though the two pages differ in content as well, so it is a pointer
for a follow-up, not a subtraction.

---

## 2026-08-15 — Wikipedia painted 1.38 Mpx/frame (the whole viewport) while scrolling

**Hypothesis**: Vector 2022's TOC tracker dirties layout each scroll tick; the top-level grid
containers self-relayout to identical geometry and each issues a full self-repaint.

**What ran**: caller-tagged instrumentation on `RenderElement::repaintAfterLayoutIfNeeded` plus a
`repaintUsingContainer` rect log, probed with `scripts/scroll-speed-probe.mjs` on
`en.wikipedia.org/wiki/Solar_eclipse_of_August_12,_2026`, 1600x860, 60 px/frame.

Findings, in the order they fell out:
1. Both blanket-repaint callers fire, ~40/s each: `LayoutRepainter` (mw-content-container,
   mw-footer-container) and the layer-position pass (vector-column-start/-end, #bodyContent).
   The layer bit comes from `RenderObject::setNeedsLayout` → `setLayerNeedsFullRepaint`.
2. An earlier session concluded that setter "never fires" — a **logging artifact**: the probe
   only forwards console lines matching `/BIB(PERF|SCROLL|DMG|REPAINT)/`, and the log line was
   named `BIBFULLREPAINT-SET`. Name engine diagnostics `BIBREPAINT-*`.
3. Suppressing both blanket repaints changed nothing (still 1.31 Mpx/frame). The remaining damage
   was the *decoration delta* tail of `repaintAfterLayoutIfNeeded`: mw-content-container's border
   box measures 0 → 13997 tall across its own layout while its clipped overflow rect is unchanged,
   so `damageExtentWithinClippedOverflow` covered its whole height — for a box with no decorations
   at all. Gating that section on decorations dropped the painted area immediately.

**Numbers** (steady state, no diagnostics in the build, `--sweep 60 --nosample`):

| page / size | Mpx/frame before → after | fps before → after | busy before → after |
|---|---|---|---|
| Wikipedia 1600x860/900 | 1.38 → **0.30** | ~31 → **60** | 99% → 31-36% |
| Wikipedia 2560x1330 | 3.30 → **0.45-0.61** | ~31 → 31-37 | 99% → 29-46% |
| scroll.bstest 1600x900 | 0.18-0.20 → 0.18-0.24 | 60 → 60 | unchanged |
| scroll-sticky.bstest 1600x900 | ~0.45 → 0.45-0.49 | 60 → 60 | unchanged |

**Decision**: keep (see engine-internals.md § `selfNeedsLayout()` and § decoration delta). At
2560x1330 the engine is no longer paint-bound — the same probe on `scroll.bstest` also caps at
35-37 fps with the engine 20% busy, i.e. that ceiling is host-side presentation, not the engine.
Roundtrip pixel-exactness (scroll + sticky, dpr 1 and 1.5) and all 24 tier-2 scenarios pass.

---

## 2026-08-15 — Scroll-up duplicated-band glitch: the "accepted" present tear was user-visible

**Symptom** (user screenshot, wikipedia, dark mode, ~2880px window): scrolling UP shows a clean
full-width horizontal seam; everything above it is an older frame, everything below the current
one — content duplicated across the seam by exactly the scroll delta (160 device px there).

**Hunt**: settled-state framebuffer always diffed clean against a forced repaint (damage
accounting is NOT the bug), and CDP-driven wheel bursts never reproduced anything — the engine
idles between presents at CDP event rates, and headless SwiftShader's texSubImage2D reads too
fast to overlap a blit. Reproduced only with BOTH: wheel events dispatched in-page at trackpad
rate (2ms gaps) and a paced multi-ms read of the pushed band inside `Module.bibFrame` (stand-in
for a real GPU upload window). Then: 51-73 torn presents per ~120 (both directions mutate
mid-present, paints included), and scroll-UP presents carry the clean shift signature
(`buf2[row] == buf1[row-delta]`) because the blit's dy>0 memmove walks BOTTOM-UP against the
top-down reader — one guaranteed crossing, pre-shift above / post-shift below. Scroll-down walks
top-down with the reader: no clean band, which is why the user saw it "specifically scrolling
up". Dumped torn frame visually matches the screenshot (duplicated TOC/headings, sliced text
row at the seam).

**Fix**: `g_presentPixels` — bibPushFrameIfDirty memcpys the dirty band on the engine thread,
posts bibFrame at the snapshot, one frame in flight (`_bib_present_done` from the EM_ASM's
finally; while in flight skip paint, damage coalesces — the GPU bitmap path's pattern).
Retire-list for resize; forced readbacks re-arm g_uploadRect (they used to consume pending
damage without the canvas ever seeing it).

**Numbers** (bench suite, 3-5 reps, pre-fix vs fix): fps unchanged on every scenario
(text/article × 1600/2560, app-update, input-latency, boots; article-2560 36.4→36.8,
text-2560 37.2→36.6 within ±4-7% noise). Engine busy +3pp @1600 (18→21, 33→37), +3-7pp @2560
(19→22, 32→39) — the per-presented-frame band memcpy (~full height during scroll). Present
coherence tripwire = tier-2 scenario 21: pre-fix 51/407 torn, post-fix 0/anything, both
directions.

**Decision**: coherence is worth single-digit busy pp with fps flat; "tearing accepted" is
retired from the ABI/comments. The host-present ceiling issue is unchanged (upload band size
identical).

## 2026-08-15 — Dropping the dead GPU path: does removing 690 lines of it cost anything?

**Hypothesis**: the engine's WebGL/Ganesh code has been unreachable since the CPU-raster present
landed, so deleting it (and the link flags that import emscripten's GL table) is free — no
behaviour change, no perf change, ~700 KB less wasm.

**Why it mattered**: not size. security.md accounts for the engine's capabilities by its *import
list*, and the module imported 278 `gl*` + 5 `egl*` + 3 `emscripten_webgl_*` functions. Nothing
called them (`bibGPU: false`), so "an owned engine cannot reach the GPU driver" was an argument
about reachability — exactly the kind of argument a memory-safety bug in the engine invalidates.
The EGL five came in through `PlatformDisplay.cpp`/`GLDisplay.cpp`, which are upstream WebCore
files this port compiled; the 278 came from Skia's Ganesh GL backend, pulled by
`GrDirectContexts::MakeGL` in upstream `PlatformDisplaySkia.cpp`. Neither is reachable from the
embedder's link flags alone — dropping `-sMAX_WEBGL_VERSION`/`-sFULL_ES3` got the count to
164/0/1, and the rest needed the WebKit patch.

**What ran**: full removal (embedder link flags + `--wrap=pthread_create`/OFFSCREENCANVAS
machinery, `main.cpp` GPU boot/present/context-loss/software-bench, engine-pre.js's ImageBitmap
present bridge, the harness's `gpu-bitmap`/`gpu-implicit` present modes, and WebCore-side
`PlatformDisplay.cpp` + `egl/GLDisplay.cpp` + `PlatformDisplayEmscripten.*` + Skia's
`SkiaGLContext` world → GL-free stubs in `GLStubsEmscripten.cpp`). Then tiers 0-2 and a
back-to-back bench A/B (old artifact staged, new artifact staged, same session, same load).

**Numbers**: wasm imports 377 → 88 — the 289 gone are 278 `gl*` + 5 `egl*` + 3
`emscripten_webgl_*` + the present hooks. `embedder.js`
268,634 → 159,226 B; `embedder.wasm` 104.11 → 103.43 MB; `main.cpp` 2989 → 2299 lines; WebKit
patch 77 → 75 files, 3378 → 3142 lines. Tier 0/1 (79) and all 26 tier-2 scenarios green.

Bench, three passes (headline matrix pre; same matrix post under load; then a quiet back-to-back
A/B, old artifact staged then new, one session): every engine-side delta is inside run-to-run
spread and the SIGN flips between passes — article-scroll paint ms/s read 212 (old, quiet), 268
(old, A/B), 229 (new, loaded), 220 (new, A/B), so the loaded pass's "+8-24% paint" and the A/B's
"BETTER, -18%" are the same noise seen from two sides. fps, click/key latency, boot, scroll
efficiency and Mpx/frame flat throughout. Expected: nothing on the raster path was touched —
`RenderingMode::Unaccelerated` was already what `g_gpu == false` selected, and every deleted
branch was behind `if (g_gpu)`.

**Method note**: the first post-run started at load 4.4 vs the baseline's 0.4 and reported paint
up 8-24% with fps flat — a shape that looks like a real paint regression. The quiet back-to-back
A/B (both artifacts, one session, load ~1.5) is what settled it. Bench comparisons across
sessions are worth about ±20% on the ms/s metrics on this box; only same-session A/B pairs carry
smaller deltas.

**Trap worth keeping**: `crt1_proxy_main` unconditionally marks the proxied-main
`pthread_create` with a `(char*)-1` transferred-canvas sentinel, which is why the embedder carried
a `__wrap_pthread_create` interceptor. With `-sOFFSCREENCANVAS_SUPPORT` off, emscripten's pthread
JS never reads that field, so the wrap could go with it.

**Decision**: no GPU code in the engine at all; the security claim is now a property of the import
list, enforced per-commit by tier-0 `engine-imports.test.mjs` (it fails on any pre-2026-08-15
artifact). Contract for keeping it true: engine-build.md § No-GPU link contract.

## 2026-09-09 — One engine build, worker-hosted, on Chrome and Firefox (plans/one-engine-both-browsers.md)

**Hypothesis**: a non-pthread link hosted in a plain dedicated Worker (frames and bytes crossing
by transferable buffers) matches the `-sPROXY_TO_PTHREAD` link on fps and input latency, since
the engine was single-threaded in practice anyway and the copy count is unchanged.

**Setup**: same tree, two links from `embedder.cmake` (`20260909-212732-…-proxy` = old viewer +
proxy artifact, staged into a `git archive HEAD src` copy; `20260909-213513-…` = plain link +
worker-hosted viewer). `node scripts/bench/run.mjs --ext <old> --save proxy-link`, then
`--save plain-link --compare proxy-link`; 3 reps × 4 s, headless Chromium 152, machine load ~1.3–2.5.
(`host present ms/s` reads 0 on the new path — the present happens inside the link's message
handler and is not separable; not a win.)

| scenario | metric | proxy | plain |
|---|---|---|---|
| text-scroll 1600 | fps / busy% | 59.6 / 20 | 59.8 / 20 |
| article-scroll 1600 | fps / busy% | 60.0 / 37 | 59.3 / 37 |
| text-scroll 2560 | fps / busy% / rAF p95 | 35.7 / 24 / 46.9 ms | 34.0 / 22 / 30.9 ms |
| article-scroll 2560 | fps / busy% / Mpx per frame | **37.6** / 42 / 0.61 | **31.2** / 36 / 0.71 |
| app-update | updates/s | 30.2 | 29.7 |
| input-latency | click / key / type burst ms | 16.4 / 16.3 / 17 | 16.3 / 16.3 / 15 |
| boot-trivial | engine ready / first frame ms | 459 / 549 | 428 / 526 |
| boot-article | engine ready / load complete ms | 402 / 784 | 350 / 705 |

**Result**: at 1600x900 and for input latency, boot and app-update the two links are within
noise (the plan's gate). Boot is 5–13% faster (no pthread pool spin-up). At 2560x1330 the
plain link is worse on the article page: −17% fps with the engine *less* busy (42 → 36%) and
more pixels per presented frame — the host present path, not the engine, is the limit, and it
now includes a 13 MB band transfer + postMessage scheduling per frame on top of the upload
(text-scroll-2560 shows the same direction, −5%, inside its ±17% spread). That is exactly the
open risk the plan named; the answer it named too — an OffscreenCanvas presenter inside the
engine worker, no transfer, no main-thread upload — is now a local change
(rendering-input.md option 2, issues/host-present-ceiling-large-fb.md).

**Also in this change**: Firefox 155 runs the same artifact (probe table in open-questions #13;
`test/tier2/firefox.test.mjs` 7/7); Chrome tier-2 29 scenarios green; scenario 21 (present
coherence) retired because the worker copies the band out synchronously.
**Decision**: ship the plain link on both browsers; the proxy link stays an `EXCLUDE_FROM_ALL`
target. The 2560 regression goes on the existing host-present issue.

## 2026-09-09 — Firefox: `http://google.com/` "network error", Chrome fine

**Hypothesis**: a redirect the capture misses on Firefox (the day-old port had handled only the
server-3xx-from-`onHeadersReceived` shape).

**What ran**: `scripts/probe-firefox.mjs`-style probes from an extension page (fresh headless
profile, port forcing cleared so the real internet is reachable), logging every webRequest event
for `fetch(url, {redirect:'error', credentials:'omit', cache:'no-store'})`; then the real
`dist/firefox` extension driven to `viewer.html?url=http://google.com/`.

**Findings** (Firefox 155.0.1):
- Fresh profile: `http://google.com/` → 301 captured fine → `http://www.google.com/` → 302 →
  `https://www.google.com/?gws_rd=ssl` → 200 → **"the engine refused it (Response contained
  invalid HTTP headers)"**. webRequest delivered Google's 8 `Set-Cookie` lines as ONE value with 7
  `\n`s; the engine's `containsInvalidHTTPHeaders` trips on any newline. Any multi-cookie site.
- After a `Strict-Transport-Security` has been seen for a host (the user's profile has one for
  `www.google.com`): `http://host/` → `onBeforeRedirect {statusCode: 0, redirectUrl: https://…}`
  → the SAME requestId continues to https → its `onHeadersReceived` under the https key → the
  fetch **resolves** (github) or rejects if that hop redirects (wikipedia). The bridge took the
  status-0 entry as "not a redirect": exactly the reported strip, `couldn't load http://… —
  network error (NetworkError when attempting to fetch resource.)`, reproduced verbatim through
  the real extension on `http://wikipedia.org/`.
- The built-in HSTS preload list did not upgrade extension fetches (`http://wikipedia.org/`,
  `http://github.com/` went out plain in a fresh profile); dynamic HSTS did.
- A DNR `redirect` rule on an xmlhttprequest fetch: no `onBeforeRedirect`, no headers, only
  `onErrorOccurred NS_BINDING_ABORTED`. Unfixable from the outside; we never redirect our own
  bridge traffic.
- Harness: `network.socket.forcePort` sends every port-80/443 connection to the fixture ports
  (live sites hang there); Firefox does not start inside the sandboxed agent shell at all.
  Firefox ignored the fixture's STS header behind `acceptInsecureCerts`: pkix rejects a CA:TRUE
  self-signed leaf as an end entity and a `*.bstest` wildcard (one label after the `*`), so the
  fixture cert became a CA + leaf naming every host, the CA imported with `certutil`.

**Decision**: capture splits `\n`-joined values; a status-0 `onBeforeRedirect` becomes a 307
entry, its requestId's later events dropped; the bridge reports a redirect entry as the hop even
when the fetch resolved (cancelling the body). Google loads on Firefox
(`https://www.google.com/?gws_rd=ssl`, title "Google"). Tier-0 66, tier-1 34, Firefox tier-2
9/9 (two new), Chrome tier-1 bridge unchanged.

## 2026-09-09 — Dropping the pinned extension id (plans/dynamic-id.md)

**Hypothesis**: the only thing forcing a build-time extension id was the *static* catch-all
ruleset — a `regexSubstitution` must be an absolute URL, so `rules/catchall.json` baked
`chrome-extension://niccek…/ext/viewer.html?url=\0` and the manifest pinned the matching `key`.
Firefox already ran the same rule dynamically. Make Chrome do the same and both packages become
id-agnostic, which is what a store install needs (distribution.md).

**What ran**: catch-all always dynamic (`desiredRuleState` returns `{dynamicRules, sessionRules}`);
`applyPlan`, `CATCHALL_RULESET_ID`, `enabledStaticRulesets`, the SW's `getEnabledRulesets` /
`updateEnabledRulesets` pair, the manifest `key` + `rule_resources` and `src/rules/` all deleted.
Harness gained `extensionId(context)` (reads the id off the extension service worker's URL);
`extensionIdFromManifest` survives for the probe extension only, which keeps its key because
tier-1 tests static rules with the SW killed on purpose.

**Numbers / results**: tier-0 63, tier-1 34, tier-2 Chrome 38, Firefox 8/9 (the failure is the
known issues/firefox-tier2-crash-reload.md, identical before the change). `npm run release`
clean. dist/chrome loaded unpacked in a throwaway profile: id `cdhcaoknjhmm…` (path-derived, not
`niccek…`), the runtime redirect URL carries that id, a fresh-profile `https://other.bstest/`
lands in the viewer, badge `S`, and after a full browser restart the catch-all is still in
`getDynamicRules` and still intercepts.

**Decision**: shipped. Two properties fall out: the reconcile is now ONE atomic
`updateDynamicRules`, so the "gap must never intercept less" ordering problem is gone rather than
managed (security.md); and a fresh install has a new millisecond-scale window before `onInstalled`
installs the rule — no navigation is in flight then, and the sweep covers it as it does the
startup race.

## 2026-09-10 — Google captcha loop: wire UA vs guest UA

**Hypothesis**: Google search in a viewer tab captchas and keeps refusing after the captcha is
solved. The bridge's base DNR rule stamped the host's `navigator.userAgent` (Chrome/Firefox on
Linux) on every request and stripped `sec-ch-ua*`, while guest JS reports the engine's
`standardUserAgent()` (Safari 17 / X11). Header-vs-fingerprint mismatch is a classic bot score.

**What ran**: `user-agent` moved from the bridge's DROP set to the DNR-carried set; first
engine-sent UA re-installs the base rule with it (`Bridge#adoptUA`), differing ones ride the
per-request rule; viewer stops passing the host UA. Scratch probe (headless Chromium 152, real
engine): fixture oracle wire UA, guest `navigator.userAgent`, then
`https://www.google.com/search?q=browsception+webkit+wasm`; same script re-run on the stashed
old code from the same IP within minutes.

**Numbers / results**: new code: wire UA == guest UA (`…AppleWebKit/605.1.15 … Version/17.0
Safari/605.1.15`), Google → results page, title "… - Google Search", no captcha, twice. Old code:
wire UA `HeadlessChrome/152` → `/sorry/index` ("unusual traffic") on the FIRST request. Side
probe: a DNR session rule CAN set `sec-fetch-mode/dest/site/user` on bridge fetches (Chrome).
Tier-0/1 35, tier-2 Chrome 38, Firefox 8/9 (known crash-reload).

**Decision**: shipped. Sec-Fetch fidelity filed as issues/sec-fetch-fidelity.md — not needed for
Google from this IP, but it's the remaining fetch-vs-navigation tell.

## 2026-09-10 — Wire-header audit through the real extension

**Hypothesis**: after the UA fix, what else on the wire differs from what the engine asked for?

**What ran**: scratch probe — headless Chromium 152 + real extension, fixture oracle
`/__requests` for the wire side, a wrapper on `__bs.link.onNetBegin` for the engine side;
navigation, same-origin fetch/XHR, cross-site cors/no-cors fetch, `<img>`, `<script>`, POST,
reload, http target.

**Results**: UA, Cookie, Referer (policy-correct), Origin (POST/cors only), Accept (engine's),
Upgrade-Insecure-Requests all right. Wrong: (1) Sec-Fetch-* — engine emits spec-correct
dest/mode/site on every https request, bridge drops them (`sec-` prefix), Chrome stamps
`none/cors/empty`; (2) `Pragma`/`Cache-Control: no-cache` on every request from
`cache:'no-store'`, overriding the engine's own (`max-age=0` on reload); (3) `Accept-Language`
is the host's while guest `navigator.language` is the engine's `en-US`. Also
`navigator.platform` is `''`.

**Decision**: captured in plans/wire-header-fidelity.md (issues/sec-fetch-fidelity.md retired — the
"engine must send its destination over the ABI" plan there was wrong; it already does).

## 2026-09-10 — Permission trim: which entries buy only warnings?

**Hypothesis**: `declarativeNetRequest` → `…WithHostAccess` is free under `<all_urls>`; `tabs` is
redundant with `<all_urls>` if viewer tabs' own extension URLs stay visible.

**What ran**: throwaway probe extension (no `tabs`, WithHostAccess DNR) on Chrome 152 (Playwright)
and Firefox 155 (BiDi harness): `tabs.query` from the background and from an extension page with
a direct viewer tab, a DNR-redirected viewer tab, a native http tab, about:blank, a pre-commit
tab; `onUpdated` across load + `pushState`. Install-prompt text via
`chrome.management.getPermissionWarningsByManifest`; details pages via guibox.

**Results**: WithHostAccess redirect + allow rules work on both. Chrome without `tabs`: own
`chrome-extension://` tabs have no `url`/`pendingUrl`/`title` and `onUpdated` carries no
`changeInfo.url` for them; http tabs (incl. pre-commit `pendingUrl`) visible. Firefox without
`tabs`: own `moz-extension://` URLs visible everywhere incl. pushState; about:blank / pre-commit
hidden. Chrome's install prompt is "Read and change all your data on all websites" for every
combination; the savings show only on its details page and in Firefox. Side finding: revoking
host access (Firefox toggle) silently disables the redirect, with either DNR permission.

**Decision**: swap to WithHostAccess, keep `tabs` on both (Chrome needs it). Tier-0/1 106,
tier-2 38/38. Warnings table in distribution.md; revocation → issues/host-access-revocation.md.

## 2026-09-10 — Wire-header fidelity (plans/wire-header-fidelity.md)

**Hypothesis**: the engine's own fetch metadata can replace the host's extension-fetch stamp
through the existing DNR per-request rule; `Pragma`/`Cache-Control: no-cache` from
`cache:'no-store'` are stamped below DNR (probe decides); a boot-time language override
aligns guest `navigator.language` with the host's `Accept-Language`.

**Probe (step 0)**: stub viewer, fixture oracle + `webRequest.onSendHeaders` (extraHeaders),
Chrome 152 and Firefox 155. Both: `pragma: no-cache` + `cache-control: no-cache` on the wire,
invisible to onSendHeaders, and a DNR `remove` of either changes nothing. An explicit
`Cache-Control: max-age=0` in the fetch init (or a DNR `set`) arrives as-is and suppresses the
host's `no-cache`; `Pragma` stays. So outcome (a), with a correction to the plan's premise —
the engine's Cache-Control was never overwritten; the audit's reload simply sent none (below).
Firefox: a session rule sets all four `sec-fetch-*`; no Sec-Fetch on http targets (Chrome same).

**Before/after wire** (tier-2 oracle, Chrome; Firefox identical except its old `same-origin`):

| request | before | after |
|---|---|---|
| URL-bar load (`bib_load_url`) | `none/cors/empty` | `none/navigate/document` + `User: ?1` |
| clicked same-origin link | `none/cors/empty` | `same-origin/navigate/document` + `?1` |
| timer `location.href` (+ each redirect hop) | `none/cors/empty` | `same-origin/navigate/document` |
| `<img>` / same-origin `fetch()` | `none/cors/empty` | `same-origin/no-cors/image` / `same-origin/cors/empty` |
| every hop of a redirected URL-bar load | `none/cors/empty` | `none/navigate/document` + `?1` |
| https→http hop | host none | none (WebCore strips, embedder adds nothing) |
| guest `navigator.language` / `.platform` | `en-US` / `''` | host's first (`de-DE`) / `Linux x86_64` |

Side finding: `bib_reload` sends no Cache-Control (`FrameLoader::reload` presets
`ReloadIgnoringCacheData`, which skips `addExtraFieldsToRequest`'s `max-age=0`; a guest
`location.reload()` does send it). `bib_reload` has no production caller, so the wire's host
`no-cache` there is a residual, not fixed.

**Real sites** (Chrome 152, headless, real extension): github.com/wmww/browsception/issues
renders the issue list, `/_graphql` 200 with `sec-fetch-site: same-origin`, no error boundary.
Google `/search`: 4/5 runs results (wire `navigate/document/none` + `?1`, then `same-origin` for
its `&sei=` follow-up); the first run of the burst got `/sorry` (429); old code from the same IP
minutes later 2/2 results, and new code 3/3 after that — read as rate, not headers, but keep an
eye on it. Note both old and new carry Chrome's `X-Client-Data` on google.com (a host tell DNR
could strip; not in this plan).

**Tests**: tier-0 75, tier-1 36; tier-2 Chrome 29/29 + HiDPI + Firefox 9/9 across two full
runs, except one run each of guest-realm (stayed on the boot page 20 s; passed alone 2/2 and in
the next full run) and the known Firefox crash-reload flake.

**Decision**: shipped; plan deleted, residuals in networking.md § Design.
