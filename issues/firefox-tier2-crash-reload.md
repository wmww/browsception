# Firefox tier-2: crash → reload recovery fails (`__bs is not defined`)

`npm run test:tier2:firefox` scenario "crash — engine abort -> crashed UI -> reload recovers"
fails reproducibly (2/2 runs, 2026-09-09), the other 8 pass. Also fails at `31ff875` with no
working-tree changes, so it is not fallout from the release-build work — but the Firefox subset
was reported green earlier the same day, so either it regressed or it is host-dependent.

    ✖ firefox: crash — engine abort -> crashed UI -> reload recovers (0.5 s)
      Error: evaluate: ReferenceError: __bs is not defined
        at until (test/tier2/firefox.test.mjs:61)  ← line 184, 'post-reload paint'

The crash half works (dead flag + "crashed" UI). After `location.reload()` the harness's
`waitForFunction('globalThis.__bs?.ready === true')` resolves, and the very next `evaluate` finds
no `__bs` — so the wait almost certainly matched the OLD document (BiDi realm not yet swapped)
and the probe then landed in the new one mid-boot. Suspect the harness
(`test/harness/firefox.mjs` evaluate/waitForFunction realm handling across a navigation) rather
than the viewer; Chrome's equivalent scenario passes.

First step: have `page.reload()`/`waitForFunction` pin the realm or wait for a navigation event
before polling, then re-run. Cheap to confirm — 0.5 s to failure.

Update (2026-09-09, later): passed (1.1 s) in a full `npm run test:tier2` run on the same host
— so it is flaky, not deterministic. Releases gate on tier 2 (notes/releasing.md); if it
recurs there, rerun once, then fix the harness realm handling rather than skipping it.
