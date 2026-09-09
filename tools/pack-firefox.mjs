#!/usr/bin/env node
// Assembles the Firefox extension directory: dist/firefox/ = every file under
// src/ (hardlinked — the 100 MB engine costs nothing) except Chrome's
// manifest and static rules, plus the Firefox manifest (tools/lib/manifest.mjs).
// One source tree, two manifests; nothing else differs.
//
// Idempotent and cheap (re-links only what changed), so the Firefox harness
// runs it before every install. Also exported for that harness.

import { existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutRoot } from './lib/paths.mjs';
import { firefoxManifest } from './lib/manifest.mjs';

const SRC = join(checkoutRoot, 'src');
export const FIREFOX_DIST = join(checkoutRoot, 'dist/firefox');

// Chrome-only inputs: its manifest and the static ruleset it references.
const SKIP = new Set(['manifest.json', 'rules']);

function linkTree(from, to) {
  mkdirSync(to, { recursive: true });
  const seen = new Set();
  for (const name of readdirSync(from)) {
    if (from === SRC && SKIP.has(name)) continue;
    seen.add(name);
    const s = join(from, name);
    const d = join(to, name);
    const st = statSync(s);
    if (st.isDirectory()) {
      linkTree(s, d);
      continue;
    }
    try {
      if (statSync(d).ino === st.ino) continue; // already the same inode
    } catch {}
    rmSync(d, { force: true });
    try { linkSync(s, d); } catch { copyFileSync(s, d); }
  }
  // Drop what src/ no longer has (a renamed file must not linger).
  for (const name of readdirSync(to)) {
    if (!seen.has(name) && !(to === FIREFOX_DIST && name === 'manifest.json'))
      rmSync(join(to, name), { recursive: true, force: true });
  }
}

export function packFirefox() {
  if (!existsSync(join(SRC, 'engine/embedder.wasm')))
    throw new Error(`no engine staged at ${join(SRC, 'engine')} — run: node tools/stage-engine.mjs`);
  linkTree(SRC, FIREFOX_DIST);
  writeFileSync(join(FIREFOX_DIST, 'manifest.json'), JSON.stringify(firefoxManifest(), null, 1) + '\n');
  return FIREFOX_DIST;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`packed ${relative(checkoutRoot, packFirefox())} (Firefox manifest + hardlinks into src/)`);
}
