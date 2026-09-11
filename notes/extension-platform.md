# Extension platform capabilities & constraints

Verified 2026-08 (Chrome) and 2026-09-09 (Firefox 155, `scripts/probe-firefox.mjs`). Bottom line:
**the whole design is buildable as a pure extension** — no browser or OS modification — and runs
from **one source tree on both browsers**; the divergence budget is manifest generation
(scripts/lib/manifest.mjs) plus three feature-detected API differences listed under § Firefox.

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

### Firefox (same DNR path, verified 2026-09-09)
- DNR `main_frame` redirect with our exact rule shapes (catch-all, per-entry redirect, allow at
  priority 10, tab-scoped session allow, `updateEnabledRulesets`) works on Firefox 155 and hands
  the viewer the **raw** target after `url=` (query + fragment intact). Two traps: a *relative*
  `regexSubstitution` is accepted and silently never redirects; `redirect.extensionPath` cannot
  carry `\0`.
- The moz-extension **UUID is per profile**, so no static ruleset could ever name the viewer.
  That was the original reason the catch-all is a **dynamic rule** here; since 2026-09-09 Chrome
  does the same (a pinned id blocks store distribution), so both browsers now run the identical
  rule set. Dynamic rules persist per profile, and the sweep covers the first navigation exactly
  as for Chrome's startup race. Tests pin the UUID via the `extensions.webextensions.uuids` pref.
- No extension service workers: `background.page` (ext/background.html) loads the same
  `sw.mjs` as an event page. `chrome.*` is promise-returning; `storage.session`, `tabs`, `action`,
  `alarms` all present; `clients`/`self.registration` are not (sw.mjs uses neither).
- `initiatorDomains` must be the UUID hostname (`new URL(chrome.runtime.getURL('/')).hostname`,
  which is what the bridge already uses); the gecko id is rejected as "Invalid domain".
- webRequest from an extension page: `onHeadersReceived` with `['responseHeaders']` shows
  Set-Cookie including HttpOnly (no `'extraHeaders'` — Firefox rejects the string; Chrome needs
  it); `details.initiator` is undefined, `originUrl` names the page; **`onBeforeRedirect` never
  fires for a server 3xx under `redirect:'error'`**, so that 3xx is taken from
  `onHeadersReceived`. Three more shapes, all found on real sites the day after the port landed
  (redirect-capture.mjs feature-detects every one; networking.md § redirect capture):
  - **repeated headers arrive as one value joined with `\n`** — google.com's 8 `Set-Cookie`
    lines came as a single string. The engine refuses any header value with a newline
    ("Response contained invalid HTTP headers"), so the capture splits per line.
  - **an HSTS upgrade is `onBeforeRedirect` with `statusCode: 0`, and the same request then
    carries on to the https target inside the same fetch**, `redirect:'error'` notwithstanding
    (Chrome: a 307 "Internal Redirect" and the fetch rejects). Dynamic HSTS (from a
    `Strict-Transport-Security` seen earlier in the profile) does this; the built-in preload
    list did **not** upgrade extension fetches in a fresh profile (`http://wikipedia.org/` and
    `http://github.com/` went out plain). The bridge reports the hop as a 307 and drops the
    continuation.
  - **a DNR `redirect` rule on an xmlhttprequest bridge fetch fires no event at all** (only
    `onErrorOccurred NS_BINDING_ABORTED`), so it is a bare network failure. Accepted: none of
    our rules redirect anything but `main_frame`; only a foreign extension's rule could.
- Manifest: `key`, COOP/COEP keys only draw "unexpected property" warnings; dropped from the
  Firefox manifest anyway. CSP `'wasm-unsafe-eval'` allows wasm on the page and in workers.
- Blocking `webRequest.onBeforeRequest` and StreamFilter (a stay-on-origin "mode B") exist on
  Firefox but are unused: mode B was rejected (architecture.md § Hosting mode).
- Automation: Playwright cannot install Firefox extensions and unsigned xpis are refused on
  release builds, so `test/harness/firefox.mjs` drives system Firefox headless over a hand-rolled
  WebDriver BiDi client (`webExtension.install {type:'path'}` = temporary install;
  `--remote-allow-system-access` is mandatory for moz-extension pages). Fixture mapping: prefs
  `network.dns.localDomains` + `network.socket.forcePort` ("443=<port>;80=<port>" — note this
  forces **every** port-80/443 connection to the fixture ports, so the harness profile cannot
  reach the real internet; pass `profilePrefs` clearing both to browse live sites). TLS: the
  fixture CA is imported into the profile's NSS db with `certutil` (`ff.trustsFixtureCert`), on
  top of the BiDi `acceptInsecureCerts` capability — an override silences the error but Firefox
  then ignores `Strict-Transport-Security`, and mozilla::pkix refuses both a self-signed CA:TRUE
  leaf and a `*.bstest` wildcard (one label after the `*`), hence the CA+leaf pair naming every
  host (test/fixtures/hosts.mjs). BiDi `log.entryAdded` is silent for moz-extension pages
  (`page.hookConsole()` instead). Firefox does not start inside a sandboxed agent shell (no
  BiDi banner, no exit): run harness scripts unsandboxed.

## The address-bar constraint (permanent)

After a main_frame redirect, the omnibox shows `chrome-extension://…/viewer.html?...`. **No API
overrides the displayed top-level URL** — deliberate anti-phishing invariant (w3c/webextensions#610
unresolved). Consequences:
- We draw our own URL bar inside the viewer. MVP-acceptable per project decision.
- Extensions also cannot register as handlers for http/https, so DNR/webRequest redirect *is* the
  only interception mechanism, and it inherits this constraint.
- A stay-on-origin viewer (Firefox StreamFilter) would be the only path to a real URL in the
  bar; rejected for its isolation cost (architecture.md).

