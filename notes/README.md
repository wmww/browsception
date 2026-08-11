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
| [engine-build.md](engine-build.md) | Reproducible WebkitWasm build (pins, fixes, sizes, divergences); incremental-iteration recipe |
| [rendering-input.md](rendering-input.md) | Blit paths, input forwarding, IME, find-in-page, clipboard, audio, popups |
| [security.md](security.md) | Threat model, trust boundaries, what we must enforce ourselves |
| [testing.md](testing.md) | Automated test tiers (unit/bridge/full-integration), fixture+oracle design, agent iteration loop |
| [worktrees.md](worktrees.md) | Ephemeral-worktree workflow: wt-setup, shared engine tree + lock, artifact snapshots, per-checkout ports |
| [open-questions.md](open-questions.md) | Unverified assumptions and spikes to run (answers appended in place) |
| [roadmap.md](roadmap.md) | Post-MVP fast-follows, cleanups, standing risks, working agreements |

## Status

**MVP complete** (2026-08-10, all gates passed). The MVP plan is retired; its surviving content
lives in [roadmap.md](roadmap.md). Phase summaries:

- **Phase 0 spikes**: engine build reproduced (engine-build.md, `tools/build-engine.sh`); bridge
  design verified — engine-driven redirects, webRequest Set-Cookie capture (bridge-probe.md);
  interception matrix + blit path + test harness stood up (testing.md).
- **Phase 1 engine⇄shim**: versioned ABI (`src/abi/bib_abi.h` + abi.mjs mirror); engine fork
  (branch `browsception` in engine/WebkitWasm) transplanted networking onto the host-fetch bridge
  (BibNetBridge, no curl/wisp in the path), rendering to a runtime-sized shared-heap framebuffer
  (`bibFrame` zero-copy present), input through WebCore's EventHandler, crash/heartbeat recovery,
  flat-heap leak check. Exit gate: 10.2-min crash-free real-site browse (experiments/log.md).
- **Phase 2 extension**: viewer hosts the engine (src/ext/viewer.mjs + blit.mjs, OPFS persistence,
  `__bs` test hook); SW reconciles storage.sync state → DNR + symmetric tab sweep (sw.mjs);
  browser chrome v1 (true-URL bar, back/forward/reload via real BackForwardList, progress, nested
  title — the buttons later gave way to native history, below); activation & modes UI (popup/options/badge, actions.mjs matrix);
  sandboxed→native boundary (engine flags top-level loads, bridge policy natives them);
  guard-rail invariants green (hostile.bstest full pass, no top-level target docs); **2.6
  whitelist-by-default** — `DEFAULT_STATE.mode='whitelist'`, static catch-all enabled in the
  manifest so a fresh install intercepts before the SW runs (ui.md § shipping default). Exit
  gate: tools/smoke-mvp.mjs real-site pass — sandboxed example.com/wikipedia, whitelist→native
  sweep (experiments/log.md 2026-08-10).

Tests: `npm test` = tiers 0–1, pure headless, per-commit (70 tests). `npm run test:tier2` = 13
scenarios against the staged engine artifact (~15 s; restage with tools/stage-engine.mjs after
engine rebuilds — src/engine/ is gitignored). Engine iteration is genuinely incremental (~90 s
for embedder-only changes; engine-build.md fix 6).

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

Open issues in issues/ (first-nav race residual, guest-JS wedge, engine-side load failures
silent). Next work: [roadmap.md](roadmap.md).

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
