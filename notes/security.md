# Security model

## The claim we're making

A site rendered in browsception sits behind **two independent sandboxes**: it must first exploit
the nested WebKit (compiled to wasm, no JIT, no GPU, no processes, no syscalls — only our shim
imports), and then, from inside a wasm module, exploit the top-level browser. The second step
starts from a dramatically reduced position: wasm memory safety confines the "owned" engine to its
linear memory + imports; there is no ambient DOM, no host JS execution, no native code execution,
no GPU driver, no raw sockets.

Precedent for the argument: Firefox's **RLBox** (shipping since Fx 95) sandboxes native libraries
by compiling them to wasm precisely because a compromised wasm module is limited to its imports.
We apply the same trick to an entire engine.

## Trust zones

| Zone | Contents | Trust |
|---|---|---|
| Target site bytes | HTML/CSS/JS/wasm/media of nested sites | hostile |
| Engine (wasm) | WebKit + JSC + Skia + ICU… | *compromisable* — processes hostile bytes with a memory-unsafe codebase; assume it gets owned and design imports accordingly |
| Shim (viewer JS) | fetch bridge, blit, input, chrome UI | trusted, must stay tiny and auditable |
| Extension SW / DNR rules | interception, header rewrite | trusted, near-static |
| Host browser | everything else | trusted (it's the thing we're protecting) |

**Design rule: the shim's import surface is the real security boundary.** Every import the engine
gets is a capability an owned engine holds. Keep imports minimal, typed, and dumb:
network-with-guards, pixels-out, input-in, storage-namespaced, clock. No eval, no DOM handles, no
dynamic wasm instantiation rights, no blob-URL minting beyond the download path.

## Capability accounting (ABI v1 — src/abi/bib_abi.h)

Every hook the engine can call is a capability an owned engine holds. Additions to the ABI must
add a row here (working agreement).

| Hook | Capability granted to an owned engine |
|---|---|
| `bibNetBegin` / `bibNetCancel` | Issue/abort anonymous http(s) fetches, subject to the guard list (scheme/private-network/ports/caps; `credentials:'omit'` structural) |
| `bibNetAck` | Flow-control signal only (ints) |
| `bibFrame` | Paint arbitrary pixels inside its canvas (UI spoofing within the frame — accepted, see below) |
| `bibChrome` | Set viewer-displayed title/URL/progress/cursor/hover/favicon strings — spoofing surface: viewer must render these as text/DOM only, never interpret; favicon bytes get sniffed/re-encoded before use |
| `bibQueryResult` | Answer queries the shim itself asked; dev builds only for `eval` |
| `bibPersist` | Write to its own namespaced storage snapshot (quota-capped) |
| `bibReady` | Boot signal (no args) |
| `bibWakeUp` / `bibArmTimer` | Schedule its own execution (worker-scope; CPU consumption only) |

`bib_wasm_alloc/free` are host→engine-heap only and callable by the shim, not capabilities of the
engine. The engine also implicitly holds: Emscripten runtime imports (clock, math, pthread
machinery), Atomics/SAB on its own heap, and proxied-call queues — platform surface shared by any
pthread wasm module.

## What an owned engine can do (residual risk)

- Fetch arbitrary **public** http(s) URLs as an anonymous client from the user's IP (guarded:
  no credentials, no private networks, no weird schemes/ports — see networking.md). Equivalent to
  "attacker runs curl from user's IP" — same as any browser tab, minus cookies.
- Paint arbitrary pixels in its canvas and read its own inputs → **UI spoofing inside the frame**.
  It cannot draw outside the canvas or touch the real omnibox. Our fake URL bar is viewer chrome
  (DOM, not canvas), so the engine cannot forge it — keep it visually distinct from canvas content
  and never render engine pixels over it.
- Consume CPU/memory in its worker (caps + kill switch in viewer; engine crash → viewer shows
  "tab crashed" and offers reload — never auto-loops).
