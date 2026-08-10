# Extension platform capabilities & constraints

Verified 2026-08. Bottom line: **the whole design is buildable as a pure extension** — no browser
or OS modification — and **Chrome MV3 is the better first target** (inverts the usual
"Firefox is friendlier" assumption): DNR redirect + manifest COOP/COEP + threads all work there.

## Navigation interception

### Chrome MV3 (primary)
- **`declarativeNetRequest` redirect of `main_frame`** to an extension page. Static/dynamic rule
  with `"resourceTypes": ["main_frame"]`, redirect via `regexFilter` + `regexSubstitution` to
  `/viewer.html?url=\0`. Fires before any target-site bytes are fetched → the target document is
  never created. This is the mechanism that upholds the core invariant.
- Which navigations get intercepted is governed by the activation/mode state (whitelist vs
  blacklist mode); the mapping of modes onto DNR rule sets is specified in ui.md.
- The viewer page must be listed in **`web_accessible_resources`** or the redirect errors out.
- regexSubstitution constraints: RE2 semantics, no backreferences, each compiled rule < 2 KB, max
  1000 regex rules per ruleset. `\0` carries the whole matched URL.
- **POST navigations**: MV3 cannot recover the POST body of an intercepted navigation
  (webRequestBlocking is gone; w3c/webextensions#610 is the open standards gap). Cross-*page* form
  posts that originate inside the nested engine are unaffected (the engine submits them through the
  fetch bridge); the losable case is a *real* top-level POST from outside our world — rare; accept.
- Do **not** use `webNavigation.onBeforeNavigate` + `tabs.update`: it races (target bytes can start
  parsing) and violates the invariant.

### Firefox (later)
- **Blocking `webRequest.onBeforeRequest`** returning `{redirectUrl}` still exists in MV3 (Mozilla
  kept it deliberately; it's how full uBlock Origin works). More ergonomic than DNR — original URL
  readable directly from `details.url`. Requires a background page/event page configured to wake
  on webRequest events.
- **StreamFilter** (`webRequest.filterResponseData`) enables hosting mode B (stay-on-origin): swallow
  the response body, substitute viewer HTML, and inject COOP/COEP via `onHeadersReceived`. Firefox
  only. See architecture.md § hosting modes.

## The address-bar constraint (permanent)

After a main_frame redirect, the omnibox shows `chrome-extension://…/viewer.html?...`. **No API
overrides the displayed top-level URL** — deliberate anti-phishing invariant (w3c/webextensions#610
unresolved). Consequences:
- We draw our own URL bar inside the viewer. MVP-acceptable per project decision.
- Extensions also cannot register as handlers for http/https, so DNR/webRequest redirect *is* the
  only interception mechanism, and it inherits this constraint.
- Mode B (Firefox StreamFilter) is the only path to a real URL in the bar.

## Cross-origin fetch (the enabler for serverless networking)

- Chrome MV3 removed CORS-exempt fetch from **content scripts only**. **Extension pages** (viewer
  tab, SW) with `host_permissions` still bypass CORS entirely
  (chromium.org: "extension-content-script-fetches"). Same model in Firefox.
- We request `<all_urls>` host permissions. Note CheerpJ's MV3 lesson: Chrome may soften install-time
  host grants into per-site activation UX; design the viewer to degrade gracefully if a host grant
  is missing (show "click to allow" instead of broken page).
- Forbidden headers (`User-Agent`, `Cookie`, `Referer`, `Origin`, `Sec-*`): `fetch()` can't set
  them, but **DNR `modifyHeaders`** can set/remove/append them on our own requests (the allowlist
  for append explicitly includes cookie & user-agent). Firefox: blocking `onBeforeSendHeaders`.
  Scope these rules tightly (e.g. `initiatorDomains` = our extension, plus a marker header the shim
  attaches and a rule strips) so we never rewrite unrelated traffic.

## SharedArrayBuffer / wasm threads

| Context | Chrome | Firefox |
|---|---|---|
| Extension page | ✅ manifest keys `cross_origin_embedder_policy: require-corp` + `cross_origin_opener_policy: same-origin` (M93+) → `crossOriginIsolated === true` on extension pages & their workers | ❌ manifest keys parsed but **ignored**; moz-extension pages can't be isolated (Bugzilla **#1673477**, open; blocked on per-extension process isolation) |
| Real https page with injected COOP/COEP headers (mode B) | untested (open question) | ✅ standard header path, fully implemented |

- Why the asymmetry: SAB requires cross-origin isolation, normally established from COOP/COEP
  *HTTP response headers*. Extension pages aren't HTTP, so they need a dedicated manifest path —
  which Chrome built and Firefox didn't. Mode B's viewer is a real https page, so Firefox's normal
  header machinery applies.
- Chrome caveats: the extension **service worker** is not fully isolated (fine — engine lives in
  the tab); COEP `require-corp` constrains cross-origin *subresources of the viewer page itself*,
  but our target-site bytes arrive as opaque fetch()+ArrayBuffer, not subresource loads, so this
  doesn't bite.
- Firefox extension-page fallback: single-threaded engine build (WebkitWasm's non-pthread branch
  shape). Real perf ceiling; acceptable for a port, not for primary.

## Limits & storage

- **Package size**: Chrome Web Store max 2 GB zip — a 50–250 MB engine ships fine. AMO accepts
  large add-ons (manual review likely).
- **Compile & cache**: `fetch()` of the packaged wasm (extension-origin URL) + 
  `WebAssembly.compileStreaming`. Cache the compiled `WebAssembly.Module` in IndexedDB (structured-
  cloneable in Chrome) and/or bytes in OPFS to skip recompiles.
- **Memory**: wasm32 → 4 GB per instance; per-tab process limits make multi-GB instances risky —
  budget ~1–2 GB target. Memory64 (Chrome 133 / Firefox 134) exists if ever needed; costs perf.
- **MV3 SW lifetime**: irrelevant to the engine (lives in the viewer tab). Keep DNR rules static so
  interception works with the SW asleep.

## Permissions manifest (draft)

```
"permissions": ["declarativeNetRequest", "storage", "downloads", "cookies"(?), "clipboardRead", "clipboardWrite"],
"host_permissions": ["<all_urls>"],
"cross_origin_embedder_policy": { "value": "require-corp" },
"cross_origin_opener_policy": { "value": "same-origin" },
"web_accessible_resources": [viewer.html + engine assets]
```
(`cookies` only if/when we implement host-jar import; default is the isolated jar.)
