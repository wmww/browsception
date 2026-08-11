#!/usr/bin/env node
// Stages engine artifacts into THIS checkout's src/engine/ (gitignored) —
// Chrome needs them inside the unpacked-extension root (src/). Rerun after
// engine rebuilds. Works from worktrees: engine/ is resolved through the
// main checkout (tools/lib/paths.mjs).
//
// Source, in order:
//   --from <stamp|dir>       a specific engine/artifacts/ snapshot
//   engine/artifacts/latest  newest snapshot (immutable -> HARDLINKED, ~0 disk)
//   build/webcore/bin        raw build output (mutable -> copied; a later
//                            relink may rewrite it in place, so never link it)
// Hardlinks look like regular files to Chrome's unpacked loader (symlinks
// don't reliably); a rebuild writes new snapshot dirs, never touching inodes
// already staged into other worktrees.

import { copyFileSync, existsSync, linkSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { checkoutRoot, engineRoot } from './lib/paths.mjs';

const OUT = join(checkoutRoot, 'src/engine');
const fromIdx = process.argv.indexOf('--from');
const fromArg = fromIdx >= 0 ? process.argv[fromIdx + 1] : null;

let src, mode;
if (fromArg) {
  src = existsSync(join(fromArg, 'embedder.wasm')) ? fromArg : join(engineRoot, 'artifacts', fromArg);
  mode = 'link';
} else if (existsSync(join(engineRoot, 'artifacts/latest/embedder.wasm'))) {
  src = realpathSync(join(engineRoot, 'artifacts/latest'));
  mode = 'link';
} else {
  src = join(engineRoot, 'WebkitWasm/build/webcore/bin');
  mode = 'copy';
}
if (!existsSync(join(src, 'embedder.wasm'))) {
  console.error(`no engine artifacts at ${src} — build with tools/build-engine.sh first`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
for (const f of ['embedder.js', 'embedder.wasm']) {
  const s = join(src, f);
  const d = join(OUT, f);
  rmSync(d, { force: true });
  if (mode === 'link') {
    try { linkSync(s, d); } catch { copyFileSync(s, d); }
  } else {
    copyFileSync(s, d);
  }
  console.log(`staged ${f} (${(statSync(d).size / 1048576).toFixed(1)} MB, ${mode} from ${basename(src)})`);
}
