# Testing & autonomous iteration

Two audiences: **CI** (automated tests, no agent involvement, fast and lean) and **the agent loop**
(Claude experimenting/iterating without per-experiment human direction). They share
infrastructure: the fixture server, the dev-build test hook, and the launch recipes.

## Shared infrastructure

### Fixture server
Everything a test loads from disk lives under `test/fixtures/` — the pages, the CA, and
`probe-ext/` (the probe extension three tier-1 suites load; `scripts/gen-ext.mjs` also reads the
shared dev key from it, so the real extension keeps its pinned id).

A local HTTP(S) server (`test/fixtures/`) serving hand-written pages designed for assertion, on
domains mapped into Chromium via `--host-resolver-rules="MAP *.bstest 127.0.0.1:<port>"`.
HTTPS fixtures use a mkcert-style locally-trusted CA installed into the disposable test profile
(needed because the bridge and DNR rules target https; keep one http fixture to test scheme
handling). The server double-acts as an **assertion oracle**: it records every request it receives
(headers included) and exposes `/__requests` for tests to verify e.g. that no `Cookie` from the
host jar ever arrived, or that a blocked fetch never hit the wire. `/__health` carries the
checkout path so a harness never adopts a parallel worktree's oracle (worktrees.md § Smokes).

Fixture pages are assertion-friendly by construction:
- `grid.bstest` — colored rectangles at known coordinates (pixel-probe assertions, no golden
  images).
- `input.bstest` — paints a distinct color per received click/keydown/scroll region; typing echoes
  into a field that repaints a checksum color. Lets input tests assert via pixels alone.
- `app.bstest` — small JS SPA: DOM manipulation, fetch to same/cross fixture origin, setTimeout,
  history.pushState, a redirect chain, Set-Cookie + cookie echo page.
- `scroll.bstest` — 4000 x 120 px text sections, each with a colour-coded left border encoding
  its index, so `__bs.probe(4, 4)` decodes the engine's scroll offset (perf probes;
  notes/perf-measurement.md).
- `hostile.bstest` — tries everything it shouldn't: fetch to `localhost`/RFC1918/bad ports,
  `file:` links, window.open spam, oversized responses. Exists so guard tests are one navigation.
  Its `#filelink` and the `/redir-file` route (302 → `file:///etc/passwd`) are driven by the
  scheme-gate scenario, not by the page's own pass.

Bench fixtures are separate on purpose: `scripts/bench/fixtures/` on `*.bsbench`, served by the
bench suite's own server on its own port lane, **append-only** because saved results reference
them by hash (notes/perf-measurement.md § Bench suite). Test fixtures stay free to change.

**Rule: automated loops never touch real websites.** Real-site checks (Wikipedia/HN/MDN) are a
short manual/agent smoke list run sparingly, not in CI and not in tight iteration loops.

### Dev-build test hook
Dev builds of the viewer expose `globalThis.__bs` (compiled out of release builds):
- `state()` → engine URL, title, load phase, mode/list disposition, instance health.
- `text()` → extracted text content of the nested page (engine-side innerText walk) — the
  workhorse for "did the page actually render/execute" assertions without pixel fragility.
- `pixels(x,y,w,h)` → framebuffer readback for pixel probes.
- `input(events)` → inject synthetic events directly into the engine queue (bypasses DOM capture;
  DOM-level input is covered separately by CDP/wdotool paths).
- `navigate(url)`, `metrics()` → frame times, blit cost, memory, bridge counters (also the
  agent-loop measurement API).
- `log()` → ring buffer of shim + engine console output.

This hook is the reason integration tests don't need OCR or golden screenshots: fixtures paint
semantics into colors and text, and `__bs` reads both sides.

### Crash triage (an abort names its C++ frames)
The engine is built without `-sASSERTIONS`, so a `RELEASE_ASSERT` surfaces as a bare `Aborted()`
with an **empty reason** — useless on its own. The wasm does carry a name section, so
`engine-pre.js` hooks the engine worker's `Module.onAbort` (called synchronously from `abort()`,
still inside the wasm stack) and logs `engine abort stack (reason: …) Error … WebCore::Foo::bar`
through `printErr`, which the worker forwards to the viewer's console. That single line is how
youtube.com's crash was identified in one run
(`GraphicsLayer::create` ← `enableCompositingMode` ← `setActiveViewTransition`). Then it chains
to the host's own `onAbort` (the worker posts the crashed-UI notification).

