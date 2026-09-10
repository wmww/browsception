# Plan: wire-header fidelity (Sec-Fetch, cache headers, Accept-Language)

## Why

A bridge request must look on the wire like the request the engine composed, or servers score
the mismatch as a bot / serve the wrong thing. Audit 2026-09-10 (experiment-log; real
extension, fixture oracle for the wire, a hook on `__bs.link.onNetBegin` for the engine side)
found UA, Cookie, Referer, Origin, Accept and Upgrade-Insecure-Requests right, and three
infidelities — all bridge-side, none needing a new permission:

1. **Sec-Fetch-\*.** WebCore's `CachedResourceLoader::updateRequestFetchMetadataHeaders` runs in
   this port and every https request JSON carries spec-correct values (navigation:
   `document / navigate / same-origin|cross-site`; `<img>`: `image / no-cors / …`; fetch/XHR:
   `empty / cors / …`; http targets: none, correctly). `isDropped()` in `src/shim/bridge.mjs`
   discards every `sec-*` header, so Chrome stamps its extension-page-fetch defaults
   `none / cors / empty` on everything (Firefox: `same-origin / cors / empty`). Real breakage:
   github.com/<owner>/<repo>/issues on Chrome — `/_graphql` 422s "Expected value for header
   `sec-fetch-site` is `same-origin`, but received `none`" and the page shows GitHub's error
   boundary; Firefox works only by its accidental `same-origin`. Verified 2026-09-10 that a
   session `modifyHeaders` rule can set all four `sec-fetch-*` headers on Chrome (as fix and as
   cause). The earlier idea that the engine must send its destination over the ABI is wrong: it
   already does, in the headers.
2. **`Pragma: no-cache` + `Cache-Control: no-cache` on every request.** Chromium adds both for
   `cache: 'no-store'` fetches. A real browser sends them only on a hard reload; here every
   image and script tells every CDN to bypass its cache (slower, origin load, scraper-shaped).
   The engine sends the right ones itself (`Cache-Control: max-age=0` on reload, `no-cache` for
   `fetch(…, {cache:'reload'})`, nothing otherwise) and Chromium's stamp overrides them.
   `cache:'no-store'` itself must stay: a host-cache hit skips webRequest and loses Set-Cookie.
