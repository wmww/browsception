# Testing & autonomous iteration

Two audiences: **CI** (automated tests, no agent involvement, fast and lean) and **the agent loop**
(Claude experimenting/iterating without per-experiment human direction). They share
infrastructure: the fixture server, the dev-build test hook, and the launch recipes.

## Shared infrastructure

### Fixture server
A local HTTP(S) server (`test/fixtures/`) serving hand-written pages designed for assertion, on
domains mapped into Chromium via `--host-resolver-rules="MAP *.bstest 127.0.0.1:<port>"`.
HTTPS fixtures use a mkcert-style locally-trusted CA installed into the disposable test profile
(needed because the bridge and DNR rules target https; keep one http fixture to test scheme
handling). The server double-acts as an **assertion oracle**: it records every request it receives
(headers included) and exposes `/__requests` for tests to verify e.g. that no `Cookie` from the
host jar ever arrived, or that a blocked fetch never hit the wire.

Fixture pages are assertion-friendly by construction:
- `grid.bstest` — colored rectangles at known coordinates (pixel-probe assertions, no golden
  images).
- `input.bstest` — paints a distinct color per received click/keydown/scroll region; typing echoes
  into a field that repaints a checksum color. Lets input tests assert via pixels alone.
- `app.bstest` — small JS SPA: DOM manipulation, fetch to same/cross fixture origin, setTimeout,
  history.pushState, a redirect chain, Set-Cookie + cookie echo page.
- `hostile.bstest` — tries everything it shouldn't: fetch to `localhost`/RFC1918/bad ports,
  `file:` links, window.open spam, oversized responses. Exists so guard tests are one navigation.

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

### Launch recipes
- **CI / programmatic**: Chromium `--headless=new` (supports extensions) driven by Playwright or
  raw CDP: `--load-extension=dist/ --user-data-dir=<tmp> --no-first-run --host-resolver-rules=…`.
  One browser boot per suite, fresh profile per test where isolation matters.
  (Verify headless=new extension + DNR + COOP/COEP behavior early — open-questions #19.)
- **Agent GUI sessions**: the gui-testing skill's `guibox` — headless sway compositor, real
  windowed Chromium, `grim` screenshots, `wdotool` input. For anything CDP can't reach or fakes:
  the real omnibox, the toolbar popup, actual user-gesture semantics, focus/IME quirks, "does it
  *look* right." Always `--user-data-dir` inside the session dir (disposable profile per skill
  guidance), extension loaded unpacked from `dist/`.

## Automated test suite (CI, no agent)

Lean by design: each tier has a purpose; no test exists twice. Target wall-clock in parentheses.

### Tier 0 — unit (<5 s, per-commit)
Pure-function tests, Node + vitest (or similar):
1. **Guard list**: table-driven URL cases → allow/deny (schemes, IP literals, localhost variants,
   bad ports, size-cap plumbing). The security-critical table; grows only with real bypass finds.
2. **DNR rule generation**: (mode, lists, escape-hatch state) → exact expected rule JSON for the
   whitelist/blacklist/inactive matrix, priority ordering, tab-scoped session rule.
3. **List semantics**: domain matching (subdomains, eTLD+1 suggestion, exact-host entries).

### Tier 1 — bridge integration, no engine (<30 s, per-commit)
Headless Chromium + extension + fixture server + a **stub engine** (tiny worker speaking the shim
ABI). Real fetch bridge, real DNR, real COOP/COEP page — fake WebKit. Covers the platform
integration that unit tests can't and that doesn't need the 100 MB engine:
4. Interception matrix: nav to fixture domains under each mode/list state → tab lands on
   viewer.html with correct `?url=`; whitelisted domain loads natively; escape-hatch rule works
   and dies with the tab; DNR header-rewrite rules fire on bridge fetches only (oracle-verified
   against a simultaneous native-tab fetch).
5. Bridge semantics: streaming into SAB ring, redirect chain reported per chosen policy,
   Set-Cookie capture path, `credentials:'omit'` (oracle: no host-jar cookie ever received),
   guard denials surfaced as engine-visible errors, size cap aborts.
6. Isolation preconditions: `crossOriginIsolated === true` in viewer, SAB usable in worker.

### Tier 2 — full integration, real engine (<2–3 min, per-merge + nightly; needs prebuilt engine artifact)
Headless Chromium + extension + **real wasm WebKit** + fixtures. The small set that proves the
whole machine, end to end:
7. **Render**: navigate to `grid.bstest` → `__bs.pixels` probes match expected colors; `__bs.text`
   contains sentinel strings. (One test, several probes.)
8. **Execute**: `app.bstest` → JS ran (text mutated by script), engine-internal fetch + cookie
   round-trip succeeded, redirect chain landed.
9. **Input**: CDP-dispatched clicks/keys/scroll on the viewer canvas → `input.bstest` colors flip
   correctly (covers DOM capture → queue → engine dispatch → page JS → repaint → blit, in one
   test).
10. **Navigation chrome**: link click inside nested page updates fake URL bar; back/forward work;
    sandboxed→native handoff navigates the real tab when target is whitelisted.
11. **Invariants** (the 2.5 guard-rail suite): during all of the above, CDP
    Network/Target events show no target-origin document or subresource ever loaded top-level;
    oracle shows no credentialed/blocked request; `hostile.bstest` full pass.
12. **Crash/recovery**: kill the engine worker → viewer shows crashed state → reload recovers.
13. **Startup budget**: warm start to interactive under threshold (regression tripwire, generous
    bound).

That's ~13 scenarios total. Growth policy: a new test requires a new *class* of failure it would
catch (or a regression that escaped); prefer extending an existing scenario's probes over adding
scenarios.

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
   `experiments/data/`; screenshots are for correctness/visual questions only.
5. **Fixtures only** in loops (rule above). The real-site smoke list (Wikipedia, HN, MDN, one SPA)
   runs at most once per session-of-work, sequentially, as a final check.

### Lab notebook (durable)
`experiments/log.md` — append-only, dated entries: hypothesis → what was run (exact commands/
commits) → result (numbers/screenshot refs) → decision. Conclusions that change design get
promoted into `notes/` in the same change; the log is the raw record, notes are the distilled
truth. Data and kept screenshots in `experiments/data/` (git-LFS or gitignored as size dictates).

### Guardrails for unattended runs
- Anything destructive/irreversible or touching accounts/real credentials: out of scope, stop and
  ask. No logging into real sites from the nested engine during experiments.
- Time-box: an experiment that can't produce signal in ~30 min of wall clock gets written up as
  blocked in the log rather than retried in variations indefinitely.
- One guibox session at a time per task; always `stop` (TTL is the backstop); never kill sessions
  not started by the current task (`$GUIBOX list` may show others').
- Engine artifact rebuilds are scheduled work, not something the loop kicks off on a whim —
  iterate against the pinned artifact unless the experiment *is* an engine change.
