# Plan: Firefox harness — a real `page.reload()` for the crash-recovery scenario

Small, test-only. Fixes the flaky `firefox: crash — engine abort -> crashed UI -> reload
recovers` scenario (3 fails in ~6 firefox-only runs, 0 in full tier-2 runs, always
`ReferenceError: __bs is not defined` 0.5 s in). Releases gate on tier 2, so a flake here
costs a rerun every time it bites.

## Why it flakes

`test/tier2/firefox.test.mjs` reloads with `page.evaluate(() => location.reload())` and then
polls `globalThis.__bs?.ready === true`. `location.reload()` is asynchronous, so the first
poll can land in the OLD document (still ready → the wait resolves immediately); the next
`evaluate` then runs in the new document before `viewer.mjs` has installed `__bs`. Nothing
pins the harness to the new realm. Chrome's twin scenario uses Playwright's `page.reload()`,
which resolves after the new document's load event — that is the difference.

## Change

- `test/harness/firefox.mjs` `newPage()`: add
  `reload({ wait = 'complete', timeout = 30000 } = {})` →
  `bidi.send('browsingContext.reload', { context, wait })` raced against the timeout, like
  `goto`. `wait: 'complete'` returns after the new document's load event, so every later
  `evaluate` targets the new realm.
- `firefox.test.mjs` crash scenario: replace the `location.reload()` evaluate with
  `await page.reload()`. Keep the `__bs.ready` wait after it (boot is asynchronous past load).
- Optional hardening: the same race exists for any future scenario that navigates from inside
  the page (`__bs.eval("location.href = …")` already relies on `pollUntil` over `page.url()`,
  which is realm-independent, so those are fine today). Don't touch them.

## Verify

`npm run test:tier2:firefox` five times in a row (the failing shape), then one full
`npm run test:tier2`. Then delete this plan; note the realm rule in testing.md (Firefox
harness section): a navigation triggered from page script must be followed by a
navigation-aware wait, never by an `evaluate` poll.