3. **Accept-Language vs `navigator.language`.** The wire carries the host's `Accept-Language`
   (whatever the user's browser is set to); guest JS reads the engine's
   `platformUserPreferredLanguages()` (`LanguageUnix.cpp`, effectively `en-US`). Same mismatch
   class as the UA one that captcha-looped Google; also a German user gets German pages whose
   scripts think they run in `en-US`.

Residuals the engine cannot supply: `Sec-Fetch-User: ?1` (WebCore never sets it) and the first
navigation of a viewer, which the engine computes relative to its boot page
(`Sec-Fetch-Site: cross-site`) where a real address-bar load says `none`. Both are known to the
host side (`req.main`; the viewer knows `bib_load_url` was user-initiated). Side finding:
`navigator.platform` is `''` (`NavigatorBase::platform()` is `uname()`-derived and the wasm
uname yields nothing useful); real WebKitGTK says `Linux x86_64`. Fingerprint-only, fixed in
passing.

## Design

All forbidden-or-overwritten headers ride the same mechanism as Cookie today: the **base
session rule** strips what the host would otherwise stamp, the **per-request session rule**
(priority 2, exact `urlFilter`) sets what the engine sent. DNR's per-header
highest-priority-wins resolution makes the pair correct even when both match.

- `DNR_HEADERS` (bridge.mjs) gains `sec-fetch-dest`, `sec-fetch-mode`, `sec-fetch-site`,
  `sec-fetch-user`, `cache-control`, `pragma`. `isDropped()` keeps dropping `sec-ch-ua*`,
  `sec-purpose` and any other `sec-*` — only the four fetch-metadata names pass through.
- Base rule (`bridge-rules.mjs` `baseSessionRules`) additionally `remove`s `cache-control`,
  `pragma`, `sec-fetch-user`. It does NOT remove `sec-fetch-dest/mode/site`: a request the
  engine sent without them (http target) must stay stamped by the host rather than go out
  bare — Chrome would never send an https request without them, and the engine only omits
  them for http, where the host also omits them. (Check this holds on Firefox too; if Firefox
  stamps them on http, add the removes and accept "no Sec-Fetch on http" — spec-correct.)
- `perRequestHeaderRule` sets whatever of the new names are present. The per-request rule now
  exists for essentially every https request (before: only those with Cookie/Referer/Origin);
  that is one `updateSessionRules` add + one remove per request, already the common case
  because nearly every subresource carries a Referer. Keep the id ring (10000–100000) and the
  in-flight set; document the platform ceiling (5000 session rules on both browsers) — an
  in-flight count that high is unreachable through the 4 MB credit window and the engine's own
  per-host connection limits, but the bridge should fail the request with `NET_ERR.PROTOCOL`
  (it does: the add rejects) rather than fetch without the rule.
- `Sec-Fetch-User: ?1` is added bridge-side to every `req.main` request whose engine headers
  carry `Sec-Fetch-Mode: navigate` — every top-level load through this viewer is user-driven
  or a redirect of one, both of which real browsers mark `?1`... except pure JS navigations
  (`location.href = …`), which real browsers do NOT mark. The engine knows the difference
  (`NavigationAction::isRequestFromClientOrUserInput()` /
  `DocumentLoader::isRequestFromClientOrUserInput()` — the same flag
  `computeFetchMetadataSite` takes). Extend the request JSON with `"user": 1` from
  `netBridgeStart` when the load is the main resource and that flag is set (ABI doc update in
  `bib_abi.h` § Networking), and let the bridge set the header from it. No ABI version bump
  (additive, optional key).
- **First navigation → `Sec-Fetch-Site: none`.** The viewer already exempts the initial target
  in `navigationPolicy` (`firstMainSeen`). Make the same knowledge reach the header: the bridge
  gets an `initialTargetURL` option; for the first `req.main` whose URL equals it, override the
  engine's `Sec-Fetch-Site` with `none`. A later user-typed URL (`bib_load_url` from the URL
  bar) is the same case — the viewer calls `bridge.expectUserNavigation(url)` before
  `bib_load_url`, which arms the same one-shot override. Redirect hops keep the engine's value
  (the engine recomputes site per hop; `none` is only for the first hop, which is what
  browsers do).
- **Cache headers**: nothing beyond the DNR carriage; the engine's own semantics (reload →
  `max-age=0`, `cache:'reload'` fetch → `no-cache`, else nothing) are already right.
