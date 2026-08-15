# Guest JS can wedge the engine thread permanently

No JSC watchdog is wired: a guest `while(true){}` (or pathological
layout/script loop) blocks the engine pthread forever — no interrupt, no
recovery short of killing the instance. The harness heartbeat (browser.html
freeze UX, added in 1.5) detects the wedge and offers Reload, but the engine
cannot terminate the runaway script itself.

Fix direction: `JSC::Watchdog` on the VM — termination is delivered via
VMTraps checks that CLoop polls at loop edges, and the watchdog fires from
its own thread, so it should work under Emscripten pthreads. WebKit1-style
`ChromeClient::shouldInterruptJavaScript` as the policy hook (host decides
kill vs continue). Wants: an engine relink, a hostile.bstest infinite-loop
button, and a tier-2 probe once in-engine recovery exists. Post-MVP unless
the Phase-1/2 browsing sessions hit real wedges.

**Wider exposure since 2026-08-15**: the guest-wasm shim now actually runs in
the extension (it 404'd its assets there before), and `Module.bibWasm2js`
translates **synchronously on the engine thread** — a big module measured 109 s
(engine-internals.md). So a single large guest wasm module is now a routine way
to hit this, not just a hostile `while(true)`. Same fix direction; an
off-thread + cached translator (already the noted want) would remove the wasm
half of it independently of the watchdog.
