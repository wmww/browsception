#!/usr/bin/env node
// Stages engine artifacts into THIS checkout's src/engine/ (gitignored) —
// Chrome needs them inside the unpacked-extension root (src/). Rerun after
// engine rebuilds. Works from worktrees: engine/ is resolved through the
// main checkout (tools/lib/paths.mjs).
//
// Modes:
//   (default)                newest snapshot whose meta.json source_hash matches
//                            THIS checkout's engine sources; falls back to the
//                            already-staged copy if it was hash-matched to these
//                            same sources (its snapshot got pruned); else stages
//                            `latest` with a loud warning; else copies raw
//                            build/webcore/bin. Clears any pin.
//   --from <stamp|dir|mine>  pin a specific snapshot ('mine' = newest built from
//                            this checkout). Warns when pinning another
//                            checkout's artifact (the A/B use case — deliberate,
//                            but named out loud). Records pinned: true, which
//                            --if-stale honours: pretest hooks will NOT silently
//                            replace a pinned engine; a plain run unpins.
//   --if-stale               exit quietly when what's staged is already the
//                            right choice (same inode) or pinned; used by
//                            wt-setup on every pretest to self-heal.
//   --list                   inventory of snapshots: identity, whether each
//                            matches this checkout, which one is staged.
//
// Every staging action prints the artifact's identity (stamp, branch, checkout,
// source_hash): an A/B run once measured a neighbour's engine because stamps
// looked alike and nothing said whose bits were staged (2026-08-14).
//
// Hardlinks look like regular files to Chrome's unpacked loader (symlinks
// don't reliably); a rebuild writes new snapshot dirs, never touching inodes
// already staged into other worktrees. Another checkout's build may prune a
// snapshot mid-stage; the whole select+stage is retried once if staging throws.

import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { checkoutRoot, engineRoot } from './lib/paths.mjs';
import { engineSrcHash } from './lib/engine-src-hash.mjs';

const OUT = join(checkoutRoot, 'src/engine');
const CONFIG = 'bib-build-config.js';
const STAGED_META = join(OUT, '.staged-meta.json');
const ARTIFACTS = join(engineRoot, 'artifacts');
const fromIdx = process.argv.indexOf('--from');
const fromArg = fromIdx >= 0 ? process.argv[fromIdx + 1] : null;
const ifStale = process.argv.includes('--if-stale');
const listMode = process.argv.includes('--list');

const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
};
const readMeta = (dir) => readJson(join(dir, 'meta.json'));
const snapshotHashes = (dir) => {
  const m = readMeta(dir);
  return [m.source_hash, ...(m.also_source_hashes ?? [])].filter(Boolean);
};
const snapshots = () => {
  try {
    return readdirSync(ARTIFACTS)
      .filter((n) => /^\d/.test(n) && existsSync(join(ARTIFACTS, n, 'embedder.wasm')))
      .sort().reverse().map((n) => join(ARTIFACTS, n));
  } catch { return []; }
};
// Pruning-exempt archive: `engine/artifacts/keep/<stamp>/` is never touched by
// build-engine.sh's retention sweep (it prunes `artifacts/2*` only), so a
// notable build stays runnable — the depth limit on retro-benchmarking is
// artifact availability, not the bench runner (notes/perf-measurement.md).
// Copy one there with:  cp -a engine/artifacts/<stamp> engine/artifacts/keep/
// and stage it with:    node tools/stage-engine.mjs --from keep/<stamp>
const KEEP = join(ARTIFACTS, 'keep');
const kept = () => {
  try {
    return readdirSync(KEEP)
      .filter((n) => existsSync(join(KEEP, n, 'embedder.wasm')))
      .sort().reverse().map((n) => join(KEEP, n));
  } catch { return []; }
};
const stagedStillMatches = (hash) => {
  const m = readJson(STAGED_META);
  return (m.source_hashes ?? []).includes(hash)
    && ['embedder.js', 'embedder.wasm', CONFIG].every((f) => existsSync(join(OUT, f)));
};
const identityLine = (src, mode) => {
  if (mode !== 'link') return `engine: raw build output from ${src} (unattributed — prefer snapshots)`;
  const m = readMeta(src);
  return `engine: ${basename(src)} — branch ${m.branch ?? '?'}, checkout ${basename(m.checkout ?? '?')},` +
    ` source_hash ${m.source_hash ?? '?'}`;
};
const isStagedFrom = (dir) => {
  try { return statSync(join(dir, 'embedder.wasm')).ino === statSync(join(OUT, 'embedder.wasm')).ino; }
  catch { return false; }
};