- **Languages**: the viewer passes `navigator.languages` in the boot config
  (`link.boot({languages: […]})` → worker `Module.bibLanguages` → `main.cpp` reads it the way
  `bibSeedState` is read and calls `WTF::overrideUserPreferredLanguages(...)` before the page
  is created). Guest `navigator.language(s)` and `Accept-Language` then describe the same
  user, because Chrome/Firefox derive the wire `Accept-Language` from the same list (Chrome
  reduces it to the first language + base; that is what real Chrome sends, so it is fidelity,
  not a leak). Do not send `Accept-Language` from the engine; WebCore does not compose it
  (WebKit2's network process does) and the host's value is already correct.
- **`navigator.platform`**: engine-side, `main.cpp` boot — WebKit has no setter; add a
  one-line port override in `NavigatorBase::platform()` under `PLATFORM(BIB)`/the port's
  existing `#if` (see engine-build.md § Divergences for the patch convention) returning
  `"Linux x86_64"_s`, matching the UA's `X11; Linux x86_64`.

## Steps

1. **`src/shim/bridge.mjs`** — `DNR_HEADERS` + `isDropped()` per Design; `initialTargetURL`
   option + `expectUserNavigation(url)`; `Sec-Fetch-User` from `req.user`; the `none` override.
   Header comment: list every DNR-carried header and why each is forbidden or overwritten.
2. **`src/ext/bridge-rules.mjs`** — base rule removes; `perRequestHeaderRule` handles the new
   names (make the header list a shared constant with bridge.mjs so the two cannot drift).
3. **Engine** — `BibNetBridge.cpp` `netBridgeStart`: `"user": 1` (needs the flag passed from
   `EmbedderStrategies.cpp` `scheduleLoad`, which already computes `isTopLevelDocument`; the
   user-input flag comes from the frame's active `DocumentLoader`). `main.cpp`: `bibLanguages`
   → `overrideUserPreferredLanguages`. `NavigatorBase::platform()` override. ABI doc in
   `bib_abi.h`. Rebuild (`scripts/build-engine.sh`, ~90 s embedder-only), restage.
4. **Viewer** — `viewer.mjs`: `initialTargetURL: navigateURL`, `expectUserNavigation` before
   the URL-bar `bib_load_url`, `languages: navigator.languages` in `link.boot`. Worker:
   `bibLanguages` in the `Module` literal. `engine-link.mjs` JSDoc.
5. **Tests**
   - tier-0 `bridge.test.mjs` (stubbed chrome/fetch): the partition — engine `Sec-Fetch-*` and
     `Cache-Control`/`Pragma` land in the per-request rule, `sec-ch-ua*`/`sec-purpose` are
     dropped, `Sec-Fetch-User` is set iff `req.user`, the first-main `none` override fires once
     and only for the expected URL. `bridge-rules.test.mjs`: base rule removes; header set
     shared.
   - tier-1 `bridge.test.mjs` (real Chrome, fixture oracle): extend the "no leak headers"
     test — a stub request carrying `Sec-Fetch-Dest: image` / `Sec-Fetch-Mode: no-cors` /
     `Sec-Fetch-Site: cross-site` arrives on the wire with exactly those values and no
     `pragma`/`cache-control`; a plain request arrives with no `pragma`/`cache-control` at all;
     a `Cache-Control: max-age=0` request arrives with exactly that. Assert the rule is gone
     after the terminal event (existing pattern).
   - tier-2 (real engine): one scenario that navigates `app.bstest`, loads an `<img>` and does
     a same-origin fetch, then asserts on the oracle: main `document/navigate/none` + `?1`,
     img `image/no-cors/same-origin`, fetch `empty/cors/same-origin`, no `pragma`; a reload
     (`bib_reload`) sends `max-age=0`; guest `navigator.language` equals the host's first
     language and `navigator.platform` is `Linux x86_64`. Firefox subset: the same wire
     assertions (this is where "DNR can set sec-fetch on Firefox" gets verified — if it
     cannot, Firefox keeps its accidental `same-origin` and the note records it).
   - `npm test`, `npm run test:tier2`, `test:tier2:firefox`.
6. **Real-site check** — github.com/<owner>/<repo>/issues renders the issue list on Chrome;
   google.com/search still gives results (the UA A/B from experiment-log 2026-09-10, re-run).
7. **Notes** — networking.md § Design "request fidelity" bullet + the implementation-notes
   paragraph (DNR-carried set, base strips, `none` override, languages); extension-platform.md
   forbidden-headers bullet; security.md § Sandbox→host sinks unchanged (no new sink);
   engine-build.md § Divergences (platform override, `"user"` key); testing.md scenario list;
   experiment-log.md dated entry with the before/after wire table; README status line. Delete
   this plan.

## Not in scope

`Accept-Encoding` (host's `gzip, deflate, br, zstd`; Safari has no zstd — harmless), HTTP
version and TLS fingerprint (host's; unfixable in an extension and the UA says WebKit, not
Safari-on-Mac, so JA3 mismatches are expected), client hints (stripped; a Safari UA never
sends them — correct).
