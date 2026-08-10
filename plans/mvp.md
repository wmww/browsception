# MVP plan

Goal: **a Chrome extension where navigating to an ordinary website renders and runs it entirely
inside a nested wasm WebKit** — usable enough to browse Wikipedia, Hacker News, MDN, and a
JS-interactive site (e.g. a simple SPA) with mouse + keyboard, at tolerable speed, with zero
target-site bytes parsed by the top-level browser and zero external servers.

Explicitly **in** the MVP: navigation interception, fetch bridge with guard list + isolated cookie
jar, threaded engine, canvas blit, mouse/wheel/keyboard (US layout), fake URL bar +
back/forward/reload, link navigation & redirects, HTTPS, basic downloads-blocked page, crash
recovery, and the activation/mode UI from notes/ui.md (active⇄inactive toggle, whitelist &
blacklist modes with per-mode lists, toolbar popup with per-site actions).

Explicitly **out** (fast-follows in rough order): IME/composition correctness, clipboard, find bar,
file upload, downloads, audio, favicon/title polish, popups/window.open, Firefox port, video,
touch. Never: printing, DRM, nested GPU/JIT.

Reference notes: ../notes/ (architecture.md is the map; open-questions.md gates below refer to its
numbering).

---

## Phase 0 — Spikes (de-risk before committing) 

Run these first; each produces a written answer in notes/open-questions.md.

