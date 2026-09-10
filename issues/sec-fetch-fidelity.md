# Bridge fetches carry `Sec-Fetch-Mode: cors` / `Sec-Fetch-Dest: empty` for everything

Every bridge request is an extension-page `fetch()`, so Chrome stamps it
`sec-fetch-site: none`, `sec-fetch-mode: cors`, `sec-fetch-dest: empty` — including top-level
document loads, which a real browser sends as `navigate` / `document` (+ `sec-fetch-user: ?1`),
and images/scripts/styles, which would be `no-cors` + their real destination. Bot scoring uses
this (a "document" served to a cors/empty fetch is a scraper shape); some CDNs also serve
different content by `Sec-Fetch-Dest`.

Verified 2026-09-10 (scratch probe, headless Chrome 152): a session `modifyHeaders` rule scoped
to the bridge CAN set all four `sec-fetch-*` headers on the wire — DNR does not treat them as
protected. So the fix is header plumbing only:

- main loads (`req.main`): per-request rule sets mode `navigate`, dest `document`, site `none`
  (first hop) — one rule per navigation, negligible churn;
- subresources: needs the engine to say the destination (`ResourceRequest::requester` /
  `FetchOptions::destination`) across the ABI, then site (same/cross-origin vs the frame's
  document) computed bridge-side. Mode `no-cors` for plain subresources, `cors` for
  crossorigin ones.

Firefox untested (DNR modifyHeaders on `sec-fetch-*` there is unverified).

Not urgent: the UA mismatch was the signal that actually captcha-looped Google
(experiment-log 2026-09-10); this is the remaining second-order tell.
