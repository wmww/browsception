# Plan: wire-header fidelity (Sec-Fetch, cache headers, Accept-Language)

## Why

A bridge request must look on the wire like the request the engine composed, or servers score
the mismatch as a bot / serve the wrong thing. Audit 2026-09-10 (experiment-log; real
extension, fixture oracle for the wire, a hook on `__bs.link.onNetBegin` for the engine side)
found UA, Cookie, Referer, Origin, Accept and Upgrade-Insecure-Requests right, and three
infidelities — none needing a new permission:

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
   **Probably not fixable** — see Design; gated on a probe.
3. **Accept-Language vs `navigator.language`.** The wire carries the host's `Accept-Language`
   (whatever the user's browser is set to); guest JS reads the engine's
   `platformUserPreferredLanguages()` (`LanguageUnix.cpp`, effectively `en-US`). Same mismatch
   class as the UA one that captcha-looped Google; also a German user gets German pages whose
   scripts think they run in `en-US`.

Two more things the audit filed as "engine cannot supply" are engine-side after all:

- **First navigation says `Sec-Fetch-Site: cross-site`** (relative to the boot page) where a real
  address-bar load says `none`. WebCore already does the right thing:
  `computeFetchMetadataSiteInternal` returns `None` for a main-resource `navigate` when
  `DocumentLoader::isRequestFromClientOrUserInput()` is set — and recomputes it per redirect hop
  with the same flag (`SubresourceLoader::willSendRequest`), so every hop of a user-typed
  navigation says `none`, exactly as Chrome does. The flag is simply never set: `bib_load_url`
  (main.cpp) builds its `FrameLoadRequest` bare, whereas every WebKit2 client load
  (`WebPage::loadRequest`) calls `setIsRequestFromClientOrUserInput()`. `bib_reload` already
  passes `isRequestFromClientOrUserInput = true`. Fix: one line in `bib_load_url`. No bridge
  involvement, no first-navigation bookkeeping.
- **`Sec-Fetch-User: ?1`.** WebCore never sets it (not even in `HTTPHeaderNames.in`). Real
  browsers send it on navigations that carry user activation: address bar, reload, link clicks
  and form submissions under a gesture, JS navigations inside a click handler — and on every
  redirect hop of those. Not on `location.href = …` from a timer. WebCore has both halves of that
  on the active `DocumentLoader`: `isRequestFromClientOrUserInput()` (client loads, drag-drop —
  NOT link clicks) and `triggeringAction().processingUserGesture()` (the gesture token captured
  when the `NavigationAction` was built). The embedder can add the header itself.

Side finding: `navigator.platform` is `''` (`NavigatorBase::platform()` is `uname()`-derived and
the wasm uname yields nothing useful); real WebKitGTK says `Linux x86_64`. Fingerprint-only,
fixed in passing.

## Design

All forbidden-or-overwritten headers ride the same mechanism as Cookie today: the **base
session rule** strips what the host would otherwise stamp, the **per-request session rule**
(priority 2, exact `urlFilter`) sets what the engine sent. DNR's per-header
highest-priority-wins resolution makes the pair correct even when both match.

- `DNR_HEADERS` (bridge.mjs) gains `sec-fetch-dest`, `sec-fetch-mode`, `sec-fetch-site`,
  `sec-fetch-user`. `isDropped()` keeps dropping `sec-ch-ua*`, `sec-purpose` and any other
  `sec-*` — only the four fetch-metadata names pass through.
- Base rule (`bridge-rules.mjs` `baseSessionRules`): **no new removes** for Sec-Fetch. It does
  NOT remove `sec-fetch-dest/mode/site`: a request the engine sent without them (http target)
  must stay stamped by the host rather than go out bare — Chrome would never send an https
  request without them, and the engine only omits them for http, where the host also omits them.
  (Check this holds on Firefox too; if Firefox stamps them on http, add the removes and accept
  "no Sec-Fetch on http" — spec-correct.) `sec-fetch-user` needs no remove either: the host
  never stamps it on a fetch.
- `perRequestHeaderRule` sets whatever of the new names are present. The per-request rule now
  exists for essentially every https request (before: only those with Cookie/Referer/Origin);
  that is one `updateSessionRules` add + one remove per request, already the common case
  because nearly every subresource carries a Referer. Keep the id ring (10000–100000) and the
  in-flight set; document the platform ceiling (5000 session `modifyHeaders` rules on both
  browsers) — an in-flight count that high is unreachable through the 4 MB credit window and
  the engine's own per-host connection limits, but the bridge should fail the request with
  `NET_ERR.PROTOCOL` (it does: the add rejects) rather than fetch without the rule.
  Known residual, same root cause as the existing cookie caveat in `perRequestHeaderRule`'s
  doc: two in-flight bridge requests for the **same URL** (an `<img>` and a `fetch()` of it)
  both match both rules and one may get the other's `Sec-Fetch-Dest`. DNR cannot condition on
  request headers and fragments never reach the wire, so there is no per-request marker;
  accept and document.
- **`Sec-Fetch-Site: none` and `Sec-Fetch-User` are the engine's.** `bib_load_url` marks its
  `FrameLoadRequest` `setIsRequestFromClientOrUserInput()` (what `WebPage::loadRequest` does;
  side effects are the WebKit2-client ones — `allowsDataURLsForMainFrame`, no cross-document
  view transition — all appropriate for a URL-bar load). `EmbedderStrategies.cpp` `loadResource`,
  which already computes `isTopLevelDocument`, adds
  `request.setHTTPHeaderField("Sec-Fetch-User"_s, "?1"_s)` when `isTopLevelDocument`, the
  request already carries `Sec-Fetch-Mode: navigate` (so http targets and non-navigations get
  nothing — same trustworthiness gate WebCore applied), and the frame's active `DocumentLoader`
  has `isRequestFromClientOrUserInput() || triggeringAction().processingUserGesture()`. Redirect
  hops copy the previous request's headers (`BibResourceLoad::performRedirect`:
  `ResourceRequest request = m_loader->request()`), so the header persists across hops like in
  Chrome while WebCore recomputes Dest/Mode/Site. No ABI change, nothing for the bridge to
  decide: it carries `sec-fetch-user` like the other three. The viewer's `firstMainSeen`
  exemption in `navigationPolicy` is unrelated and stays.
