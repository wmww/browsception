// Tier 0: the engine module must import no GPU entry point.
//
// notes/security.md claims the nested engine "cannot reach the GPU driver".
// That is only true if the wasm module has no GL/WebGL/WebGPU import — not
// merely if nothing calls one (a compromised engine calls what it likes).
// Emscripten's JS glue is where those imports are defined, so scanning it
// is scanning the import list.
//
// If this fails: something linked Skia's Ganesh GL backend or Emscripten's
// GL/EGL library back in — see issues history and engine-build.md
// § No-GPU link contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const glue = fileURLToPath(new URL('../../src/engine/embedder.js', import.meta.url));

// Substrings that only an emscripten GL/EGL/WebGPU library brings in
// (the glue is minified, so these survive as identifiers/strings).
const BANNED = ['webgl', 'webgpu', 'glctx', 'offscreencanvas', 'navigator.gpu', '_emscripten_gl', '_egl'];

test('engine glue imports no GL/WebGL/WebGPU entry point', { skip: existsSync(glue) ? false : 'no staged engine' }, () => {
  const src = readFileSync(glue, 'utf8').toLowerCase();
  const found = BANNED.filter((needle) => src.includes(needle));
  assert.deepEqual(found, [], `GPU entry points are back in the engine's imports: ${found.join(', ')}`);
});
