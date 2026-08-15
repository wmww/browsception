# Percent-encoded `?url=` in viewer URLs breaks under the SW sweep

The `url=` param contract is RAW (DNR `\0` substitution is un-encoded; viewer and
`sweepAction`/`viewerTarget` in src/ext/dnr-rules.mjs both slice it un-decoded). A tab opened
with `viewer.html?url=<encodeURIComponent(target)>` gets sliced to `https%3A%2F%2F...`,
`shouldSandbox` can't match it, and the sweep does `tabs.update` with that string → resolves
relative to the extension origin → `chrome-extension://<id>/https%3A%2F%2F...` ERR_FILE_NOT_FOUND.
Found 2026-08-14 when scroll-speed-probe stopped booting after the sweep fix (6148bf9) made the
startup sweep touch such tabs.

Fixed: tools/scroll-speed-probe.mjs now passes raw. Still encoding (work by accident — no sweep
runs while their tabs exist, tier-2 configures state before opening viewers):

- test/tier2/scenarios.test.mjs `viewerURL` (encodeURIComponent)
- tools/smoke-mvp.mjs:47

Either convert all callers to raw for consistency, or make `viewerTarget` tolerate
percent-encoded absolute URLs (decode iff the slice starts `https%3A`/`http%3A`). Raw everywhere
is simpler and matches the documented contract.
