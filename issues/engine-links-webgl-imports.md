# Engine links emscripten's WebGL bindings although we never use them

security.md's capability accounting says the engine gets "no WebGL/WebGPU imports". As built it
does: `src/embedder/embedder.cmake` links `-sMAX_WEBGL_VERSION=2 -sFULL_ES3=1` (left over from the
Ganesh/WebGL2 present path we replaced with CPU raster), so `src/engine/embedder.js` defines
`_emscripten_webgl_create_context`, the whole `GL.*` table and the gl* entry points as live imports
of the wasm module. The viewer sets `bibGPU: false`, which only means nothing *calls* them.

Practical risk today is low (in the pthread build the engine thread is only handed an
OffscreenCanvas in GPU mode, so a context creation from the worker should fail with no canvas), but
"an owned engine cannot reach the GPU driver" is currently an argument about reachability rather
than about the import list, which is what security.md claims to enforce.

Fix: drop `-sMAX_WEBGL_VERSION`/`-sFULL_ES3` (and any remaining Ganesh/GPU-present code path) from
the link, confirm `embedder.js` no longer contains GL entry points, and re-check the
`OFFSCREENCANVAS_SUPPORT` / `--wrap=pthread_create` transfer logic that exists only for GPU mode.
Also drops binary size. If we ever want the shim's own blit-only WebGL, that lives in viewer JS,
not in the module's imports.

Found 2026-08-14 while checking build flags during the JS-speed work (experiment-log.md).
