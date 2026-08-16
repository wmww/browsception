# tier-1 `sweep does not revoke the "open natively" escape hatch` fails in full-suite runs

`npm test` (tier-0 + tier-1, `--test-concurrency=1`, files in order) fails at
test/tier1/sweep.test.mjs:85 with:

```
page.goto: net::ERR_ABORTED at http://127.0.0.1:<port>/ok
```

~50 ms in, i.e. the very first navigation of that test. Running the file alone
(`node --test test/tier1/sweep.test.mjs`) passes every time.

Pre-existing and intermittent: reproduced twice in a row on a clean checkout at 126cbac
(verified 2026-08-15 while landing the viewer-url work — not caused by it), then a later
full run passed 34/34. So it is a race, not a deterministic ordering bug.

Suspicion: the previous tier-1 file's browser/extension state (each file launches its
own Chromium, but they share the derived port block and the fixture server) leaves a
DNR/session-rule condition that aborts the redirect instead of following it — an
`open-natively` session allow rule from an earlier file scoped to a tab id that the new
browser reuses would do it. `viewerPrefix()`-based tests in the same file pass, so it is
specific to this test's first goto.

Next step: dump `chrome.declarativeNetRequest.getSessionRules()` + `getDynamicRules()` in
`before()` for the failing run, and check whether the abort is the redirect or the
127.0.0.1 server.
