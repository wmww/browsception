# Bridge probe results (spike 0.2, 2026-08-09)

Environment: Chromium 150.0.7871.186 (Arch), headless, probe extension `spikes/probe-ext/`.
All rows are asserted permanently by `test/tier1/bridge-probe.test.mjs` (per-commit CI);
rerun that suite to revalidate on new Chrome versions.

## Result table

| Probe | Result |
|---|---|
| Cross-origin `fetch()` from extension page, no CORS headers on target | ✅ full read, `type:'basic'`, body readable |
| `redirect:'manual'` (same- and cross-origin) | ❌ `opaqueredirect`, status 0, no Location — useless even with extension privileges |
| `redirect:'follow'` | ✅ works; `redirected` flag + final `url` exposed; intermediate hops invisible to fetch |
| `redirect:'error'` + observational webRequest | ✅ `onHeadersReceived`/`onBeforeRedirect` deliver status, `Location`, and hop `Set-Cookie` **before** the abort (`net::ERR_ABORTED`); redirect target never hits the wire (oracle-verified) |
| `Set-Cookie` visibility on extension fetch | ❌ invisible to `fetch()` (`getSetCookie()` empty) |
| `Set-Cookie` via `webRequest.onHeadersReceived` + `['responseHeaders','extraHeaders']` | ✅ fully visible, **including HttpOnly**, per redirect hop |
| DNR `modifyHeaders` on UA/Cookie/Referer/Origin for bridge fetches | ✅ all rewritten on the wire; scoped by `initiatorDomains:[<ext id>]` + `resourceTypes:['xmlhttprequest']` |
| DNR scoping leak check | ✅ simultaneous native-tab fetch to same URL: headers untouched both directions |
| DNR marker-header strip vs webRequest | marker removed by DNR is **already gone** in `onSendHeaders` — webRequest observes post-DNR headers; don't plan marker-based correlation |
| Host jar isolation | ✅ host-jar cookie primed natively never rides a bridge fetch; `credentials:'omit'` also drops response Set-Cookie on the floor (nothing enters host jar) |
| Chrome PNA for extension fetches (open-questions #7) | ❌ no protection: extension page fetched loopback successfully — **guard list carries private-network blocking alone** |
| Client hints | ⚠ `sec-ch-ua*` headers still leak host Chromium — bridge DNR rule set must also `remove` them |

## Decisions

1. **Redirects are engine-driven** (preferred design holds, via a different mechanism than
   hoped): bridge fetches use `redirect:'error'`; a persistent observational webRequest
   listener (viewer-registered) records `(url → status, Location, Set-Cookie[])` for bridge
   requests; when the fetch rejects on a redirect, the shim looks up the captured 3xx by URL
   and reports it to the engine's loader, which applies its own redirect security logic and
   issues the next hop as a fresh bridge request with hop-correct headers. The 3xx is taken from
   `onBeforeRedirect` — stack-synthesized redirects (HSTS upgrades, DNR redirects) fire no
   `onHeadersReceived` at all; see networking.md.
   Rationale: host-followed redirects would apply the DNR-set `Cookie` (computed for the
   original origin) to cross-origin hops — a cookie leak across origins. Observed directly.
2. **Set-Cookie capture = webRequest observational**, keyed by response URL. No request-id
   correlation needed for the jar: applying `Set-Cookie` keyed by the URL that produced it is
   correct regardless of which engine request triggered it. `webRequest` permission (not
   `webRequestBlocking`) suffices in MV3 and includes HttpOnly values with `extraHeaders`.
3. **Per-request Cookie injection**: one short-lived DNR session rule per in-flight bridge
   request (exact `urlFilter`, engine-jar Cookie value), added before fetch, removed after —
   never a static Cookie value that could ride a redirect. (Perf of rule churn: measure in
   1.2; fallback is batching per origin. Redirects can't leak it since hops abort.)
4. Bridge DNR rule set must strip `sec-ch-ua*` and set UA per profile.
5. Guard list (tier-0) is the only private-network defense; keep its table growing.

## Still open (deferred to Phase 1.2)

- DNR session-rule add/remove latency per request (cookie injection cost) — measure with
  the stub engine under load.
- webRequest event → in-flight-request lookup under concurrency: URL-keyed map with FIFO
  per (url, method); confirm ordering guarantees suffice in practice.
- A real pthread-built wasm module smoke (needs emsdk from 0.1 bootstrap) — shared
  `WebAssembly.Memory` + worker Atomics already verified green.
