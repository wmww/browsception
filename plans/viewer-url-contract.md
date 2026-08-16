# Viewer `?url=` contract + scheme gates

Replaces issues/encoded-viewer-url-breaks-sweep.md and
issues/verify-viewer-url-scheme-allowlist.md. One plan because they share a root: the
`?url=` target is parsed in several places with slightly different rules, and every
consumer of the parsed target is also a place a non-http(s) URL could leak into a
privileged sink. Fix = one codec, then explicit http(s) gates at each sink, then tests.

## Problems

1. **Encoding inconsistency.** The `url=` contract is RAW (DNR `\0` is un-encoded).
   viewer.mjs `rawUrlParam()` already *tolerates* percent-encoded absolute URLs
   (decodes iff the slice starts `https?%3A`), but `viewerTarget()` in
   src/ext/dnr-rules.mjs — used by the SW sweep, badge, and popup — does not. A viewer
   tab opened with an encoded target (tests do this; so can old bookmarks or anything
   else, tab URLs are not under our control) survives boot but is destroyed by the next
   sweep: `shouldSandbox` can't parse `https%3A%2F%2F…`, so the sweep "takes it native"
   via `tabs.update` with that string, which resolves against the extension origin →
   `chrome-extension://<id>/https%3A%2F%2F…` → ERR_FILE_NOT_FOUND.
   (tools/scroll-speed-probe.mjs was already converted to raw; smoke-mvp no longer
   builds viewer URLs; test/tier2/scenarios.test.mjs `viewerURL` still encodes.)

2. **CONFIRMED scheme hole — native handoff.** src/shim/bridge.mjs consults
   `navigationPolicy` *before* the guard (bridge.mjs:163 vs the `evaluateRequest` call
   below it). Engine main-frame loads route through the bridge for every non-data/blob
   scheme (EmbedderStrategies.cpp `scheduleLoad` — curl is gone, `file:` is NOT served
   from MEMFS anymore, it becomes a `bibNetBegin` request). So a sandboxed page that
   navigates top-level to `file:///etc/passwd` (link, JS, or a 302 hop — the engine
   re-issues redirect hops as fresh requests) produces `main:1, url=file:…` →
   viewer.mjs `navigationPolicy` → `shouldSandbox` is false for any non-http(s) URL →
   `'native'` → `onNativeNavigation` → **`location.replace('file:///etc/passwd')` on
   the real tab**. Chromium blocks that navigation unless the user enabled "Allow
   access to file URLs" for the extension, but with it enabled this is a full sandbox
   escape to local file content; without it it's still a guest-triggered viewer-tab
   kill. Same shape for any other non-http(s) scheme the host might act on.

3. **Unverified entry points** (fork-era sweep found `javascript:`/`file:`/`data:`
   reaching the engine). Current state, per code read 2026-08-15:
   - `viewer.html?url=` → `normalizeEngineURL` gates http(s) before `bib_load_url` ✔
   - URL bar / popstate / retry → `bs.navigate` → `normalizeEngineURL` ✔
   - bridge fetches (subresources, redirect hops) → guard.mjs scheme allowlist ✔
   - sweep native branch → `tabs.update(target)` — UNGATED (any parse-failure or
     non-http target is "not sandboxable" and goes native; today that's also how the
     encoding bug bites)
   - bridge native handoff — UNGATED (problem 2)
   - popup `inspectTab` → `new URL('javascript:alert(1)')` parses fine (host ''), so a
     hostile viewer-shaped tab reads as "sandboxed" with an empty host; the
     open-natively path is safe (sw.mjs re-gates http(s)) but the disposition/actions
     UI runs on garbage.
   All ✔ items get regression tests; all UNGATED items get gates.

## Design

### One codec module: `src/ext/viewer-url.mjs`

The `?url=` wire format gets a single owner, imported by viewer.mjs, dnr-rules.mjs,
popup.mjs (sw.mjs keeps importing `viewerTarget` from dnr-rules, which delegates —
or imports directly; either, just no duplicate parsing logic anywhere).

```js
// Everything from the first [?&]url= to end-of-string is the target — RAW by
// contract (DNR \0 is un-encoded; target may contain its own ?&#).
// Tolerated legacy/manual form: percent-encoded ABSOLUTE http(s) URL, detected
// by the slice starting https%3A / http%3A (case-insensitive). Decode failures
// fall back to the raw slice.
export function sliceTarget(urlOrSearch)      // → raw-or-decoded target string, or null
export function viewerTarget(url, viewerBase) // startsWith(`${viewerBase}?`) gate + sliceTarget
export function viewerURLFor(viewerBase, target, params = '') // canonical RAW builder
export function isHttpUrl(url)                // new URL ok && protocol http(s)
```