**0.1 Engine build reproduction** *(open-questions #3 — the long pole, start immediately)*
- Clone WebkitWasm, pin its toolchain (emsdk version from their CI/readme), build the **pthread
  branch**. Get their demo page running locally with SAB (serve with COOP/COEP headers).
- Deliverable: documented reproducible build (script + emsdk pin), notes on build time/tree size,
  list of divergences from upstream WebKit and which WebKit tag it tracks.
- Abort criterion: if the build is unreproducible after ~2 weeks of effort, pivot to evaluating a
  from-scratch `PORT=Emscripten` against a current WebKit tag using WebkitWasm as reference — or
  escalate the firefox-wasm fallback decision.

**0.2 Extension networking spike** *(open-questions #1, #2, #4)*
- Throwaway extension: extension page with COOP/COEP manifest keys; verify `crossOriginIsolated`,
  SAB, and a trivial pthread wasm module.
- From that page: cross-origin `fetch()` of arbitrary sites (CORS bypass), `redirect:'manual'`
  behavior, Set-Cookie readability; DNR `modifyHeaders` setting UA/Cookie/Referer on those fetches,
  scoped by marker header, confirmed not to touch normal tabs.
- Deliverable: a `bridge-probe.md` result table; decision: engine-driven vs host-driven redirects;
  chosen Set-Cookie capture mechanism.

**0.3 Interception spike** *(open-questions #8)*
- DNR rules implementing **blacklist mode** (redirect `main_frame` for a hand-curated list of test
  domains to `viewer.html?url=\0` via regexSubstitution) plus a prototype of the whitelist-mode
  rule shape (static catch-all redirect + higher-priority dynamic `allow` rules — see notes/ui.md).
  Confirm: fires before any target fetch (devtools/netlog), works with SW asleep,
  web_accessible_resources config, allow-beats-redirect priority behavior, session rules with
  `tabIds` (escape hatch), back/forward behavior of redirected entries, and what happens on
  downloads/PDF/attachment responses.
- Deliverable: interception matrix (nav type → captured? correct?).

**0.4 Blit + input harness (no engine)**
- Fake "engine": a worker writing an animated pattern into a SAB framebuffer. Build the viewer
  skeleton around it: canvas, texSubImage2D blit at rAF, ResizeObserver/DPR handling, pointer/
  wheel/key capture into a ring buffer, simple latency/fps HUD.
- Deliverable: measured blit cost at 1080p/1440p (open-questions #10), reusable viewer skeleton.

**0.5 Test & iteration infrastructure** *(notes/testing.md; open-questions #19, #20)*
- Stand up the fixture server + oracle (`*.bstest` domains, `/__requests`), the four fixture pages,
  and the headless-Chromium harness (Playwright/CDP, `--headless=new`, `--load-extension`,
  `--host-resolver-rules`); verify headless parity for DNR + COOP/COEP (else fall back to
  guibox-hosted CI). Wire tier-0 unit tests (guard list, DNR rule generation, list semantics) into
  per-commit CI.
- Verify the guibox agent-session recipe end to end once (launch Chromium with unpacked extension,
  screenshot, click); create `experiments/log.md`.
- The 0.2/0.3 spike probes should be written *in* this harness so they graduate into tier-1 tests
  instead of being thrown away.

Phase 0 exit gate: 0.1 runs + 0.2 answers are workable, and tier-0 CI is green. If Set-Cookie or
redirect handling is truly blocked, revisit design (webRequest-based capture) before proceeding.

## Phase 1 — Engine ⇄ shim integration (the hard middle)

**1.1 Define the shim ABI** (engine.md § integration seams): a single versioned header/IDL for
imports/exports — net_*, framebuffer descriptor + frame_ready, input injection, resize, chrome
signal callbacks, lifecycle (boot/load/suspend/kill). Everything below codes to this.

**1.2 Networking transplant** — replace curl/SOCKFS/Wisp with the fetch bridge:
- Implement a WebKit network backend (NetworkDataTask-level, see networking.md) that marshals
  requests to JS and blocks the network thread on Atomics for streamed chunks (SAB ring buffer).
- Shim side: guard list (credentials:'omit' hardcoded, scheme allowlist, private-network +
  bad-port blocks, size/time caps), header rewrite via scoped DNR, Set-Cookie capture per 0.2.
- Wire WebKit's cookie jar to OPFS persistence (keep WebkitWasm's approach, namespaced).
- Milestone: **engine loads https://example.com and wikipedia.org through the bridge** in the
  harness page (not yet an extension), with redirects and cookies working.

**1.3 Rendering transplant** — Ganesh/WebGL2 → Skia CPU raster:
- Engine paints to a mailbox framebuffer in shared memory; frame_ready signaling; hook into 0.4's
  viewer skeleton. Dirty rects if cheap, else full-frame (measure; decide).
- Milestone: **pages render in our canvas** at acceptable frame cost; resize works.

**1.4 Input path**: implement injection through WebKit's event pipeline (mouse, wheel-as-scroll,
key events with proper key/code/modifiers). Caret/focus signals out (groundwork for IME later).
- Milestone: **can click links, scroll, type into forms** (US layout).

**1.5 Stability pass**: engine crash detection (worker error/heartbeat) → clean teardown + reload
UI; memory cap enforcement; leak check across 50 navigations.

**Testing during Phase 1**: the dev-build `__bs` test hook (notes/testing.md) is built alongside
1.1's ABI — it is also the milestone-verification tool (1.2's "loads example.com" is asserted with
`__bs.text()`, 1.3's rendering with `__bs.pixels()` against `grid.bstest`, 1.4's input against
`input.bstest`). Tier-1 bridge tests (stub engine) go green as 1.2 lands; the first engine
artifact from 1.2/1.3 becomes the pinned artifact for tier-2. Engine-side iteration here is the
first heavy use of the agent loop — log experiments in `experiments/log.md`.

Phase 1 exit gate: browse the 4 target sites in the harness page with mouse+keyboard for 10
minutes without a crash, tiers 0–1 green in CI, and tier-2 scenarios 7–9 (render/execute/input)
green against the pinned engine artifact.

## Phase 2 — Become an extension

- **2.1** Package viewer + engine into the extension; manifest per extension-platform.md draft
  (COOP/COEP keys, host_permissions, web_accessible_resources). Engine module caching in
  IndexedDB/OPFS; measure cold vs warm start (open-questions #11); eager-boot option.
- **2.2** Interception from 0.3 goes live in **blacklist mode** with a hand-curated test-domain
  list (identical semantics to the shipped blacklist mode — see notes/ui.md): original-URL
  plumbing, per-tab viewer instances, `chrome.tabs` integration (title = nested title).
- **2.3 Browser chrome v1**: fake URL bar (always shows true engine URL; visually distinct from
  canvas — see security.md), back/forward/reload wired to engine history, load progress,
  "tab crashed" page, one-time "open natively" escape hatch (session+tab-scoped allow rule).
- **2.4 Activation & modes UI** (notes/ui.md): active/inactive toggle, whitelist ⇄ blacklist mode
  switch with separate persisted lists (`storage.sync`), toolbar popup with per-site actions and
  per-tab disposition badge, options page list editors, sandboxed→native boundary navigation
  (engine policy delegate checks mode+list and hands whitelisted navigations to the real tab).
- **2.5 Guard-rail verification**: this is tier-2 scenario 11 plus the tier-0 DNR matrix
  (notes/testing.md) — no credentials on bridge requests, private-network fetches blocked
  (`hostile.bstest` full pass), DNR header rules don't fire on non-bridge traffic, target-origin
  documents never created top-level (CDP Network/Target audit), and mode/list state transitions
  produce exactly the intended rule sets. Full tier-2 suite (all 13 scenarios) green is the gate.
- **2.6 Whitelist mode goes live** once 2.5 passes: enable the static catch-all ruleset,
  empty whitelist → all http(s) sandboxed. This is the shipping default per notes/ui.md; blacklist
  mode remains available.

Phase 2 exit gate = **MVP done**: install extension → active in whitelist mode → type any http(s)
URL in the real omnibox → site appears, browsable, all rendering/JS nested, no servers involved;
whitelisting a domain makes it load natively again.

## Phase 3 — Fast-follows (post-MVP, rough order)

1. Clipboard (copy/paste text), find bar (engine findString), file upload, downloads.
2. IME/composition via hidden-input-at-caret (rendering-input.md) — the big input investment.
3. Popups/window.open → new viewer tabs; dialogs (alert/confirm/prompt/auth) as viewer modals.
4. Audio via AudioWorklet ring buffer.
5. Session restore, history, list import/export polish.
6. Firefox port: single-thread build first; then StreamFilter mode B (real URL + FF threads).
7. Perf: dirty rects, scroll fast-path, engine tile cache tuning, startup snapshotting.

## Risks & fallbacks

| Risk | Signal | Fallback |
|---|---|---|
| WebkitWasm unbuildable/unsound as a base | 0.1 fails | Fresh `PORT=Emscripten` against WebKit tag using it as reference; or switch to forking firefox-wasm (engine.md alt #2 — keeps Wisp-less goal via same bridge idea into Necko) |
| Set-Cookie/redirects unworkable via fetch | 0.2 fails | Firefox-first pivot (webRequest gives full header access) or webRequest-observational capture on Chrome |
| CLoop too slow for target sites | Phase 1 testing | Accept + document; scope MVP sites accordingly; long-term: AOT research (notes/engine.md) |
| Per-instance memory blows past ~2 GB | Phase 1 measurement | Aggressive WebKit cache tuning, single-tab-at-a-time mode, tab discard |
| Store review rejects broad permissions | Phase 2 submission | Ship allowlist/per-site-activation build; self-host crx/unpacked for enthusiasts |

## Testing & iteration summary

(Details in notes/testing.md.)
- **Tier 0** (<5 s, per-commit): guard-list table, DNR rule generation, list semantics — pure
  functions in Node.
- **Tier 1** (<30 s, per-commit): headless Chromium + extension + fixture server + stub engine —
  interception matrix, bridge semantics, isolation preconditions. No wasm WebKit needed.
- **Tier 2** (<2–3 min, per-merge + nightly): real engine artifact — 13 scenarios total
  (render, execute, input, navigation chrome, invariants, crash recovery, startup budget) asserted
  via the `__bs` test hook and fixture pixel/text probes; no golden images, no real websites, no
  agent involvement.
- Engine builds are a separate pipeline producing pinned artifacts; CI never compiles WebKit.
- **Agent loop**: Claude iterates autonomously via the same harness (CDP + `__bs`) and, for
  visual/chrome-level questions, guibox headless-Wayland sessions (screenshot + injected input);
  fixtures only in loops, sparing real-site smoke checks, results logged append-only in
  `experiments/log.md` with conclusions promoted into `notes/`.

## Working agreements

- Notes in `notes/` are durable and updated as decisions land (append answers to
  open-questions.md rather than deleting questions).
- Engine fork tracks WebKit **release tags**; rebases are scheduled work, not drive-by.
- Every shim import added gets a line in security.md's capability accounting.
- Test growth policy: a new automated test must catch a new *class* of failure (or a regression
  that actually escaped); prefer adding probes to existing scenarios over adding scenarios.
- Agent experiments follow the guardrails in notes/testing.md (time-boxed, fixture-only loops,
  sessions cleaned up, no real credentials ever).
