# smoke-bridge's cookie-redirect case has never passed (dev server lacks the endpoint)

`tools/smoke-bridge.mjs` case 3 loads `http://127.0.0.1:$PORT/cookie-test/redirect-set`
and expects `bibredir=9` in the body. `engine/WebkitWasm/tools/dev-server.mjs` has no
`/cookie-test/*` route — it 404s, and the engine faithfully renders the 404 page, so the
probe fails:

```
FAIL cookie-redirect: probe returned: 404 (:1)
```

Not a regression: the endpoint was never in the tracked dev server (added-and-referenced
in cb41baa, but only the smoke half landed here). Verified 2026-08-13 by curling the path
directly against a running dev server.

Fix: add the two-leg endpoint to dev-server.mjs — `/cookie-test/redirect-set` responds 302
to `/cookie-test/echo` with `Set-Cookie: bibredir=9`, and `/cookie-test/echo` echoes the
received `Cookie` header. That restores what the case is meant to prove (Set-Cookie on a
302 leg is stored and re-attached on the redirected hop).

Meanwhile cookie-on-redirect IS covered for real by tier-2 (`app.bstest` COOKIE swatch +
the redirect chain) and tier-1 bridge tests, so this is a gap in the real-site smoke only.