Decisions and why:

- **Tolerate-encoded (decode-iff-`https?%3A`), not raw-only.** The issue offered
  "convert all callers to raw" as the simpler option, but viewer.mjs already grew the
  decode path, and the sweep's input is any tab URL in the browser — our callers being
  raw doesn't make encoded tabs impossible, and the failure mode (sweep 404s the tab)
  is destructive. The detection is unambiguous: a raw absolute target always starts
  literally `http`, an encoded one always starts `https%3A`/`http%3A`, and nothing
  http(s)-valid starts with the other form. Everything else passes through raw and
  dies later at a scheme gate, which is fine.
- **Slice at `[?&]url=`** (regex), not `indexOf('url=')` — same behavior for all real
  inputs, but immune to a future viewer param that embeds `url=` (e.g. `?favurl=`).
  Keep the "viewer params must precede url=" rule as-is.
- **Fragment handling stays a viewer concern.** For full tab URLs (sweep/popup) the
  slice already includes `#…`. In the viewer, `location.search` excludes the hash, so
  `rawUrlParam()` keeps gluing `location.hash` onto the *raw* form only (an encoded
  target's fragment is inside the decoded string; a decoded target never legitimately
  has our own hash appended — current behavior, keep it).
- **Canonicalize on rewrite.** `sweepAction`'s sandbox op and viewer `tabURLFor` both
  emit via `viewerURLFor` (raw). A legacy encoded tab that the sweep re-dispositions,
  or that the tab-history mirror touches, comes out raw. No migration step needed.

### Scheme gates at every privileged sink

The rule: **a URL may only cross from sandbox-world to host-world if `isHttpUrl` says
so.** Sandbox-world = anything derived from guest content or a `?url=` param.
Host-world sinks = `tabs.update`, `location.replace`, `bib_load_url` is the reverse
direction (host→engine) and already gated by `normalizeEngineURL`.

1. **bridge.mjs (the confirmed hole):** the native-handoff branch runs only for
   http(s) main requests:
   ```js
   if (req.main && isHttpUrl(req.url) && this.navigationPolicy?.(req.url) === 'native') { … }
   ```
   A non-http(s) main load then falls through to `evaluateRequest` → guard denial
   (`scheme:file` etc.) → `NET_ERR.GUARD` → the viewer's loadfailed strip. Exactly the
   UX we want: "couldn't load file:///… — blocked by the sandbox guard", tab intact.
   bridge.mjs must not import from src/ext (it's shim-layer); give guard.mjs or
   bridge.mjs its own two-line http(s) check rather than importing viewer-url.mjs, OR
   export `isHttpUrl` from a shim-visible spot — pick whichever keeps the layering
   (shim must stay extension-API-free); duplicating a one-liner is acceptable, note it
   on both sides.
2. **dnr-rules.mjs `sweepAction`:** the native branch requires an http(s) target:
   ```js
   if (target !== null) {
     if (shouldSandbox(state, target)) return null;          // correctly sandboxed
     return isHttpUrl(target) ? { op: 'native', url: target } : null; // garbage: leave it
   }
   ```
   "Leave it" is right: the tab is on our own viewer page, which already shows
   "blocked: only http(s) URLs" for such targets; navigating it anywhere with a
   non-http string is how the original bug 404'd tabs. (With the codec fix, encoded
   http targets no longer reach this branch — this gate is for genuinely non-http
   targets.)
3. **popup.mjs `inspectTab`:** a viewer tab whose target isn't `isHttpUrl` →
   disposition `'other'`, no host, no actions. (open-natively in sw.mjs already
   re-validates http(s) server-side — keep that, defense in depth.)
4. **Badge (sw.mjs `updateBadge`):** unchanged — "is a viewer tab" is the right
   question for the badge, target validity irrelevant.

### What is deliberately NOT gated

- `data:`/`blob:` **inside** the engine (subresources, iframes, engine-internal
  `loader.start()` path): guest-authored content rendering in guest context is not a
  boundary crossing. Only their appearance at a host-world sink matters (covered
  above).
- `javascript:` links inside the guest: executed by the engine in guest context —
  same privilege as the page's own script. The gates ensure it can never reach
  `location.replace`/`tabs.update`/`bib_load_url`.

