# One engine build, worker-hosted, on Chrome and Firefox

Status: proposed 2026-09-09. Supersedes roadmap item 6 ("single-thread build first, then
StreamFilter mode B") and open-questions #13.

## Decision

Ship **one non-pthread engine link, instantiated inside a plain dedicated Worker**, on both
browsers. No SharedArrayBuffer anywhere. Mode B (stay-on-origin) is dropped: it costs isolation
(viewer in the target origin) and only existed to get Firefox threads.

Why this is not the "perf cost" the notes assumed:

- The engine is already single-threaded in practice: guest workers run on the engine thread
  (`WorkerThreadMode::UseMainThread`), image decode is synchronous, no network thread, one GC
  mutator, `PTHREAD_POOL_SIZE=4` with one occupant. Real WebKit threads ("W-C") were never built.
- The pthread link buys exactly two things: (a) engine off the main thread via
  `PROXY_TO_PTHREAD`, (b) a shared heap for the zero-copy present and for the bridge writing
  response bytes straight into wasm memory. A plain Worker gives (a) for free; (b) is replaced
  by transferable ArrayBuffers with the **same copy count** as today (see § Data paths).
- The "heavy pages peg the host tab" warning in `tools/build-webcore.sh` describes the
  single-thread build hosted *on the page*. Worker-hosted, it does not apply.
- Firefox extension pages cannot be cross-origin isolated (Bugzilla 1673477, open), so a
  SAB-free viewer is the only design that runs unchanged there.

## Build: one tree, one shipping link

- The object tree stays compiled `-pthread` (as now). `embedder.cmake` already records that
  such a tree links either way; only the link flags differ. Split the knob: `BIB_PTHREAD`
  (compile, stays ON) vs a new link-mode option, so flipping the shipping mode is a
  minutes-long relink, never the 1.5–2 h recompile.
- Shipping link: no `-sPROXY_TO_PTHREAD`, no `-pthread` at link, `-sENVIRONMENT=worker`
  (plus web/node for the harness + runner). Keep the proxy link buildable as a second target
  for a future Chrome-only real-threads experiment; it is not staged or tested by default.
- Stamp the link mode in `.build-meta` / `bib-build-config.js`; `tools/stage-engine.mjs` refuses
  a proxy-link artifact for the extension once phase 2 lands.
- Check at link: wasm imports must not include `memory` as shared; tier-0 `engine-imports.test.mjs`
  gains that assertion.
- Audit: anything that can futex-wait on the single thread now spins forever (already true
  today for `SynchronizedFixedQueue`, engine-internals.md). Grep the patch for `Atomics`/wait
  paths reachable without a second thread; none expected.

## Viewer: worker host + main-thread link

New files: `src/ext/engine-worker.mjs` (Worker scope: creates `Module`, `importScripts`
embedder.js, owns the heap) and `src/ext/engine-link.mjs` (main thread: `EngineLink`, the
Module-shaped façade the viewer, bridge, and tests talk to). `viewer.mjs` stops touching
`Module`/`HEAPU8`.

Because the build is non-pthread, the pre-js's worker scope **is** the host scope: the pump
hooks (`bibWakeUp`/`bibArmTimer`), wasm polyfill sync-XHR, and binaryen import all already
target a worker-local Module. The page-side pump fallbacks in viewer.mjs go away.

### Marshaling table (ABI is unchanged; only who calls it)

| Direction | Today | Worker-hosted |
|---|---|---|
| Input (`bib_mouse_*`, `bib_wheel`, `bib_key`, `bib_set_focus`) | main → proxied task | `postMessage` batch per rAF; the engine-side coalescing (open wheel/move batches) still applies since calls land as tasks |
| Control (`bib_load_url`, `bib_go`, `bib_set_viewport`, `bib_set_visible`, `bib_persist_now`, `bib_stop`, `bib_reload`, `bib_tick`) | main → proxied | `postMessage` |
| `bib_query` / `bibQueryResult`, `bib_eval` (dev) | main → proxied, string result via hook | request id ↔ reply message; `__bs.probe`/readback keep their promise shape |
| `bibChrome`, `bibPersist`, `bibReady`, `bibReadbackReady` | EM_ASM on engine thread → page-scope hook via MAIN_THREAD_ASYNC_EM_ASM | worker-scope hook → `postMessage` to main (strings/bytes; readback pixels transferred) |
| `bibNetBegin/Cancel/Ack` | hook on page Module | hook in worker → message to main-thread bridge |
| `bib_net_response/data/done/fail/redirect` | bridge allocs in SAB heap, calls export | bridge posts `{id, bytes}` (transfer); worker allocs, copies, calls export |
| `bibFrame` + `_bib_present_done` | main reads snapshot in SAB | worker copies dirty band into a transferable buffer, posts it; main presents and posts the buffer back (ping-pong pool of 2) |
| abort / crash | `onAbort` on either thread | worker `onAbort` → message; `worker.onerror` as backstop; `bs.dead` semantics unchanged |

### Data paths (copy accounting)

- **Network in**: today fetch chunk → copy into SAB heap. New: fetch chunk (main) → transfer →
  copy into heap (worker). Same one copy. The bridge stays on the main thread because
  `chrome.declarativeNetRequest`/`webRequest` (per-request header rules, redirect capture) are
  not available in dedicated workers.
- **Frames out**: today engine memcpys dirty band `g_blitPixels → g_presentPixels`, main uploads
  from it. New: the same memcpy targets the transfer buffer instead; main uploads from a plain
  ArrayBuffer (blit.mjs already has the non-SAB path). Same one copy; the snapshot buffer and
  `bib_set_viewport`'s retire list become unnecessary — replace, don't stack.
- **Input**: one hop either way (Emscripten proxying is a postMessage + queue underneath).

### Bridge refactor

`src/shim/bridge.mjs` currently owns heap pointers (`allocCString`, `allocBytes`, `readCString`).
Move the pointer work into the worker: the bridge's engine interface becomes a bytes/strings
API (`netResponse(id, headersJson)`, `netData(id, Uint8Array)`, `netDone`, `netFail`,
`netRedirect`; events `onBegin(reqJson)`, `onCancel`, `onAck`). `engine-stub.mjs` implements the
same interface so tier-1 is unchanged in scope. `heap.mjs` moves to the worker side.

### Test hook & bench contract

`__bs` (probe, metrics, frames, fb, navigate, eval) keeps its shape; the bench suite's four-point
contract (perf-measurement.md) must not break. Readbacks and perf-log queries become
message round-trips.

## Firefox packaging

Divergence budget: manifest generation only. Everything else is shared.

- `tools/stage-engine.mjs` (or a small `tools/manifest.mjs`) emits `manifest.json` per target
  from one source: Firefox adds `browser_specific_settings.gecko.{id,strict_min_version}` and
  `background.scripts` (module) instead of `service_worker` — Firefox has no extension service
  workers. Chrome keeps the COOP/COEP keys (harmless); Firefox ignores them.
- Interception stays DNR: Firefox ≥113 supports static/dynamic/session rules, `regexFilter` +
  `regexSubstitution`, `main_frame` redirect to an extension page, and `modifyHeaders`. Expect
  `dnr-rules.mjs`, `bridge-rules.mjs`, and the `applyPlan()` ordering to port verbatim. The
  `chrome.*` namespace works in Firefox MV3 (promise-returning).
- `sw.mjs` runs as an event page in Firefox; audit for SW-only assumptions (`clients`,
  `self.registration`, alarms lifetime).
- Firefox-specific hazards already on record: lazy reclaim of dead wasm instances (rapid
  reloads stack ~1 GB each, engine-internals.md) — the crash/reload path must drop the worker
  (`worker.terminate()`) and its module reference explicitly before creating the next.

## Phases & gates

0. **Probes** (tier-0 style throwaway pages, results appended to open-questions.md):
   - Firefox: DNR main_frame redirect to `moz-extension://…/viewer.html?url=\0` with the real
     catch-all + dynamic rules; session `modifyHeaders` for cookie/UA on the bridge's fetches;
     `webRequest` redirect/Set-Cookie capture from an extension page; OPFS; 4 GB growable
     non-shared `WebAssembly.Memory` in a worker; WebGL2 `texSubImage2D` presenter.
   - Automation: Firefox extension install under Playwright's Firefox is not supported —
     evaluate puppeteer-core (WebDriver BiDi `webExtension.install`) vs `web-ext run` + a
     remote-debugging driver for tier-2 on Firefox.
   - Chrome: non-pthread link in a Worker boots and loads a page (dev harness first).
   Gate: every probe green or an explicit workaround written down.
1. **Engine link target**: split compile/link knobs, `-sENVIRONMENT`, stamp, stage-engine
   selection, import tripwire. Gate: both links from one tree, tier-2 still green on the proxy
   link (nothing changed for it).
2. **Worker host on Chrome**: engine-worker + EngineLink + bridge refactor + frame ping-pong.
   Gate: tier-1/tier-2 green on the plain link; bench A/B vs the proxy link within noise on
   fps and input latency (busy% may shift a few pp — record in experiment-log.md); crash
   recovery scenario green.
3. **Retire the SAB path**: delete `sabDirect`, the present snapshot/retire list, page-side pump
   fallbacks, `bs.workers` tracking (no nested workers remain); proxy link kept only as a build
   target. Gate: `git grep -i sharedarraybuffer src/` empty.
4. **Firefox**: manifest generation, event-page audit, Firefox tier-2 subset in CI (boot, navigate,
   whitelist/blacklist reconcile, native handoff, scheme gates, crash reload). Gate: the shared
   tier-2 scenarios pass on both browsers from one source tree.
5. **Notes**: rewrite extension-platform.md § Firefox and § SAB table, architecture.md § hosting
   modes (mode B removed to a one-line "rejected" entry), engine.md build shape, rendering-input.md
   blit paths, roadmap; delete this plan.

## Non-goals

- Mode B / StreamFilter / a real URL in the address bar.
- Real WebKit threads. If ever wanted, they are a Chrome-only proxy link from the same tree,
  weighed against the divergence at that time.
- Blocking `webRequest` interception on Firefox — only if a DNR probe fails.

## Open risks

- A DNR gap on Firefox (e.g. regexSubstitution limits, session-rule latency for per-request
  headers) would force a Firefox-only interception path — the one place divergence could grow.
- Frame present on the main thread is now bounded by postMessage scheduling as well as upload;
  if the large-framebuffer ceiling (issues/host-present-ceiling-large-fb.md) worsens, the answer
  is an OffscreenCanvas presenter inside the engine worker (rendering-input.md option 2), which
  this design makes easy.
- Emscripten non-pthread build with `-pthread`-compiled objects: expected fine (wasm-ld only
  rejects the reverse direction); confirm on the first link.
