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