if (listMode) {
  const hash = engineSrcHash(checkoutRoot);
  const staged = readJson(STAGED_META);
  console.log(`this checkout: ${basename(checkoutRoot)} (source_hash ${hash})` +
    (staged.pinned ? ` — PINNED to ${staged.stamp}` : ''));
  const show = (d, prefix) => {
    const m = readMeta(d);
    const marks = [
      isStagedFrom(d) ? 'staged' : null,
      snapshotHashes(d).includes(hash) ? 'matches-this-checkout' : null,
    ].filter(Boolean).join(', ');
    console.log(`  ${prefix}${basename(d)}  branch=${m.branch ?? '?'} checkout=${basename(m.checkout ?? '?')}` +
      ` source_hash=${m.source_hash ?? '?'} webkit_patch=${(m.webkit_patch ?? '?').slice(0, 12)}` +
      (marks ? `  [${marks}]` : ''));
  };
  for (const d of snapshots()) show(d, '');
  for (const d of kept()) show(d, 'keep/');
  if (!kept().length)
    console.log(`  (no pruning-exempt archive; cp -a engine/artifacts/<stamp> ${KEEP}/ to keep one)`);
  process.exit(0);
}

function stageOnce() {
  // A pinned engine (--from) survives the pretest --if-stale re-run: an A/B
  // sweep must not have its artifact swapped back mid-experiment by npm test.
  if (ifStale && readJson(STAGED_META).pinned
      && ['embedder.js', 'embedder.wasm'].every((f) => existsSync(join(OUT, f)))) {
    console.log(`engine PINNED to ${readJson(STAGED_META).stamp} — 'node tools/stage-engine.mjs' to unpin`);
    return;
  }

  let src, mode, warning = null;
  if (fromArg) {
    if (fromArg === 'mine') {
      src = snapshots().find((d) => readMeta(d).checkout === checkoutRoot);
      if (!src) {
        console.error(`no snapshot was built from this checkout (${basename(checkoutRoot)}) — see --list`);
        process.exit(1);
      }
    } else {
      src = existsSync(join(fromArg, 'embedder.wasm')) ? fromArg : join(ARTIFACTS, fromArg);
    }
    mode = 'link';
    const m = readMeta(src);
    if (m.checkout && m.checkout !== checkoutRoot)
      console.warn(`note: pinning ${basename(m.checkout)}'s artifact` +
        ` (branch ${m.branch ?? '?'}, source_hash ${m.source_hash ?? '?'})`);
  } else {
    const hash = engineSrcHash(checkoutRoot);
    const match = snapshots().find((d) => snapshotHashes(d).includes(hash));
    if (match) {
      src = match;
      mode = 'link';
    } else if (stagedStillMatches(hash)) {
      if (!ifStale)
        console.log(`staged copy still matches these sources (snapshot ${readJson(STAGED_META).stamp ?? '?'} pruned) — keeping it`);
      return;
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
    if (same && existsSync(join(OUT, CONFIG))) {
      // backfill for checkouts staged before .staged-meta.json existed
      if (!existsSync(STAGED_META))
        writeFileSync(STAGED_META, JSON.stringify({
          stamp: basename(src), source_hashes: snapshotHashes(src),
        }, null, 2) + '\n');
      return;
    }
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

  // Threading-mode stamp: the dev harness (web/browser.html) reads it from the
  // /engine mount before picking #screen's context. Snapshots made before it was
  // snapshotted don't carry the file — meta.json records the same bit, so
  // synthesize it rather than letting the harness fall back to its default.
  {
    const d = join(OUT, CONFIG);
    rmSync(d, { force: true });
    if (existsSync(join(src, CONFIG))) {
      copyFileSync(join(src, CONFIG), d);
    } else {
      const pthread = readMeta(src).pthread;
      writeFileSync(d, `// Synthesized by tools/stage-engine.mjs from ${basename(src)}/meta.json.\n` +
        `window.BIB_PTHREAD_BUILD = ${pthread === undefined ? true : !!pthread};\n`);
    }
  }

  // Record what got staged: lets a later run keep a still-correct copy after
  // its snapshot is pruned, makes pins sticky, and lets probes/tests
  // self-attribute (mode 'copy' from mutable bin/ records no hashes).
  writeFileSync(STAGED_META, JSON.stringify({
    stamp: basename(src),
    source_hashes: mode === 'link' ? snapshotHashes(src) : [],
    ...(fromArg ? { pinned: true } : {}),
  }, null, 2) + '\n');
  console.log(identityLine(src, mode) + (fromArg ? ' [PINNED]' : ''));
}

try {
  stageOnce();
} catch (e) {
  console.warn(`staging failed (${e.message}) — snapshot pruned mid-stage? retrying once`);
  stageOnce();
}
