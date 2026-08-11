# Engine-side load failures still leave the viewer on the boot page

The bridge now reports every TOP-LEVEL request it fails (`onMainLoadFailed` → viewer error strip
with a retry, `showLoadError` in viewer.mjs), which covers DNS/TLS/network errors, guard denials,
the size cap and idle timeouts. Failures the bridge never sees do not surface: anything WebCore
itself refuses after (or without) a successful fetch — unsupported top-level MIME types,
engine-internal aborts, a hop the engine declines to follow. The engine logs
`BIB: load failed kind=%d` (`EmbedderStrategies.cpp`) and stays on the committed document, so a
first navigation that dies that way still shows "booting…" forever.

Fix: add a `bibChrome` "loadfailed" kind (`{url, kind, message}`) at that log site, ABI-document it,
and route it into the same `showLoadError`. Engine C++ + rebuild — see notes/worktrees.md.
Wants a tier-2 scenario for one such failure.