## Changes, file by file

- `src/ext/viewer-url.mjs` (new): codec above + unit-testable pure functions.
- `src/ext/dnr-rules.mjs`: delete local `viewerTarget`; re-export from viewer-url.mjs
  (sw.mjs/popup.mjs imports keep working) or update importers; `sweepAction` uses the
  codec + native-branch gate; sandbox op builds via `viewerURLFor`. Update the `\0`
  contract comments to point at viewer-url.mjs as the owner.
- `src/ext/viewer.mjs`: `rawUrlParam` → `sliceTarget(location.search)` + existing
  hash-glue; `viewerParams`/`tabURLFor` → `viewerURLFor` (or keep `viewerParams` local
  and pass it in as `params`); no behavior change intended here beyond sharing code.
  `normalizeEngineURL` stays as-is (its scheme-less `https://` prepend is a URL-bar
  nicety and it's already strict about the final scheme).
- `src/shim/bridge.mjs`: http(s) precondition on the native-handoff branch (item 1).
- `src/ext/popup.mjs`: `inspectTab` gate (item 3).
- `test/tier2/scenarios.test.mjs`: `viewerURL` helper switches to RAW (canonical form
  gets the coverage); add tests below.
- `notes/security.md`: add the sink-gate rule and the entry-point table row for the
  native handoff; note the fork-era file:/MEMFS finding is structurally closed by the
  curl-less port (file: routes through the bridge) — with the test as the proof.
- `notes/README.md`: refresh the open-issues line (both issues deleted).

## Tests

Tier-0 (`test/tier0/`, new `viewer-url.test.mjs` + extend `dnr-rules.test.mjs`):
- `sliceTarget`: raw absolute; raw with own query/fragment (`?url=https://a/?x=1&y=2`
  → whole tail); encoded absolute (decodes); encoded with encoded query; malformed
  `%` (falls back raw); `javascript:`/`file:` raw (passes through, no decode); no
  `url=` (null); `url=` mid-target not re-sliced; `[?&]` boundary (a `favurl=` param
  is not `url=`).
- `viewerTarget`: wrong base → null; encoded target → decoded (the sweep-bug case).
- `sweepAction`: viewer tab with ENCODED sandboxed target → null (regression: was
  `{op:'native', url:'https%3A…'}`); encoded now-native target → native with DECODED
  url; `?url=javascript:alert(1)` / unparseable target → null; unchanged raw cases.
- `isHttpUrl`: http/https true; file/js/data/chrome-extension/garbage false.

Tier-2 (`scenarios.test.mjs`) — extend the hostile invariants scenario (or a sibling
`hostile: scheme gates` test; the blocked-viewer boots don't need the engine, so
they're cheap):
- **Param gate:** boot `viewer.html?url=` with `javascript:alert(1)`,
  `file:///etc/passwd`, `data:text/html,x`, `javascript%3Aalert(1)` → boot strip shows
  "blocked: only http(s) URLs", no engine boot, tab stays extension-origin.
- **Encoded positive:** boot `viewer.html?url=<encodeURIComponent('https://grid.bstest/')>`
  → engine boots and renders grid (probe one pixel); then flip a state bit to force a
  sweep and assert the tab survives on the extension origin with the same target
  (regression for the original ERR_FILE_NOT_FOUND).
- **URL bar gate:** on a booted viewer, set urlbar value to `javascript:alert(1)` +
  Enter via CDP → `bs.navigate` false, `bs.state.url` unchanged.
- **Native-handoff gate (the bridge hole):** add to `hostile.html` a
  `#filelink` click driven from the test (link exists already) and a fixture route
  `/redir-file` → 302 `Location: file:///etc/passwd` (test/fixtures/server.mjs).
  Navigate the guest to each top-level; assert: loadfailed strip mentions the guard,
  `page.url()` still extension-origin, no CDP target/frame ever leaves
  chrome-extension:/opaque origins (reuse the existing Target.setDiscoverTargets
  harness from scenario 11), `bs.state.url` still the hostile page. Also assert the
  existing guest-side `file`/`ftp` fetch rows stay `blocked` (already covered, keep).

## Order of work

1. Bridge gate (problem 2) — smallest diff, closes the live hole, independently
   shippable.
2. viewer-url.mjs codec + consumer migration + sweep/popup gates.
3. Tier-0 tests alongside 2; tier-2 hostile additions + fixture route.
4. Notes updates; delete stale comments that claim the contract lives in three places.