- Persist data in its OPFS namespace (quota-capped).
- Exploit the residual host surface it can still reach *through* the shim: the host's fetch stack
  (URL parsing, HTTP), canvas/WebGL texture upload, structured-clone/postMessage, Atomics/SAB,
  AudioWorklet (later). This is the honest accounting of "layer two": tiny compared to a full web
  platform, but not zero. Spectre-class side channels from wasm also remain (we run with
  cross-origin isolation, which is the platform's mitigation posture).

## Deliberate non-features (attack-surface decisions, final unless revisited explicitly)

- **No JIT** in the nested engine; no runtime wasm-module generation/instantiation.
- **No GPU access for the engine** — no WebGL/WebGPU imports; Skia CPU raster only. (Blit-only
  WebGL in the *shim* is fine: fixed trusted shader, attacker controls pixel data only.)
- **No raw TCP/UDP**, no external proxy infrastructure.
- **No host credentials** on bridge requests, ever (`credentials:'omit'` hardcoded).
- **No EME/DRM**, no nested-wasm-passthrough to host wasm.

## Web-platform security stays in the engine

SOP, CORS, CSP, mixed content, cookie scoping, redirect policy for nested content are enforced by
WebKit itself — the bridge sits below the loader, so these checks run unmodified (networking.md).
The shim never re-implements web security; it implements *capability* security.

## Extension-specific concerns

- The extension holds `<all_urls>` — the extension itself is a high-value target. No remote code,
  no analytics, no third-party JS in the viewer. CSP on viewer.html: self only, wasm-unsafe-eval
  as required for wasm, nothing else.
- DNR header-rewrite rules must be scoped so they can't be used to strip CSP / rewrite headers of
  *real* browsing (marker-header + initiator scoping; test this).
- Phishing consideration: our viewer intentionally looks like a browser. The real omnibox showing
  `chrome-extension://` is actually a mitigation here (can't spoof arbitrary real sites at the
  top level). Fake URL bar must always display the engine's true URL.
- Mode B (stay-on-origin, Firefox-later) weakens isolation: viewer runs in the target origin →
  site's previously-registered service workers could hijack (must unregister + clear storage on
  entry), other extensions' content scripts run there, origin credentials ambient. Documented in
  architecture.md; extension-page mode remains primary partly for this reason.

### Startup race: one navigation per browser start runs natively

Measured 2026-08-14 (Chromium 151; packed CRX external-install *and* unpacked `--load-extension`,
fresh *and* warm profiles — same result in all four): a URL handed to the browser **at launch**
(startup pages, session restore, an OS handoff — clicking a link in another app while the browser
is closed) is fetched, committed and executed **natively**. The static ruleset is not registered
when that request goes out, and nothing re-evaluates a request already on the wire. This is *not*
install-only and *not* an artifact of unpacked loading: it happens on every launch of an
already-installed extension.

The SW's tab sweep is the only backstop. Instrumented (a startup page beaconing every 10 ms): the
first script ran ~25 ms after the document request, the sweep redirected the tab into the viewer
~60–120 ms after it. So per browser start, one target page gets a real origin (cookies, storage,
SW registration, …) and ~100 ms of script. Assume anything one page-load of native JS can do, a
site on that URL can do — including persisting state that outlives the redirect.

Not fixable inside MV3: blocking webRequest is gone, DNR cannot hold a request that predates its
registration, and the SW cannot be awake before the browser starts navigating. What the sweep must
get right (tier-1 `sweep.test.mjs`): the racing tab is usually still **pre-commit**, which Chromium
reports as `url: 'about:blank'` + `pendingUrl: <target>` — reading only `tab.url` there misses
exactly the tab the sweep exists for and leaves it native indefinitely.

## Honest limitations (say these out loud in any writeup)

1. Layer two is thinner than layer one but not zero (shim + host-fetch + blit surface).
2. Side channels (timing/Spectre) are not solved by nesting.
3. Availability of the *host* browser process is only softly protected (caps, not guarantees).
4. Privacy: the user's IP still reaches sites; fingerprinting within the nested engine is uniform
   (a feature: every browsception user looks alike per engine version) but "is browsception" is
   itself detectable.
5. One navigation per browser start (a startup/handoff URL) executes natively for ~100 ms before
   the sweep sandboxes it — a hard MV3 limit, see § Startup race.
6. The engine is a fork of a fast-moving upstream; security patches must be tracked and rebased
   promptly (see engine.md on maintenance). A stale nested engine is still *contained*, but
   contained-and-owned is not the goal.
