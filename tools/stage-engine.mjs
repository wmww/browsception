#!/usr/bin/env node
// Stages the engine build into the extension tree (src/engine/, gitignored).
// The unpacked-extension root is src/; Chrome needs the artifacts inside it.
// Rerun after every engine rebuild. Copies (not symlinks): Chrome's unpacked
// loader follows symlinks inconsistently across platforms.

import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '../engine/WebkitWasm/build/webcore/bin');
const OUT = join(HERE, '../src/engine');

mkdirSync(OUT, { recursive: true });
for (const f of ['embedder.js', 'embedder.wasm']) {
  copyFileSync(join(BIN, f), join(OUT, f));
  console.log(`staged ${f} (${(statSync(join(OUT, f)).size / 1048576).toFixed(1)} MB)`);
}
