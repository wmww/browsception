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
| [perf-measurement.md](perf-measurement.md) | How to get trustworthy engine perf numbers: BIBPERF counters, pixel-encoded page state, exact input rates, and the traps that faked results |
| [rendering-input.md](rendering-input.md) | Blit paths, input forwarding, IME, find-in-page, clipboard, audio, popups |
| [security.md](security.md) | Threat model, trust boundaries, what we must enforce ourselves |
| [testing.md](testing.md) | Automated test tiers (unit/bridge/full-integration), fixture+oracle design, agent iteration loop |
| [worktrees.md](worktrees.md) | Ephemeral-worktree workflow: wt-setup, building your branch's engine sources against the shared tree, WebKit-patch ownership, artifact snapshots, per-checkout ports |
| [open-questions.md](open-questions.md) | Unverified assumptions and spikes to run (answers appended in place) |
| [experiment-log.md](experiment-log.md) | Append-only lab notebook: dated entries (hypothesis → what ran → numbers → decision) behind the distilled notes |
| [roadmap.md](roadmap.md) | Post-MVP fast-follows, cleanups, standing risks, working agreements |

## Status

**MVP complete** (2026-08-10, all gates passed). The MVP plan is retired; its surviving content
lives in [roadmap.md](roadmap.md). Phase summaries:

- **Phase 0 spikes**: engine build reproduced (engine-build.md, `tools/build-engine.sh`); bridge
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
  whitelist-by-default** — `DEFAULT_STATE.mode='whitelist'`, static catch-all enabled in the
  manifest so a fresh install intercepts before the SW runs (ui.md § shipping default). Exit
  gate: tools/smoke-mvp.mjs real-site pass — sandboxed example.com/wikipedia, whitelist→native
  sweep (experiment-log.md 2026-08-10).

Tests: `npm test` = tiers 0–1, pure headless, per-commit (71 tests). `npm run test:tier2` = 21
scenarios (incl. 6 HiDPI at dpr 2/1.5) against the staged engine artifact (~29 s; restage with
tools/stage-engine.mjs after engine rebuilds — src/engine/ is gitignored). Engine iteration is
genuinely incremental (~90 s for embedder-only changes; engine-build.md fix 6) and works from any
worktree branch (worktrees.md § Engine work).

Load-bearing implementation facts:

- Viewer parses `?url=` **raw** — DNR `\0` substitution is un-encoded, so our own params must
  precede `url=` and everything after it is the target (sw.mjs mirrors this in the sweep).
- src/manifest.json + src/rules/ are **generated** by tools/gen-ext.mjs (pinned key/id; CSP needs
  `'wasm-unsafe-eval'`). The manifest's catch-all `enabled: true` must agree with DEFAULT_STATE.
- Portability gotchas: TextDecoder rejects SAB views (copy first — heap.mjs); assigning a class's
  `.prototype` throws in ESM strict mode.
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
devDependency served at `/vendor` by the dev server (no vendored blob); `engine-pre.js` moved to
`src/embedder/`, so `engine/WebkitWasm/web/` is harness-only and everything under `src/` is a
build input; the probe extension is a test fixture (`test/fixtures/probe-ext/`); `spikes/` and
`experiments/` are gone (blit numbers → open-questions #10, probes → `tools/`, lab notebook →
[experiment-log.md](experiment-log.md)).

Open issues in issues/ (first-nav race residual, guest-JS wedge, rcap dynamic budget, viewer
URL-scheme allowlist). Next work: [roadmap.md](roadmap.md).

## Key decisions

- **Engine: WebKit**, via the WebkitWasm lineage (WebCore embedded WebKit1-style, JSC CLoop
  interpreter, Skia). See [engine.md](engine.md).
- **Primary target: Chrome MV3** with an extension-page viewer (DNR main_frame redirect). Firefox
  later, via the StreamFilter hosting mode. See [extension-platform.md](extension-platform.md).
- **Fake in-page URL bar is acceptable** for the MVP; the address bar showing the extension URL is a
  permanent platform constraint of the extension-page mode.
- **No external servers**: networking goes through the extension's own CORS-exempt `fetch()`, not a
  Wisp/WebSocket proxy. See [networking.md](networking.md).
- Printing: out of scope. Find-in-page: reuse WebKit's engine-side implementation.
- **Activation/modes**: extension is active or inactive; when active, default is **whitelist mode**
  (sandbox-by-default — whitelist holds trusted domains that run natively, empty on install), with
  an optional **blacklist mode** (native-by-default — only listed domains run sandboxed). Shipping
  default landed with 2.6. See [ui.md](ui.md).