## Cross-origin fetch (the enabler for serverless networking)

- Chrome MV3 removed CORS-exempt fetch from **content scripts only**. **Extension pages** (viewer
  tab, SW) with `host_permissions` still bypass CORS entirely
  (chromium.org: "extension-content-script-fetches"). Same model in Firefox.
- We request `<all_urls>` host permissions. Note CheerpJ's MV3 lesson: Chrome may soften install-time
  host grants into per-site activation UX, and both browsers already let the user revoke them
  (§ Permissions).
- Forbidden headers (`User-Agent`, `Cookie`, `Referer`, `Origin`, `Sec-*`): `fetch()` can't set
  them, but **DNR `modifyHeaders`** can set/remove/append them on our own requests (the allowlist
  for append explicitly includes cookie & user-agent). Verified 2026-09-10 on both browsers: a
  session rule sets all four `sec-fetch-*` on a bridge fetch. What DNR can NOT reach: the
  `Pragma`/`Cache-Control: no-cache` that `cache:'no-store'` adds (stamped below webRequest/DNR;
  an explicit fetch-init Cache-Control replaces the latter, nothing removes the former). Host
  extension-fetch defaults: Chrome `sec-fetch-site: none`, Firefox `same-origin`, both
  `cors/empty`; neither stamps Sec-Fetch on http. Rules are scoped `initiatorDomains` = our
  extension + `resourceTypes: ['xmlhttprequest']` (+ exact urlFilter per request), so unrelated
  traffic is never rewritten (networking.md).

## SharedArrayBuffer / wasm threads — not used

Nothing in the design needs SAB anymore (2026-09-09): the engine is one thread in a dedicated
Worker, frames and bytes cross by transfer. What the platform offers, for the record:

| Context | Chrome | Firefox |
|---|---|---|
| Extension page | ✅ manifest keys `cross_origin_embedder_policy: require-corp` + `cross_origin_opener_policy: same-origin` (M93+) → `crossOriginIsolated === true` on extension pages & their workers | ❌ manifest keys ignored; moz-extension pages can't be isolated (Bugzilla **#1673477**, open) — `crossOriginIsolated === false`, `SharedArrayBuffer` undefined (verified Firefox 155) |

- Chrome's manifest keeps the COOP/COEP keys (harmless; the viewer stays cross-origin isolated,
  which is the platform's Spectre posture). Firefox's manifest drops them. Tier-1 `parity.test.mjs`
  still checks Chrome's isolation as a headless-parity property, not as a dependency.
- Non-shared `WebAssembly.Memory` grows to the full 4 GB in an extension worker on Firefox
  (probed); `importScripts` and `import()` both work in moz-extension workers.

## Limits & storage

- **Package size**: Chrome Web Store max 2 GB zip — a 50–250 MB engine ships fine. AMO accepts
  large add-ons (manual review likely).
- **Compile & cache**: `fetch()` of the packaged wasm (extension-origin URL) + 
  `WebAssembly.compileStreaming`. Cache the compiled `WebAssembly.Module` in IndexedDB (structured-
  cloneable in Chrome) and/or bytes in OPFS to skip recompiles.
- **Memory**: wasm32 → 4 GB per instance; per-tab process limits make multi-GB instances risky —
  budget ~1–2 GB target. Memory64 (Chrome 133 / Firefox 134) exists if ever needed; costs perf.
- **MV3 SW lifetime**: irrelevant to the engine (lives in the viewer tab). Interception must not
  need the SW awake — dynamic DNR rules persist across SW and browser restarts, so the SW only
  reconciles state changes.

## Permissions

Source: `scripts/lib/manifest.mjs` (both browsers, identical list); tier-0 `manifest.test.mjs`
pins the exact set, so adding one is a visible diff.

| Entry | Why |
|---|---|
| `<all_urls>` (host) | CORS-exempt bridge `fetch()` to any site; DNR redirect/modifyHeaders act only on hosts we hold; tab URL visibility for http(s) tabs |
| `declarativeNetRequestWithHostAccess` | catch-all main_frame redirect, whitelist allows, escape-hatch session rules, bridge header rules. Same API as plain `declarativeNetRequest` for hosts we hold (all of them); minus plain DNR's "Block content on any page" warning (Chrome details page, Firefox). Allow rules now also need host access — same check the redirect already needed, so no request can see one without the other |
| `webRequest` | non-blocking capture of Set-Cookie + 3xx on bridge fetches (`redirect:'error'` hides them from fetch). No `webRequestBlocking` |
| `storage` | `storage.sync` state, `storage.session` escape-grant mirror |
| `tabs` | the sweep/badge/popup read viewer tabs' own URLs. **Chrome hides own `chrome-extension://` tab URLs without it** (url/pendingUrl undefined in `tabs.query`, no `changeInfo.url` in `onUpdated`, incl. pushState); Firefox shows own `moz-extension://` URLs via host permission alone. Probed 2026-09-10, Chrome 152 / Firefox 155. Kept on both (Chrome needs it; Chrome's install prompt folds it into `<all_urls>` anyway) |

Warnings each browser shows: distribution.md § Permission warnings. Features that WOULD add
permissions: host-cookie import (`cookies`), native download shelf (`downloads` — avoidable: a
blob link on the viewer page), DOM-initiated clipboard reads (`clipboardRead`; the shipped
clipboard needs no permission on either browser — writes ride transient activation, reads the
paste event; open-questions #21). Optional/per-site host permissions would be a product change
(roadmap.md risk row).

**Host access is user-revocable after install** on both browsers (Firefox MV3 shows
`<all_urls>` as an "Optional" toggle; Chrome's "Site access" menu). Revoked, DNR redirects stop
applying and navigations go native silently — issues/host-access-revocation.md.
