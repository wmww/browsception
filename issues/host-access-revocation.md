# Revoking host access silently turns sandboxing off

Both browsers let the user withdraw `<all_urls>` after install: Firefox MV3 lists it under
about:addons → Permissions and data as an "Optional" toggle ("Access your data for all
websites", on by default); Chrome has the "Site access" menu (on click / specific sites). DNR
redirect rules only act on hosts the extension holds, so once revoked every navigation runs
natively. The extension keeps showing "active" in the popup and badge.

Verified 2026-09-10 on Firefox 155 (tabs-probe: `browser.permissions.remove({origins:
['<all_urls>']})`, then a navigation matching the redirect rule loads natively). The same happens
with plain `declarativeNetRequest`, so this predates the WithHostAccess swap. Chrome not probed
(its required host permissions can't be removed through the API; the site-access menu would
need a GUI run), but its DNR docs say redirect needs host access.

Direction: the SW checks `permissions.contains({origins: ['<all_urls>']})` at startup and on
`permissions.onRemoved`/`onAdded`; while it's missing, badge + popup say "sandboxing off: host
access revoked" with a button that calls `permissions.request` (needs a user gesture — the
popup click is one). The bridge also needs the grant (CORS-exempt fetch), so an open viewer tab
fails too. Test: Firefox tier-2 can revoke through the API; Chrome's partial grants are
harder to script.
