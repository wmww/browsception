# Plan: trim the permission surface (same capability, fewer install warnings)

## Why

`permissions: ['declarativeNetRequest', 'webRequest', 'storage', 'tabs']` +
`host_permissions: ['<all_urls>']` is what the extension needs functionally, but two entries
buy warnings without buying capability we lack:

- `declarativeNetRequest` shows Chrome's "Block content on any page you visit" install warning.
  `declarativeNetRequestWithHostAccess` grants the identical API (dynamic + session rules,
  redirect, modifyHeaders, allow) for URLs the extension has host permissions for — and we
  have `<all_urls>`, so every rule we install (catch-all redirect, whitelist allows, escape
  hatches, the bridge's header rules) acts on hosts we already hold. No warning of its own on
  Chrome; Firefox ≥ 113 supports it.
- `tabs` shows a separate "Access browser tabs" / "Read your browsing history" warning
  (Firefox lists it next to "Access your data for all websites"; Chrome folds it into the
  all-sites warning). What we use — `tabs.query/update/onUpdated/onRemoved` and `tab.url` /
  `tab.pendingUrl` for the sweep — needs `tabs` only for URL/title visibility on tabs we lack
  host permission for. `<all_urls>` covers every http(s) tab; the open question is whether a
  viewer tab's own `chrome-extension://<id>/ext/viewer.html?url=…` URL is visible without
  `tabs` (the sweep must read it to take a tab native). Unverified on either browser.

Nothing the header-fidelity or WebSocket plans need changes this list: DNR modifyHeaders on
`sec-fetch-*`, `cache-control`, the `websocket` resource type, and webRequest capture of a
101 all live under `<all_urls>` + `webRequest` + (WithHostAccess) DNR. Later features that
WOULD add permissions, for the record: host-cookie import (`cookies`), native download shelf
(`downloads` — avoidable: hand bytes to the user as a blob link on the viewer page),
clipboard read (`clipboardRead`; write needs none on extension pages).

## Steps

1. **Probe** (tier-1 style, real Chrome + `test/harness/firefox.mjs`): a throwaway manifest
   without `tabs`; from the SW/event page `tabs.query({})` with one viewer tab, one native
   http tab, one `about:blank`; record which have `url`/`pendingUrl`. Also confirm
   `tabs.onUpdated` still reports `changeInfo.url` for viewer tabs. Record the answer in
   extension-platform.md § Permissions.
2. **`scripts/lib/manifest.mjs`** — `declarativeNetRequest` → `declarativeNetRequestWithHostAccess`;
   drop `tabs` iff the probe says viewer-tab URLs stay visible on BOTH browsers (one manifest
   difference more is not worth it; if only Chrome hides them, keep `tabs` everywhere and
   note why). Regenerate (`npm run release` chain / `gen-ext`). Firefox
   `strict_min_version` stays 128 (WithHostAccess landed in 113).
3. **Tests** — tier-1 `sweep.test.mjs` and tier-2 boundary scenarios already exercise
   sweep-reads-viewer-URL; they are the regression net for dropping `tabs`. Add a tier-0
   manifest test asserting the permission list is exactly the intended set (so a future
   feature adding one is a visible diff). `npm test`, tier-2 both browsers; then load
   `dist/chrome/` and `dist/firefox/` fresh (gui-testing skill) and screenshot the install
   prompt on each — the warning text is the deliverable, record it in distribution.md.
4. **Notes** — extension-platform.md § Permissions manifest (replace the draft block with the
   real list + per-entry justification, incl. why `webRequest` stays: non-blocking capture of
   Set-Cookie/3xx, no `webRequestBlocking`); distribution.md permission-justification bullet
   (store dashboard text can quote it); security.md § Extension-specific concerns if it lists
   permissions; roadmap.md "Store review rejects broad permissions" row (unchanged risk, but
   note the trimmed warnings). Delete this plan.

## Not in scope

Optional/on-demand host permissions (`optional_host_permissions` + per-site activation) — a
product change to the sandbox-by-default posture, tracked as the roadmap's store-review risk.
