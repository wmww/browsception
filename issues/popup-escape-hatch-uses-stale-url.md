# Popup "Open natively once" escapes to the stale target URL

The popup derives the current tab's URL by parsing `?url=` out of the tab's address
(`src/ext/popup.mjs` `viewerTarget`). The viewer never syncs the tab URL to in-sandbox
navigation (no `history.replaceState` anywhere in `viewer.mjs`), so that value is the URL the
tab was *originally* redirected to, not the page the user is looking at.

Repro: sandboxed tab on `https://a.example/`, click a link inside the nested page to
`https://a.example/deep` (or to another domain), open the popup, "Open natively once" →
the tab goes native on `https://a.example/`.

Consequences beyond the wrong destination:
- The escape session rule is keyed on the *stale* host (`normalizeEntry` of that URL), so
  escaping to a page on a different domain would install an allow rule for the wrong domain.
- The popup's disposition/host row and the per-site action labels ("Trust <domain>") are
  computed from the same stale URL — a whitelist add can name the wrong domain.

Fix direction: have the viewer keep the tab URL in sync with the engine's committed URL
(`replaceState` to `viewer.html?url=<current>` on each commit) so anything reading the tab URL —
popup, SW sweep, badge — sees the truth. That also makes the SW's tab sweep evaluate the page
actually loaded rather than the entry point. Alternative (weaker): have the popup ask the SW/
viewer for the live URL, which leaves the sweep and badge still reading a stale value.

Related: the in-viewer "native" button (which used the live engine URL and so didn't have this
bug) was removed; the popup is now the only escape hatch, so this is the only path.
