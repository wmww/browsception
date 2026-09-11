# Open questions & spikes

Ordered roughly by how load-bearing the answer is. Each should become a small spike with a written
result appended here (keep the question, add `**Answer (date):**`).

## Blocking-risk (resolve before/at MVP start)

1. **Set-Cookie visibility on extension-page fetch.** Can the shim read `Set-Cookie` from
   responses to extension-privileged `fetch()`? (Normally a forbidden response header.) If not:
   capture via `webRequest.onHeadersReceived` (non-blocking is enough to *read*?), or DNR
   responseHeaders tricks, or tag requests and sniff via the cookies API. The isolated-jar design
   requires *some* reliable Set-Cookie path. → first networking spike.
   **Answer (2026-08-09):** `fetch()` never sees it, but observational
   `webRequest.onHeadersReceived` with `['responseHeaders','extraHeaders']` sees it fully
   (incl. HttpOnly, per redirect hop). Capture keyed by response URL — no request
   correlation needed for the jar. See notes/bridge-probe.md; asserted in
   test/tier1/bridge-probe.test.mjs.
2. **Redirects under `redirect:'manual'` from extension pages.** Does manual mode give us status +
   Location for cross-origin redirects on a CORS-exempt extension fetch, or do we get an opaque
   filtered response? Determines whether the engine can drive redirects (preferred) or the host
   follows them (fallback, documented delta). → same spike as #1.
   **Answer (2026-08-09):** `manual` is opaque (`opaqueredirect`, status 0) even for
   extensions — but engine-driven redirects still work via `redirect:'error'`: webRequest
   captures the 3xx (status/Location/Set-Cookie) before the abort and the redirect target
   never hits the wire; the engine then issues the next hop itself. Host-followed
   redirects are rejected (DNR-set Cookie would ride cross-origin hops — observed leak).
   See notes/bridge-probe.md decisions 1–3.
3. **WebkitWasm build reproduction.** Does the pthread branch build and run for us, today, on our
   hardware? (~11 GB tree; expect toolchain pinning pain.) Everything sequences after this.
   **Answer (2026-08-10): YES.** Fresh-clone build reproduced (five fixes needed, all
   encoded in scripts/build-engine.sh); demo gate PASS headless; example.com renders
   through the engine. 103 MB embedder.wasm, ~45 min WebCore build at 12 jobs. Full
   notes: notes/engine-build.md. The pthread branch is now upstream `main` (mvp.md's
   `wb1-pthread` reference was stale).
4. **DNR `modifyHeaders` on forbidden request headers, scoped to our own fetches.** Verify we can
   set UA/Cookie/Referer/Origin on bridge requests and reliably scope rules (initiator = extension
   origin? marker header?) so real browsing is never touched. Also verify DNR applies to
   extension-page-initiated fetches at all versions we target.
   **Answer (2026-08-09):** Yes to all: UA/Cookie/Referer/Origin set + marker header
   removed on the wire, scoped by `initiatorDomains: [<ext id>]` +
   `resourceTypes: ['xmlhttprequest']`; simultaneous native traffic untouched in both
   directions (oracle-verified). Note: DNR strips happen before webRequest observes, so
   marker-based correlation is impossible; and `sec-ch-ua*` hints must also be removed.
   See notes/bridge-probe.md.

## Important, not blocking

5. **Skia CPU raster in the Emscripten port.** Effort to switch WebkitWasm from Ganesh/WebGL2 to
   CPU raster + our framebuffer export; can we get dirty rects out of WebCore's paint path cheaply?
   **ANSWERED**: done, and dirty rects came out cheaply (ChromeClient invalidation → damage list;
   rendering-input.md). The Ganesh/WebGL2 path was deleted outright on 2026-08-15 — including
   every GL entry point it left in the module's imports (engine-build.md § No-GPU link contract).
6. **Sync XHR / blocking loads in the pthread build.** Confirm atomics-blocking network waits don't
   deadlock with `PROXY_TO_PTHREAD` (main-thread proxying rules). Decide policy for sync XHR.
   **Moot (2026-09-09):** the shipping link has no second thread to block on; sync XHR stays
   unsupported in the engine (networking.md), and the proxy link is an unshipped experiment.
