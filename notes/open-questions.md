# Open questions & spikes

Ordered roughly by how load-bearing the answer is. Each should become a small spike with a written
result appended here (keep the question, add `**Answer (date):**`).

## Blocking-risk (resolve before/at MVP start)

1. **Set-Cookie visibility on extension-page fetch.** Can the shim read `Set-Cookie` from
   responses to extension-privileged `fetch()`? (Normally a forbidden response header.) If not:
   capture via `webRequest.onHeadersReceived` (non-blocking is enough to *read*?), or DNR
   responseHeaders tricks, or tag requests and sniff via the cookies API. The isolated-jar design
   requires *some* reliable Set-Cookie path. → first networking spike.
2. **Redirects under `redirect:'manual'` from extension pages.** Does manual mode give us status +
   Location for cross-origin redirects on a CORS-exempt extension fetch, or do we get an opaque
   filtered response? Determines whether the engine can drive redirects (preferred) or the host
   follows them (fallback, documented delta). → same spike as #1.
3. **WebkitWasm build reproduction.** Does the pthread branch build and run for us, today, on our
   hardware? (~11 GB tree; expect toolchain pinning pain.) Everything sequences after this.
4. **DNR `modifyHeaders` on forbidden request headers, scoped to our own fetches.** Verify we can
   set UA/Cookie/Referer/Origin on bridge requests and reliably scope rules (initiator = extension
   origin? marker header?) so real browsing is never touched. Also verify DNR applies to
   extension-page-initiated fetches at all versions we target.

## Important, not blocking

5. **Skia CPU raster in the Emscripten port.** Effort to switch WebkitWasm from Ganesh/WebGL2 to
   CPU raster + our framebuffer export; can we get dirty rects out of WebCore's paint path cheaply?
6. **Sync XHR / blocking loads in the pthread build.** Confirm atomics-blocking network waits don't
   deadlock with `PROXY_TO_PTHREAD` (main-thread proxying rules). Decide policy for sync XHR.
7. **Chrome PNA (Private Network Access) and extension fetches.** Does Chrome apply any
   local-network protections to extension-origin fetch in current versions? Affects how much guard
   #3 in networking.md must carry alone (DNS rebinding remains ours regardless).
8. **Interception coverage edges.** Subframe navigations? (No — target iframes only exist inside
   the engine; but what about `view-source:`, `blob:`, `about:blank#...`, PDFs, `Content-Disposition:
   attachment` downloads hitting the DNR rule?) Enumerate main_frame cases and decide
   pass-through vs capture for each. Also: scoping the MVP rule to an allowlist of test domains vs
   all http(s).
9. **Per-instance memory budget.** Real WebKit-in-wasm RSS for typical sites; do we fit ~1–2 GB?
   Influences pthread pool size and whether tab-discard/restore is needed early.
10. **Frame transport pick.** texSubImage2D-from-SAB-in-render-worker vs main-thread upload:
    measure on 1080p/1440p; decide default; measure dirty-rect wins.
11. **Engine startup latency.** Cold compile of a 100–250 MB module + engine boot; how much does
    IndexedDB module caching + eager boot-at-browser-start help? Target: viewer interactive < 2s
    warm.

## Later / strategic

12. **Chrome: does injected COOP/COEP via DNR make a real page crossOriginIsolated?** Only matters
    for a hypothetical Chrome mode B. Low priority.
13. **Firefox port plan.** Single-thread build performance reality check; StreamFilter mode B
    prototype (also the FF threads unlock — bug 1673477 tracking).
14. **Kitesurf open-sourcing** (Cloudflare, promised 2026-08): if it lands embeddable, evaluate as
    a lightweight second engine (Blitz+Stylo+Boa, no video/WebGL — but tiny vs WebKit).
15. **WebSocket bridging** for nested-page WS (host WebSocket from extension origin). Post-MVP.
16. **weval-style AOT for JS** — no JSC equivalent exists; research direction only.
17. **Store review risk.** A `<all_urls>` + DNR-redirect-everything extension with a 100+ MB wasm
    blob will get human review. Prepare: clear listing, source availability, scoped-permission
    onboarding (per-site activation mode as the store-friendly default?). CheerpJ's MV3 postmortem
    is the cautionary tale.
18. **POST-navigation loss** (MV3 can't recover top-level POST bodies): quantify how often this
    bites real flows; possible mitigations inside the engine (most form posts originate inside the
    nested world and never hit the limitation).
19. **Headless Chromium (`--headless=new`) parity for our stack.** Verify extensions + DNR
    main_frame redirect + manifest COOP/COEP (SAB/threads) + `--host-resolver-rules` all behave in
    headless=new identically to headed — CI (testing.md tiers 1–2) depends on it. If any piece
    diverges, fallback is running CI's Chromium inside guibox/Xvfb-style sessions (slower, still
    automated).
20. **Fixture HTTPS trust in test profiles.** Confirm the mkcert-style local CA import into the
    disposable `--user-data-dir` works for both headless CI and guibox sessions (or whether
    `--ignore-certificate-errors` is acceptable for tier 1 while keeping one real-TLS test in
    tier 2).
