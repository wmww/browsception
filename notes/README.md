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
| [engine.md](engine.md) | Engine choice (WebKit) and evaluation of alternatives; wasm porting constraints |
| [extension-platform.md](extension-platform.md) | What extension APIs allow: interception, CORS, SAB/threads, limits; Chrome vs Firefox |
| [ui.md](ui.md) | Activation states, whitelist/blacklist modes, list semantics, toolbar UI, DNR mapping |
| [networking.md](networking.md) | The fetch bridge design, cookie model, shim guard list |
| [rendering-input.md](rendering-input.md) | Blit paths, input forwarding, IME, find-in-page, clipboard, audio, popups |
| [security.md](security.md) | Threat model, trust boundaries, what we must enforce ourselves |
| [testing.md](testing.md) | Automated test tiers (unit/bridge/full-integration), fixture+oracle design, agent iteration loop |
| [open-questions.md](open-questions.md) | Unverified assumptions and spikes to run |

The MVP plan lives in [../plans/mvp.md](../plans/mvp.md).

## Status

Research/planning phase. Key decisions made so far:

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
  an optional **blacklist mode** (native-by-default — only listed domains run sandboxed). See
  [ui.md](ui.md).
