// sha256 over a checkout's ENGINE BUILD INPUTS: engine/WebkitWasm/src/**
// (embedder TUs, headers, embedder.cmake, engine-pre.js, the WebKit patch).
//
// Equal hash => the two checkouts would produce the same embedder.{js,wasm},
// so a snapshot built from one is valid in the other. build-engine.sh uses it
// for its "already built" fast path and stamps it into meta.json;
// stage-engine.mjs uses it to pick the snapshot that matches this checkout.
//
// Not inputs (deliberately): third_party/ (pinned + the patch above covers our
// edits), tools/ (build scripts don't change the artifact), web/ (browser.html
// & co are harness host-page files, loaded at runtime, not linked).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutRoot } from './paths.mjs';

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** @param {string} root checkout root (defaults to this file's checkout) */
export function engineSrcHash(root = checkoutRoot) {
  const w = join(root, 'engine/WebkitWasm');
  const files = walk(join(w, 'src'));
  const h = createHash('sha256');
  for (const f of files) {
    h.update(relative(w, f).split(sep).join('/'));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

// CLI: node tools/lib/engine-src-hash.mjs [checkout-root]  -> prints the hash
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  console.log(engineSrcHash(process.argv[2] || checkoutRoot));
