// Tier 0: the staged engine module's import/link shape.
//
// 1. No GPU entry point. notes/security.md claims the nested engine "cannot
//    reach the GPU driver". That is only true if the wasm module has no
//    GL/WebGL/WebGPU import — not merely if nothing calls one (a compromised
//    engine calls what it likes). Emscripten's JS glue is where those imports
//    are defined, so scanning it is scanning the import list. If this fails:
//    something linked Skia's Ganesh GL backend or Emscripten's GL/EGL library
//    back in — engine-build.md § No-GPU link contract.
// 2. No shared memory. The extension hosts the PLAIN link in a dedicated
//    Worker (src/ext/engine-worker.js): no SharedArrayBuffer, no pthread
//    runtime, no proxying. A proxy-link artifact (-pthread at link) would
//    boot nothing — the worker host doesn't speak its protocol — and only
//    Chrome could even instantiate it (Firefox extension pages are never
//    cross-origin isolated). The glue mentions SharedArrayBuffer iff the
//    memory is shared (notes/engine.md § build shape).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const glue = fileURLToPath(new URL('../../src/engine/embedder.js', import.meta.url));
const meta = fileURLToPath(new URL('../../src/engine/.staged-meta.json', import.meta.url));
const skip = existsSync(glue) ? false : 'no staged engine';

// Substrings that only an emscripten GL/EGL/WebGPU library brings in
// (the glue is minified, so these survive as identifiers/strings).
const BANNED = ['webgl', 'webgpu', 'glctx', 'offscreencanvas', 'navigator.gpu', '_emscripten_gl', '_egl'];

test('engine glue imports no GL/WebGL/WebGPU entry point', { skip }, () => {
  const src = readFileSync(glue, 'utf8').toLowerCase();
  const found = BANNED.filter((needle) => src.includes(needle));
  assert.deepEqual(found, [], `GPU entry points are back in the engine's imports: ${found.join(', ')}`);
});

test('engine glue is the plain link: no shared memory, no pthread runtime', { skip }, () => {
  const src = readFileSync(glue, 'utf8');
  for (const needle of ['SharedArrayBuffer', 'ENVIRONMENT_IS_PTHREAD', 'PROXY_TO_PTHREAD', 'PThread.init'])
    assert.ok(!src.includes(needle), `proxy-link artifact staged (glue mentions ${needle}) — bash tools/build-engine.sh, then node tools/stage-engine.mjs`);
  if (existsSync(meta)) {
    const m = JSON.parse(readFileSync(meta, 'utf8'));
    assert.notEqual(m.link, 'proxy', `staged meta says link=proxy (${m.stamp})`);
  }
});
