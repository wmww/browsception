# Smoke tools run the MAIN checkout's dev-server + web/ harness, not the invoking one

`tools/smoke-{bridge,browse,fixtures,leak}.mjs` all do
`W = join(engineRoot, 'WebkitWasm')` and spawn `tools/dev-server.mjs web` with `cwd: W`.
`engineRoot` is the **main** checkout (paths.mjs, by design — the 12 GB build tree is a
singleton there). But that also drags in main's `tools/dev-server.mjs` and main's
`web/{browser.html,bib-net.js,…}`, which are tracked per-checkout.

So a worktree branch that changes the dev harness or the dev server can't be smoked from
its own worktree: the smoke silently exercises main's copies. Hit while fixing the
cookie-redirect case (2026-08-13) — the fix had to be validated with a hand-patched copy
of the smoke pointed at the worktree's `engine/WebkitWasm`.

This contradicts "a coupled engine+JS change is one branch, testable in place"
(notes/worktrees.md) — `tools/build-engine.sh` already compiles the *invoking* checkout's
sources (incl. `web/engine-pre.js`).

Fix: serve the invoking checkout's `engine/WebkitWasm` (dev-server + `web/`) and mount only
the build output from `engineRoot`:
`spawn('node', [<checkout>/engine/WebkitWasm/tools/dev-server.mjs, <checkout>/engine/WebkitWasm/web,
'--mount', '/engine=' + join(engineRoot,'WebkitWasm/build/webcore/bin')])`.
Verified working that way. Worth a shared helper since four smoke tools repeat the spawn.
