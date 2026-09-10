#!/usr/bin/env node
// Generates src/manifest.json (the Chrome manifest) from scripts/lib/manifest.mjs.
// The unpacked extension root is src/. The Firefox manifest comes from the same
// source via scripts/pack-ext.mjs. Neither manifest pins the extension id — the
// catch-all is a dynamic rule installed at runtime (src/ext/dnr-rules.mjs).

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeManifest } from './lib/manifest.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

writeFileSync(join(SRC, 'manifest.json'), JSON.stringify(chromeManifest(), null, 1) + '\n');
console.log('generated src/manifest.json');
