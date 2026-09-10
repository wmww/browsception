# Bridge fetches carry `Sec-Fetch-Mode: cors` / `Sec-Fetch-Dest: empty` for everything

Every bridge request is an extension-page `fetch()`, so Chrome stamps it
`sec-fetch-site: none`, `sec-fetch-mode: cors`, `sec-fetch-dest: empty` — including top-level
document loads, which a real browser sends as `navigate` / `document` (+ `sec-fetch-user: ?1`),
and images/scripts/styles, which would be `no-cors` + their real destination. Bot scoring uses
this (a "document" served to a cors/empty fetch is a scraper shape); some CDNs also serve
different content by `Sec-Fetch-Dest`.

**This breaks real sites on Chrome, and it is Chrome-only** (confirmed 2026-09-09):
github.com/<owner>/<repo>/issues renders GitHub's "Error — Looks like something went wrong!"
boundary under Chromium while working under Firefox. The document itself is a clean 200; the
page's `GET /_graphql?...` calls come back **422** with

    {"errors":[{"type":"INTERNAL","message":"Expected value for header `sec-fetch-site` is
     `same-origin`, but received `none`.","extensions":{"code":"invalidHeader"}}]}

The two hosts stamp extension-page fetches differently (echo-headers probe, same extension,
same target):

| | `sec-fetch-site` | `sec-fetch-mode`/`dest` |
|---|---|---|
| Chromium | `none` | `cors` / `empty` |
| Firefox | `same-origin` | `cors` / `empty` |

Firefox's expanded extension principal makes cross-origin bridge fetches read as `same-origin`,
which happens to satisfy GitHub's check; Chrome's `none` does not. So the whole class of
"same-origin-only" server checks is Chrome-broken today. A session `modifyHeaders` rule forcing
`sec-fetch-site: same-origin` on the `_graphql` requests makes the issue list render in Chromium
(200 + data) — causality confirmed, not just correlation.

Verified 2026-09-10 (scratch probe, headless Chrome 152): a session `modifyHeaders` rule scoped
to the bridge CAN set all four `sec-fetch-*` headers on the wire — DNR does not treat them as
protected. So the fix is header plumbing only:

- main loads (`req.main`): per-request rule sets mode `navigate`, dest `document`, site `none`
  (first hop) — one rule per navigation, negligible churn;
- subresources: needs the engine to say the destination (`ResourceRequest::requester` /
  `FetchOptions::destination`) across the ABI, then site (same/cross-origin vs the frame's
  document) computed bridge-side. Mode `no-cors` for plain subresources, `cors` for
  crossorigin ones.

Note the GitHub case is a *subresource* (a same-origin XHR from the page), i.e. the half that
needs the engine to send its destination + the frame's origin. Firefox needs the same rules
verified there (DNR `modifyHeaders` on `sec-fetch-*` untested on Firefox), but its accidental
`same-origin` means it is not currently broken.

Was filed as "not urgent, second-order tell" behind the UA mismatch (experiment-log 2026-09-10);
the GitHub repro promotes it to a real-site breakage.
