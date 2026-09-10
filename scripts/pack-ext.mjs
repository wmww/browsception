#!/usr/bin/env node
// Assembles a browser's unpacked extension directory: dist/<target>/ = every
// file under src/ (hardlinked — the 100 MB engine costs nothing) minus what
// only the other browser wants, plus that browser's manifest. One source
// tree, two manifests; nothing else differs.
//
//   chrome   src/manifest.json verbatim — scripts/gen-ext.mjs owns it.
//   firefox  manifest from scripts/lib/manifest.mjs.
//
// Chrome can also be loaded unpacked straight from src/; dist/chrome/ exists
// so the release package excludes dev-only leftovers (_metadata/, which
// Chrome itself writes into an unpacked root).
//
// Idempotent and cheap (re-links only what changed), so the Firefox harness
// runs it before every install. Also exported for that harness and for
// scripts/release.mjs.
//
//   node scripts/pack-ext.mjs [chrome|firefox|all]

import { existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutRoot } from './lib/paths.mjs';
import { firefoxManifest } from './lib/manifest.mjs';

const SRC = join(checkoutRoot, 'src');
export const TARGETS = ['chrome', 'firefox'];
const distDir = (target) => join(checkoutRoot, 'dist', target);

// src-relative paths the target must not carry.
const SKIP = {
  // _metadata/ is Chrome's own unpacked-load artifact (gitignored).
  chrome: new Set(['_metadata', 'ext/background.html']),
  firefox: new Set(['_metadata', 'manifest.json']),
};

function linkTree(target, from, to, rel = '') {
  mkdirSync(to, { recursive: true });
  const seen = new Set();
  for (const name of readdirSync(from)) {
    if (SKIP[target].has(rel + name)) continue;
    seen.add(name);
    const s = join(from, name);
    const d = join(to, name);
    const st = statSync(s);
    if (st.isDirectory()) {
      linkTree(target, s, d, `${rel}${name}/`);
      continue;
    }
    try {
      if (statSync(d).ino === st.ino) continue; // already the same inode
    } catch {}
    rmSync(d, { force: true });
    try { linkSync(s, d); } catch { copyFileSync(s, d); }
  }
  // Drop what src/ no longer has (a renamed file must not linger). The
  // manifest we generate ourselves is not in src/ for this target.
  for (const name of readdirSync(to)) {
    if (!seen.has(name) && !(rel === '' && name === 'manifest.json'))
      rmSync(join(to, name), { recursive: true, force: true });
  }
}

/** Assemble dist/<target>/ from src/. @returns {string} the directory. */
export function packExt(target) {
  if (!TARGETS.includes(target)) throw new Error(`unknown target ${target} (${TARGETS.join('|')})`);
  if (!existsSync(join(SRC, 'engine/embedder.wasm')))
    throw new Error(`no engine staged at ${join(SRC, 'engine')} — run: node scripts/stage-engine.mjs`);
  if (target === 'chrome' && !existsSync(join(SRC, 'manifest.json')))
    throw new Error('src/manifest.json missing — run: node scripts/gen-ext.mjs');

  const out = distDir(target);
  linkTree(target, SRC, out);
  if (target === 'firefox')
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(firefoxManifest(), null, 1) + '\n');
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2] ?? 'all';
  for (const t of arg === 'all' ? TARGETS : [arg])
    console.log(`packed ${relative(checkoutRoot, packExt(t))} (${t} manifest + hardlinks into src/)`);
}