- **Cache headers — probe before designing.** `Cache-Control`/`Pragma` are not fetch-forbidden;
  the engine's `Cache-Control: max-age=0` already reaches the fetch init and is overwritten
  anyway, which points at the stamp living **below the extension hooks**: Chromium adds them for
  `LOAD_BYPASS_CACHE` in `HttpNetworkTransaction::BuildRequestHeaders`, Gecko in
  `nsHttpChannel::SetupTransaction`, both after webRequest/DNR have run. If so, neither a DNR
  `remove` nor a DNR `set` can touch them and the item is a documented residual of
  `cache:'no-store'` (which stays — the alternatives all read the host cache and lose
  Set-Cookie). Probe (same scratch harness as the sec-fetch probe): base rule `remove`s
  `pragma`/`cache-control`, a `webRequest.onSendHeaders` listener logs what the extension layer
  sees, fixture oracle shows the wire. Outcomes: (a) wire still carries them → residual,
  documented in networking.md, no code, and the tier-1/2 cache-header assertions below are
  dropped; (b) they vanish → add the removes to the base rule, add both names to `DNR_HEADERS`
  so the engine's own values ride per-request, and keep the assertions. Do the probe first: it
  decides the test list.
- **Languages**: the viewer passes `navigator.languages` in the boot config
  (`link.boot({languages: […]})` → worker `Module.bibLanguages` → `main.cpp` reads it the way
  `bibSeedState` is read and calls `WTF::overrideUserPreferredLanguages(...)` before the page
  is created). Guest `navigator.language(s)` and `Accept-Language` then describe the same
  user, because Chrome/Firefox derive the wire `Accept-Language` from the same list (Chrome
  reduces it to the first language + base; that is what real Chrome sends, so it is fidelity,
  not a leak). Do not send `Accept-Language` from the engine; WebCore does not compose it
  (`CachedResourceLoader.cpp`: "handled in underlying port-specific code") and the host's value
  is already correct.
- **`navigator.platform`**: engine-side — WebKit has no setter; add a `#if defined(__EMSCRIPTEN__)`
  branch ahead of the `OS(LINUX)` one in `NavigatorBase::platform()` (the patch's convention —
  25 hunks use exactly that guard; `NavigatorBase.cpp` is a new file in the patch, engine-build.md
  § Divergences) returning `"Linux x86_64"_s`, matching the UA's `X11; Linux x86_64`.

## Steps

0. **Probe** the cache-header stamp (Design) — decides whether `cache-control`/`pragma` appear
   anywhere below. Record the result in experiment-log.md either way.