7. **Chrome PNA (Private Network Access) and extension fetches.** Does Chrome apply any
   local-network protections to extension-origin fetch in current versions? Affects how much guard
   #3 in networking.md must carry alone (DNS rebinding remains ours regardless).
   **Answer (2026-08-09):** None. Extension-page fetch to loopback succeeds (Chromium
   150). Guard #3 carries private-network blocking alone; asserted permanently in
   test/tier1/bridge-probe.test.mjs.
8. **Interception coverage edges.** Subframe navigations? (No — target iframes only exist inside
   the engine; but what about `view-source:`, `blob:`, `about:blank#...`, PDFs, `Content-Disposition:
   attachment` downloads hitting the DNR rule?) Enumerate main_frame cases and decide
   pass-through vs capture for each. Also: scoping the MVP rule to an allowlist of test domains vs
   all http(s).
   **Answer (2026-08-09, partial — see test/tier1/interception.test.mjs):** http + https
   both intercept; redirect fires at request time so attachment/download responses on
   intercepted domains never reach the download manager (viewer must handle them);
   `view-source:` of an intercepted domain redirects its inner request (invariant holds,
   renders viewer source — harmless); back/forward hold viewer URLs and work; static
   rules fire with the SW force-killed; whitelist shape (catch-all + allow@10 + session
   escape hatch@100 with tabIds) behaves exactly as designed. `blob:`/`about:`/PDF-served-
   inline cases still to enumerate. Answered 2026-08-14: the first navigation racing ruleset
   registration is not a fresh-profile quirk — every browser start with a startup/handoff URL
   loads it natively for ~100 ms; hard MV3 limit, sweep is the backstop (security.md § Startup
   race, experiment-log 2026-08-14).
9. **Per-instance memory budget.** Real WebKit-in-wasm RSS for typical sites; do we fit ~1–2 GB?
   Influences pthread pool size and whether tab-discard/restore is needed early.
10. **Frame transport pick.** texSubImage2D-from-SAB-in-render-worker vs main-thread upload:
    measure on 1080p/1440p; decide default; measure dirty-rect wins.
    **ANSWERED (2026-08-09, spike 0.4):** default = main-thread WebGL2 texSubImage2D
    straight from the SAB — Chromium 150 accepts a SAB-backed view in texSubImage2D
    directly, so no staging copy is needed (the copy fallback exists and self-activates
    on a thrown upload). Measured on Chromium 150, 5 s per config, engine at 60 fps,
    headless SwiftShader vs windowed Radeon 890M; blit ms = avg / p95, CPU-side inside
    the blit call:

    | config | headless | windowed |
    |---|---|---|
    | 1080p webgl2 full | 0.65 / 0.75 | 0.68 / 1.45 |
    | 1080p webgl2 dirty (~10% rows) | 0.10 / 0.13 | 0.11 / 0.25 |
    | 1440p webgl2 full | 1.31 / 1.95 | 1.02 / 1.33 |
    | 1440p webgl2 dirty | 0.16 / 0.19 | 0.11 / 0.32 |
    | 1080p 2d full | 1.30 / 1.50 | 1.40 / 2.78 |
    | 1440p 2d full | 2.64 / 3.41 (**45 fps**) | 3.21 / 3.95 |

    Cost is flat whether or not the GPU is real, and a `gl.finish()` variant changed
    nothing — upload submission *is* the main-thread cost, no hidden GPU tail. So
    putImageData is compat/debug only: 2–3×, always pays a full SAB copy, and is the one
    config that dropped frames. Dirty rows ~10% → 0.1–0.2 ms (6–15× win, one contiguous
    row-band upload on both paths) — worth carrying row-band dirty info out of the engine
    from day one, but full-frame-every-frame is affordable, so it's an optimization, not a
    requirement. Input ring (SPSC, 256 × 40 B) round-trip avg 5–14 ms / p95 19–31 ms,
    dominated by rAF quantization (the worker wakes on `Atomics.notify` within the ms);
    zero drops at 30 events/s. A render-worker/OffscreenCanvas variant wasn't needed;
    revisit only if the main thread gets congested. The spike's blit paths graduated
    into `src/ext/blit.mjs`.
