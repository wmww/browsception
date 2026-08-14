#!/usr/bin/env node
// Stages engine artifacts into THIS checkout's src/engine/ (gitignored) —
// Chrome needs them inside the unpacked-extension root (src/). Rerun after
// engine rebuilds. Works from worktrees: engine/ is resolved through the
// main checkout (tools/lib/paths.mjs).
//
// Source, in order:
//   --from <stamp|dir>       a specific engine/artifacts/ snapshot (pins, no checks)
//   newest snapshot whose meta.json source_hash matches THIS checkout's engine
//     sources (tools/lib/engine-src-hash.mjs) — the artifact that actually
//     corresponds to the code in this branch
//   engine/artifacts/latest  newest snapshot, with a loud warning naming what it
//                            was built from (a fresh worktree next to a
//                            dirty-main build is a legit JS-only situation)
//   build/webcore/bin        raw build output (mutable -> copied; a later
//                            relink may rewrite it in place, so never link it)
// Hardlinks look like regular files to Chrome's unpacked loader (symlinks
// don't reliably); a rebuild writes new snapshot dirs, never touching inodes
// already staged into other worktrees.

import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { checkoutRoot, engineRoot } from './lib/paths.mjs';
import { engineSrcHash } from './lib/engine-src-hash.mjs';

const OUT = join(checkoutRoot, 'src/engine');
const ARTIFACTS = join(engineRoot, 'artifacts');
const fromIdx = process.argv.indexOf('--from');
const fromArg = fromIdx >= 0 ? process.argv[fromIdx + 1] : null;
// --if-stale: exit silently when what's already staged IS the chosen source
// (same inode). Lets wt-setup re-run on every pretest and still self-heal a
// checkout left staged with a pre-rebuild artifact, without any noise.
const ifStale = process.argv.includes('--if-stale');

const readMeta = (dir) => {
  try { return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { return {}; }
};
const snapshots = () => {
  try {
    return readdirSync(ARTIFACTS)
      .filter((n) => /^\d/.test(n) && existsSync(join(ARTIFACTS, n, 'embedder.wasm')))
      .sort().reverse().map((n) => join(ARTIFACTS, n));
  } catch { return []; }
};

let src, mode, warning = null;
if (fromArg) {
  src = existsSync(join(fromArg, 'embedder.wasm')) ? fromArg : join(ARTIFACTS, fromArg);
  mode = 'link';
} else {
  const hash = engineSrcHash(checkoutRoot);
  const match = snapshots().find((d) => {
    const m = readMeta(d);
    return m.source_hash === hash || (m.also_source_hashes ?? []).includes(hash);
  });
  if (match) {
    src = match;
    mode = 'link';
  } else if (existsSync(join(ARTIFACTS, 'latest/embedder.wasm'))) {
    src = realpathSync(join(ARTIFACTS, 'latest'));
    mode = 'link';
    const m = readMeta(src);
    warning = (
      `WARNING: no engine artifact matches this checkout's engine sources (${hash}).\n` +
      `         Staging ${basename(src)}, built from ${m.checkout ?? '?'}` +
      ` (branch ${m.branch ?? '?'}, sha ${m.sha ?? '?'}${m.dirty ? '-dirty' : ''}, source_hash ${m.source_hash ?? '?'}).\n` +
      `         If this checkout changes engine/WebkitWasm, build it: bash tools/build-engine.sh`);
  } else {
    src = join(engineRoot, 'WebkitWasm/build/webcore/bin');
    mode = 'copy';
  }
}
if (!existsSync(join(src, 'embedder.wasm'))) {
  console.error(`no engine artifacts at ${src} — build with tools/build-engine.sh first`);
  process.exit(1);
}

if (ifStale && mode === 'link') {
  const same = ['embedder.js', 'embedder.wasm'].every((f) => {
    try { return statSync(join(src, f)).ino === statSync(join(OUT, f)).ino; } catch { return false; }
  });
  if (same) process.exit(0);
}
if (warning) console.warn(warning);

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