Trap, if that hook is ever touched: the pre-js installs `onAbort` as an accessor that starts by
forwarding to whatever the host set BEFORE `importScripts` (engine-worker.js) — a plain
`Module.onAbort = …` in pre-js would replace the host's and silently swallow the crash
notification. (In the proxy link the same accessor exists to capture Emscripten's proxy stub.)
Tier-2 scenario 12 asserts both halves (crashed UI *and* a named stack).

### Launch recipes
- **CI / programmatic**: Chromium `--headless=new` (supports extensions) driven by Playwright or
  raw CDP: `--load-extension=src/ --user-data-dir=<tmp> --no-first-run --host-resolver-rules=…`.
  One browser boot per suite, fresh profile per test where isolation matters.
  (Verify headless=new extension + DNR + COOP/COEP behavior early — open-questions #19.)
  Use the **full system chromium**, never Playwright's bundled `chromium-headless-shell`: the
  shell SEGVs in V8 JIT code space on ~1/3 of heavy-JS engine loads and drops WebGL contexts at
  first composite (fork-era finding; harness artifact, not an engine bug).
- **Firefox**: `test/harness/firefox.mjs` — system Firefox headless over WebDriver BiDi (no
  dependency; Playwright can't install Firefox extensions), extension from `dist/firefox/`
  (`scripts/pack-ext.mjs firefox`), fixtures via `network.dns.localDomains` +
  `network.socket.forcePort` prefs (every port-80/443 connection — no live internet from a
  harness profile unless `profilePrefs` clears both), the fixture CA trusted for real via
  `certutil` (`ff.trustsFixtureCert`; HSTS scenarios skip without it; hosts named one by one in
  the leaf SAN, test/fixtures/hosts.mjs — extension-platform.md § Firefox). Firefox will not
  start inside a sandboxed agent shell: run it unsandboxed. Its `page` API is deliberately Playwright-shaped
  (`goto`/`evaluate(fn, jsonArg)`/`waitForFunction(exprString)`/`url()`), but `evaluate` round-trips
  through JSON and console capture needs `page.hookConsole()` on extension pages
  (extension-platform.md § Firefox).
- **Agent GUI sessions**: the gui-testing skill's `guibox` — headless sway compositor, real
  windowed Chromium, `grim` screenshots, `wdotool` input. For anything CDP can't reach or fakes:
  the real omnibox, the toolbar popup, actual user-gesture semantics, focus/IME quirks, "does it
  *look* right." Always `--user-data-dir` inside the session dir (disposable profile per skill
  guidance), extension loaded unpacked from `src/` (or `dist/chrome/`).

## Automated test suite (CI, no agent)

Lean by design: each tier has a purpose; no test exists twice. Target wall-clock in parentheses.

### Tier 0 — unit (<5 s, per-commit)
Pure-function tests, Node + vitest (or similar):
1. **Guard list**: table-driven URL cases → allow/deny (schemes, IP literals, localhost variants,
   bad ports, size-cap plumbing). The security-critical table; grows only with real bypass finds.
2. **DNR rule generation**: (mode, lists, escape-hatch state) → exact expected rule JSON for the
   whitelist/blacklist/inactive matrix, priority ordering, tab-scoped session rule.
3. **List semantics**: domain matching (subdomains, eTLD+1 suggestion, exact-host entries).
4. **No-GPU imports** (`engine-imports.test.mjs`): the staged `embedder.js` — emscripten's glue
   *is* the module's import list — must contain no `webgl`/`glctx`/`_emscripten_gl`/`_egl`/
   `offscreencanvas`/`webgpu`. security.md's "the engine cannot reach the GPU driver" is a claim
   about imports, and imports appear from a link flag, not from a call (engine-build.md § No-GPU
   link contract). Skips when no engine is staged.
5. **Release archives** (`zip.test.mjs`): `scripts/lib/zip.mjs` round-tripped through the
   system `unzip` (an independent implementation — our own reader proves nothing about a
   hand-rolled binary format) plus the determinism the release build promises. Skips without
   `unzip`.

### Tier 1 — bridge integration, no engine (<30 s, per-commit)
Headless Chromium + extension + fixture server + a **stub engine** (src/shim/engine-stub.mjs,
speaking the bridge's bytes/strings interface in-process). Real fetch bridge, real DNR, real
webRequest capture — fake WebKit. Covers the platform integration that unit tests can't and that
doesn't need the 100 MB engine:
4. Interception matrix: nav to fixture domains under each mode/list state → tab lands on
   viewer.html with correct `?url=`; whitelisted domain loads natively; escape-hatch rule works
   and dies with the tab; DNR header-rewrite rules fire on bridge fetches only (oracle-verified
   against a simultaneous native-tab fetch).
5. Bridge semantics: chunk streaming under the credit window, redirect chain reported per chosen
   policy, Set-Cookie capture path, `credentials:'omit'` (oracle: no host-jar cookie ever
   received), guard denials surfaced as engine-visible errors, size cap aborts.
6. Headless parity (`parity.test.mjs`): extension pages exist and Chrome's manifest COOP/COEP
   still isolates them — a platform property we no longer depend on, kept as a parity check.
6b. Sweep (`sweep.test.mjs`): the SW's tab sweep against real Chromium tab state — a tab whose
   navigation is still in flight gets sandboxed (a local server that accepts and never answers
   pins it pre-commit, where `tab.url` is 'about:blank'), and an escape-hatch tab survives a
   later reconcile. Both are the security-critical half of the startup race (security.md).
   Never assert on a `page.goto` promise in a test that also edits state: the reconcile's sweep
   re-navigates any tab it finds mid-flight, which rejects the goto with `ERR_ABORTED` although
   the tab lands exactly where it should. Assert on the settled `page.url()` instead
   (`gotoSandboxed()` there) — that was a long-running tier-1 flake.

### Tier 2 — full integration, real engine (~30 s, per-merge + nightly; needs prebuilt engine artifact)
Headless Chromium + extension + **real wasm WebKit** + fixtures. The small set that proves the
whole machine, end to end:
7. **Render**: navigate to `grid.bstest` → `__bs.pixels` probes match expected colors; `__bs.text`
   contains sentinel strings. (One test, several probes.)
8. **Execute**: `app.bstest` → JS ran (text mutated by script), engine-internal fetch + cookie
   round-trip succeeded, redirect chain landed.
9. **Input**: CDP-dispatched clicks/keys/scroll on the viewer canvas → `input.bstest` colors flip
   correctly (covers DOM capture → queue → engine dispatch → page JS → repaint → blit, in one
   test).
10. **Navigation chrome**: link click inside nested page updates the fake URL bar *and the tab
    URL* (also the escape-hatch stale-URL regression); native back/forward/reload drive the
    engine; sandboxed→native handoff navigates the real tab when target is whitelisted.
11. **Invariants** (the 2.5 guard-rail suite): during all of the above, CDP
    Network/Target events show no target-origin document or subresource ever loaded top-level;
    oracle shows no credentialed/blocked request; `hostile.bstest` full pass.
12. **Crash/recovery**: `__bs.crash()` aborts the engine in its worker → viewer shows crashed
    state (worker terminated) → reload recovers.
13. **Startup budget**: warm start to interactive under threshold (regression tripwire, generous
    bound).
14. **Resize**: canvas fills the window, the engine framebuffer follows resizes, input stays
    aligned.
15. **Guest WebSocket**: `new WebSocket(...)` in the guest fires `error`/`close` and the engine
    keeps running — the engine has no WS transport, and the *absence* of a channel is an engine
    abort (RELEASE_ASSERT in WebSocket::create), so this is a crash tripwire, not a feature test.
16. **Engine-side load failure**: two classes, neither visible to the shim's fetch — a top-level
    response the engine refuses to display (`/download`, application/octet-stream) and a
    navigation refused before any request (`http://127.0.0.1:1/`, blocked port). Each must raise
    the viewer error strip naming that URL, with a retry, and the next navigation must still
    render and clear it. The only cover for the engine's `"loadfailed"` signal.
17. **View transitions absent**: `typeof document.startViewTransition === 'undefined'`, a
    feature-detect-then-call in the guest takes the fallback branch, and the engine still runs and
    paints. Guards the compositing crash class — this port has no GraphicsLayer, so re-exposing
    the API aborts on the first site that uses it (engine-internals.md § Hard limits).
18. **HiDPI** (`test/tier2/hidpi.test.mjs`, own file — dpr is a browser-launch property): render
    geometry, the full mouse battery and post-resize alignment at **dpr 2 and 1.5**. ~9 s, two
    extra browser launches.
19. **Positional-input coalescing**: a 20-event wheel burst on `scroll.bstest` sent with no
    settling waits, immediately followed by a click. The page must end up at the *summed* offset
    (nothing lost to merging) and the click must report that same `scrollY` (nothing merged past a
    discrete event). Guards the engine-side batch/seal rules — see rendering-input.md § scrolling.
20. **Sticky-chrome scroll** (`scroll-sticky.bstest`): a Wikipedia-shaped page (sticky header band
    + tall fixed sidebar) must scroll through the same blit fast path as a plain page — content
    lands at exactly the summed deltas and the sticky pixels are back at their fixed positions.
    Guards the damage-merge policy: a frame-covering merged rect silently demotes every tick to a
    full repaint (few fps).
21. *Retired 2026-09-09* (present coherence): it raced an async main-thread upload against
    engine mutations of a shared framebuffer. With the worker host the band is copied out
    synchronously on the engine's one thread before anything else can run, so that failure class
    cannot exist; the ABI states the contract instead.
22. **Guest wasm shim + media stubs, in the extension**: the guest realm compiles and runs a real
    wasm module (base64 → host bridge → binaryen wasm2js → eval; only the whole path returns the
    right answer), and `Audio`/`HTMLVideoElement` exist with ENABLE_VIDEO=OFF-honest answers. The
    engine worker's pre-js fetches all three assets from **origin-absolute host-root paths**
    (`/wasm-polyfill.js`, `/media-stub.js`, `/vendor/binaryen/index.js`) — the dev harness served
    them, the extension root didn't, so guest pages had no `WebAssembly` and no media globals and
    nothing but three worker console warnings said so (2026-08-15). Asserts the guest-visible end
    state, so it catches any future break in that chain, not just a missing file.

23. **Scheme gates** (4 tests, plans-era `viewer-url-contract`): the sandbox→host boundary in
    both directions. A non-http(s) `?url=` never boots the engine; a percent-encoded `?url=`
    (legacy tabs/bookmarks) boots, is rewritten raw, survives a sweep, and — when its disposition
    flips — is handed to `tabs.update` **decoded** (the ERR_FILE_NOT_FOUND regression); the URL
    bar refuses non-http(s); and a guest driving the top level at `file:`/`ftp:`/an unknown scheme
    (link, `location.href`, a 302 to `file:`) always ends in a refusal strip with the tab and
    engine intact. That last one is the only cover for the bridge's native-handoff gate reaching
    `location.replace` — see security.md § Sandbox→host sinks for which schemes get how far.

24. **Firefox subset** (`test/tier2/firefox.test.mjs`, ~40 s, skips without `/usr/bin/firefox`):
    fresh-install interception through the runtime-installed dynamic catch-all (oracle sees no
    target bytes), boot + render in the worker-hosted engine (and `crossOriginIsolated === false`,
    the design premise), the app.bstest execute battery (bridge, cookie round-trip via
    onHeadersReceived capture, pushState mirror, redirect chain), blacklist/whitelist reconcile,
    native handoff, scheme gates, crash → reload. Same source tree as Chrome; only the manifest
    differs. Plus two stub-engine bridge cases for what only Firefox's network stack produces
    (tier 1 runs on Chrome): repeated `Set-Cookie` arriving as one newline-joined value, and an
    HSTS upgrade (`/hsts` seeds it over a genuinely trusted connection) reaching the engine as a
    307 hop rather than a network failure or a 200 under the http URL. Both were google.com
    failures the day the port landed; a live-site check is
    `viewer.html?url=http://google.com/` in a harness profile with the port forcing cleared.

That's ~30 scenarios total. Growth policy: a new test requires a new *class* of failure it would
catch (or a regression that escaped); prefer extending an existing scenario's probes over adding
scenarios.

#### dpr != 1 is a coverage axis, not a variant
CSS px, logical px and device px are numerically identical at dpr 1, so a dpr-1 suite cannot
distinguish them and any unit mix-up passes it. That is how mouse input shipped multiplied by dpr
(every HiDPI click landing dpr times too far down/right) with scenario 9 *and* scenario 14's
"input stays aligned" both green — see rendering-input.md § Input coordinates. Rule: anything
converting between those spaces gets a HiDPI case, and its probe coordinates must sit far enough
from the origin that a scale error cannot hit the intended target anyway (the input fixture's
zones are 200 logical px: click the *center* of one, so a dpr-scaled misread lands elsewhere).

**Harness trap**: playwright's `deviceScaleFactor` context option reports dpr N to page JS but
leaves `device-pixel-content-box` and the compositing surface at 1x. The viewer then sizes a 1x
framebuffer, the scale error cancels out, and a HiDPI test passes on broken code (measured: dpcb
300 device px for a 300 CSS px box at dpr 2 — vs 600 with the flag, which matches hardware). Use
`--force-device-scale-factor=N` with `viewport: null`, and resize windows through CDP
`Browser.setWindowBounds`: `setViewportSize` starts metrics emulation and overrides the forced
factor.

### What is deliberately not tested in CI
- Real websites (flaky, slow, third-party load) — agent smoke list instead.
- Golden-image screenshot diffs (font/AA churn) — pixel probes on fixture colors instead.
- WebKit's own web-platform correctness (WPT is upstream's job; we test *our* seams). If we ever
  need conformance signal, run a curated WPT slice against the engine build separately, not in
  this repo's CI.
- Perf benchmarking beyond the tier-2 tripwire — that's the agent loop's job with `metrics()`.

### CI tiers & the engine artifact
Engine builds are hours-long; CI never builds WebKit per-commit. The engine is a versioned
artifact (`engine-<webkit-tag>-<port-rev>.wasm` + JS glue) produced by a separate build pipeline;
tiers 0–1 run per-commit on shim/extension changes; tier 2 runs per-merge and nightly against the
pinned artifact, and on every new engine artifact.

## Agent iteration loop (autonomous experimentation)

Purpose: let Claude run edit → build → probe → assess cycles unattended, for both feature work and
exploratory tuning (blit strategies, scheduler settings, guard behavior), reporting back results —
without a human driving each experiment.

### Workflow
1. **Prefer the programmatic path**: for most iteration, drive headless Chromium via
   CDP/Playwright + `__bs` (faster and less flaky than pixels; `text()`/`metrics()` answer most
   questions). Same harness as tier 1/2 tests, invoked ad hoc.
2. **Use guibox when the question is visual or chrome-level**: real window, screenshot with grim,
   act with wdotool. Canonical session:
   ```sh
   HTTPS_PORT=$(node -e 'import("./test/harness/ports.mjs").then(m=>console.log(m.HTTPS_PORT))')
   DIR=$(guibox start -s 1600x1000 -- chromium --user-data-dir=$DIR-profile --no-first-run \
         --load-extension=$REPO/dist --host-resolver-rules="MAP *.bstest 127.0.0.1:$HTTPS_PORT" \
         https://grid.bstest/)   # guibox path per skill; profile inside session dir
   . $DIR/env
   grim $DIR/1.png               # read screenshot, decide
   wdotool mousemove X Y click 1 # coordinates are exact screen pixels (tiled, undecorated)
   $GUIBOX stop $DIR
   ```
   Skill guidance that applies here: source `$DIR/env` in every shell or tools hit the real
   desktop; browsers may map before painting — sleep and retake blank shots; keep artifacts in
   `$DIR` (they vanish with the session) and copy out only what's worth keeping; toolbar-popup
   clicks are just pixel coordinates; no touch available (touch input stays untested).
3. **Rebuild granularity**: shim/extension changes are seconds (plain JS/TS bundle); engine
   changes are an Emscripten relink (~minutes) — batch engine-side experiments accordingly.
4. **Measure, don't eyeball, perf**: every perf experiment records `__bs.metrics()` JSON to
   the session scratchpad and copies the numbers into its lab-notebook entry; screenshots are
   for correctness/visual questions only.
5. **Fixtures only** in loops (rule above). The real-site smoke list (Wikipedia, HN, MDN, one SPA)
   runs at most once per session-of-work, sequentially, as a final check.

### Lab notebook (durable)
`notes/experiment-log.md` — append-only, dated entries: hypothesis → what was run (exact
commands/commits) → result (numbers/screenshot refs) → decision. Conclusions that change design
get promoted into the other notes in the same change; the log is the raw record, notes are the
distilled truth. Raw dumps and screenshots are transient (session scratchpad) — the numbers that
matter go in the entry.

### Guardrails for unattended runs
- Anything destructive/irreversible or touching accounts/real credentials: out of scope, stop and
  ask. No logging into real sites from the nested engine during experiments.
- Time-box: an experiment that can't produce signal in ~30 min of wall clock gets written up as
  blocked in the log rather than retried in variations indefinitely.
- One guibox session at a time per task; always `stop` (TTL is the backstop); never kill sessions
  not started by the current task (`$GUIBOX list` may show others').
- Engine artifact rebuilds are scheduled work, not something the loop kicks off on a whim —
  iterate against the pinned artifact unless the experiment *is* an engine change.