1. **`src/shim/bridge.mjs`** — `DNR_HEADERS` + `isDropped()` per Design. Header comment: list
   every DNR-carried header and why each is forbidden or overwritten.
2. **`src/ext/bridge-rules.mjs`** — `perRequestHeaderRule` handles the new names (make the
   header list a shared constant with bridge.mjs so the two cannot drift); base rule removes
   only if the probe said (b). Update the file header's two-layer description.
3. **Engine** — `main.cpp` `bib_load_url`: `frameLoadRequest.setIsRequestFromClientOrUserInput()`.
   `EmbedderStrategies.cpp` `loadResource`: the `Sec-Fetch-User` header per Design. `main.cpp`:
   `bibLanguages` → `overrideUserPreferredLanguages`. `NavigatorBase::platform()` override in the
   patch. No ABI change. Rebuild (`scripts/build-engine.sh`, ~90 s embedder-only; the
   `NavigatorBase.cpp` hunk makes it a WebCore rebuild — notes/worktrees.md § Engine work),
   restage.
4. **Viewer** — `viewer.mjs`: `languages: navigator.languages` in `link.boot`. Worker:
   `bibLanguages` in the `Module` literal. `engine-link.mjs` JSDoc.
5. **Tests**
   - tier-0 `bridge.test.mjs` (stubbed chrome/fetch): the partition — engine `Sec-Fetch-Dest/
     Mode/Site/User` land in the per-request rule, `sec-ch-ua*`/`sec-purpose`/other `sec-*` are
     dropped, a request without them gets no rule (plain http GET still rule-free).
     `bridge-rules.test.mjs`: header set shared; base rule unchanged (or the removes, per probe).
   - tier-1 `bridge.test.mjs` (real Chrome, fixture oracle): extend the "no leak headers"
     test — a stub request carrying `Sec-Fetch-Dest: image` / `Sec-Fetch-Mode: no-cors` /
     `Sec-Fetch-Site: cross-site` / `Sec-Fetch-User: ?1` arrives on the wire with exactly those
     values; a stub request without them arrives with Chrome's defaults (the base rule did not
     strip them). Assert the rule is gone after the terminal event (existing pattern). Probe (b)
     only: no `pragma`/`cache-control` on a plain request, `Cache-Control: max-age=0` arrives
     exactly.
   - tier-2 (real engine): extend an existing `app.bstest` scenario (testing.md growth policy)
     with oracle assertions: URL-bar load `document/navigate/none` + `?1`; `<img>`
     `image/no-cors/same-origin`, no `Sec-Fetch-User`; same-origin fetch `empty/cors/same-origin`;
     a clicked same-origin link `document/navigate/same-origin` + `?1`; a `location.href`
     navigation from a `setTimeout` `document/navigate/same-origin` and **no** `Sec-Fetch-User`;
     `bib_reload` → `none` + `?1` (+ `max-age=0` under probe (b)); guest `navigator.language`
     equals the host's first language and `navigator.platform` is `Linux x86_64`. Firefox subset:
     the same wire assertions (this is where "DNR can set sec-fetch on Firefox" gets verified —
     if it cannot, Firefox keeps its accidental `same-origin` and the note records it).
   - `npm test`, `npm run test:tier2`, `test:tier2:firefox`.
6. **Real-site check** — github.com/<owner>/<repo>/issues renders the issue list on Chrome;
   google.com/search still gives results (the UA A/B from experiment-log 2026-09-10, re-run).
7. **Notes** — networking.md § Design "request fidelity" bullet + the implementation-notes
   paragraph (DNR-carried set, base strips, same-URL residual, cache-header outcome, languages);
   extension-platform.md forbidden-headers bullet; security.md § Sandbox→host sinks unchanged (no
   new sink); engine-build.md § Divergences (platform override); engine.md/engine-internals.md
   wherever `bib_load_url`/`loadResource` are described (client-load flag, `Sec-Fetch-User`);
   testing.md scenario list; experiment-log.md dated entry with the before/after wire table and
   the probe result; README status line. Delete this plan.

## Not in scope

`Accept-Encoding` (host's `gzip, deflate, br, zstd`; Safari has no zstd — harmless), HTTP
version and TLS fingerprint (host's; unfixable in an extension and the UA says WebKit, not
Safari-on-Mac, so JA3 mismatches are expected), client hints (stripped; a Safari UA never
sends them — correct), `Sec-Fetch-User` on subframe navigations (WebCore's flag is main-frame
only; Chrome's `?1` on iframe loads is rare and unscored).