11. **Engine startup latency.** Cold compile of a 100–250 MB module + engine boot; how much does
    IndexedDB module caching + eager boot-at-browser-start help? Target: viewer interactive < 2s
    warm.
    **ANSWERED (2026-08-10, 2.1):** non-issue on Chromium 150 — extension viewer boots the
    102 MB module to interactive in ~620 ms cold / ~360 ms warm (headless, Liftoff tiering).
    Target beaten 5×; IndexedDB module caching and eager boot both dropped from the MVP.
    Tier-2 scenario 13 tripwires warm boot at 15 s. Revisit only for the Firefox port.

## Later / strategic

12. **Chrome: does injected COOP/COEP via DNR make a real page crossOriginIsolated?** Only matters
    for a hypothetical Chrome mode B. Low priority.
13. **Firefox port plan.** Superseded by plans/one-engine-both-browsers.md (worker-hosted
    non-pthread link on both browsers; mode B dropped). Probe results land here.
    **Answer (2026-09-09, Firefox 155.0.1 headless, `scripts/probe-firefox.mjs` + landed
    `test/tier2/firefox.test.mjs`):** every probe passed; the port shipped the same day.
    | Probe | Result |
    |---|---|
    | DNR main_frame redirect (static catch-all, dynamic, allow@10, session `tabIds`, `updateEnabledRulesets`) | PASS — raw target after `url=`; relative `regexSubstitution` = silent no-op, `extensionPath` drops `\0`; 29997 static rules available |
    | Session `modifyHeaders` (UA/Cookie/Referer/Origin) scoped by `initiatorDomains: [uuid]` | PASS on the wire, plain tab untouched; gecko id as initiatorDomain → "Invalid domain"; ext-page fetch is CORS-exempt (`type: 'basic'`) |
    | webRequest from an extension page | PASS — `onHeadersReceived` + `['responseHeaders']` shows 302/Location/HttpOnly Set-Cookie; `'extraHeaders'` rejected; `onBeforeRedirect` never fires under `redirect:'error'`; `initiator` undefined, `originUrl` set; listener survives event-page suspend |
    | OPFS (`createWritable` on the page) | PASS, quota ~2.5 GB |
    | Worker: non-shared `WebAssembly.Memory` grown to 4095 MB, `importScripts`, `import()` | PASS; page `crossOriginIsolated === false`, no `SharedArrayBuffer` |
    | WebGL2 `texSubImage2D` 1600×900 in headless | PASS, real context (Mesa), median 2 ms/upload |
    | Event page: `chrome.*` promise-returning DNR/storage.session/tabs/onMessage/action | PASS; no `clients`/`self.registration` |
    | CSP `'wasm-unsafe-eval'` page + worker; Chrome-only manifest keys | PASS; `key`/COOP/COEP warn only |
    Automation: hand-rolled WebDriver BiDi over Node's WebSocket (`webExtension.install`
    `{type:'path'}`, `--remote-allow-system-access`), fixtures via `network.dns.localDomains` +
    `network.socket.forcePort`, TLS via `acceptInsecureCerts` — test/harness/firefox.mjs.
    Residual: whether dynamic rules apply at browser startup before the event page runs
    (temporary installs can't probe it; the sweep is the backstop regardless).
14. **Kitesurf open-sourcing** (Cloudflare, promised 2026-08): if it lands embeddable, evaluate as
    a lightweight second engine (Blitz+Stylo+Boa, no video/WebGL — but tiny vs WebKit).
15. **WebSocket bridging** for nested-page WS (host WebSocket from extension origin). Post-MVP.
16. **weval-style AOT for JS** — no JSC equivalent exists; research direction only.
17. **Store review risk.** A `<all_urls>` + DNR-redirect-everything extension with a 100+ MB wasm
    blob will get human review. Prepare: clear listing, source availability, scoped-permission
    onboarding (per-site activation mode as the store-friendly default?). CheerpJ's MV3 postmortem
    is the cautionary tale. Channels, requirements and the checklist: distribution.md
    (the id pin that would have broken a store install is gone — 2026-09-09).
18. **POST-navigation loss** (MV3 can't recover top-level POST bodies): quantify how often this
    bites real flows; possible mitigations inside the engine (most form posts originate inside the
    nested world and never hit the limitation).
19. **Headless Chromium (`--headless=new`) parity for our stack.** Verify extensions + DNR
    main_frame redirect + manifest COOP/COEP (SAB/threads) + `--host-resolver-rules` all behave in
    headless=new identically to headed — CI (testing.md tiers 1–2) depends on it. If any piece
    diverges, fallback is running CI's Chromium inside guibox/Xvfb-style sessions (slower, still
    automated).
    **Answer (2026-08-09):** Full parity confirmed (Chromium 150, plain `--headless` is
    new headless): unpacked extension + SW, crossOriginIsolated + SAB + shared wasm
    memory + worker Atomics on extension pages, DNR regexSubstitution redirect, resolver
    rules incl. port override. test/tier1/parity.test.mjs guards this per-commit.
    (Real threaded-wasm pthread module still to smoke once emsdk is available.)
20. **Fixture HTTPS trust in test profiles.** Confirm the mkcert-style local CA import into the
    disposable `--user-data-dir` works for both headless CI and guibox sessions (or whether
    `--ignore-certificate-errors` is acceptable for tier 1 while keeping one real-TLS test in
    tier 2).
    **Answer (2026-08-09, decision):** went with `--ignore-certificate-errors` +
    self-signed cert (auto-generated into test/fixtures/ca/) for tiers 0–1 and guibox —
    works in both. Chromium's Linux NSS cert DB is per-$HOME, not per-profile, so real CA
    import would leak outside disposable profiles anyway. Keep the planned one
    real-TLS-trust test for tier 2.
21. **Clipboard host facts** (plans/clipboard.md step 0): on a focused non-editable canvas in an
    extension page, does Ctrl+V fire `paste` with readable `clipboardData` and no prompt —
    Chrome expected yes, Firefox unverified for a non-editable target (fallback: a readonly
    hidden textarea sink; copy/cut go through the engine key map and need no probe); does
    `navigator.clipboard.write` succeed from transient
    activation without `clipboardWrite` on Firefox; do headless Chrome/Firefox clipboards
    round-trip through one page (tier-2 feasibility).
    **Answer (2026-09-10, Chrome 152 / Firefox 155, headless, extension page, real keys):**
    all yes, no permission, no prompt. Ctrl+V on a focused `<canvas tabindex=0>` fires `paste`
    with readable `text/plain`/`text/html` (Chrome: also `files` for an image) — Chrome targets
    the canvas, **Firefox the body**, so the listeners sit on `document`. `clipboard.write()` of
    a `ClipboardItem{text/plain, text/html}` 40 ms after a keydown succeeds on both; Firefox
    rejects it with NotAllowedError without activation, Chrome allows it (auto-granted
    clipboard-write) — hence the viewer's own ≤5 s input gate. Both headless clipboards
    round-trip. Shift+Insert fired no paste under the Firefox harness's synthesized keys
    (native key bindings aren't consulted for them) — unverified with real keys. Harness
    finding: BiDi `input.performActions` refuses moz-extension pages ("privileged scope");
    trusted keys come from an `nsITextInputProcessor` in the chrome window instead
    (testing.md § Launch recipes).
22. **IME / on-screen-keyboard host facts** (plans/text-input.md § Probes): does an unprevented
    dead-key/IME keydown compose into a 1-px `opacity:0` textarea on Linux ibus, Firefox and
    macOS (record the event traces as tier-0 fixtures); does `textarea.focus()` ~50 ms after
    the tap raise the OSK on Firefox Android and a Windows/ChromeOS touch host (Chrome:
    transient activation; Gecko: 1 s `IsHandlingUserInput` grace — fallback is engine-published
    editable rects for synchronous focus); do `inputmode`/`enterkeyhint`/`autocapitalize` on the
    mirror drive the OSK; is `interactive-widget=resizes-content` honoured by Firefox Android.
    Unanswered.
