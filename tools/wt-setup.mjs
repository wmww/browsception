#!/usr/bin/env node
// Idempotent, fast setup for an ephemeral worktree: the pieces a checkout
// needs that git doesn't carry. Safe anywhere, including the main checkout;
// auto-invoked by `npm test` / `npm run test:tier2` (pre-hooks). Costs
// ~nothing: node_modules is hardlink-cloned, src/engine is hardlink-staged.
// No engine build is ever triggered from here.
//
// Ports need no setup — test/harness/ports.mjs derives a per-checkout block.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkoutRoot, mainRoot } from './lib/paths.mjs';
import { HTTP_PORT, HTTPS_PORT, PORT_BASE } from '../test/harness/ports.mjs';

const quiet = process.argv.includes('--quiet');
const log = (m) => { if (!quiet) console.log(m); };
const run = (cmd, args) =>
  spawnSync(cmd, args, { cwd: checkoutRoot, stdio: quiet ? 'ignore' : 'inherit' });

const isMain = resolve(checkoutRoot) === resolve(mainRoot);

// --- node_modules: hardlink-clone from main when the lockfile matches ------
if (!existsSync(join(checkoutRoot, 'node_modules'))) {
  const mainNM = join(mainRoot, 'node_modules');
  let cloned = false;
  if (!isMain && existsSync(mainNM)) {
    const same =
      readFileSync(join(checkoutRoot, 'package-lock.json'), 'utf8') ===
      readFileSync(join(mainRoot, 'package-lock.json'), 'utf8');
    if (same) cloned = run('cp', ['-al', mainNM, join(checkoutRoot, 'node_modules')]).status === 0;
  }
  if (cloned) log('node_modules: hardlink-cloned from main checkout');
  else {
    log('node_modules: npm ci');
    if (spawnSync('npm', ['ci'], { cwd: checkoutRoot, stdio: 'inherit' }).status !== 0)
      process.exit(1);
  }
}

// --- src/engine: stage from shared artifacts (hardlinks) -------------------
// --if-stale makes this a no-op (and silent) when the right artifact is already
// staged, so running it on every pretest also re-stages a checkout whose engine
// was rebuilt since. stdio is inherited even in --quiet mode: it only speaks when
// it stages, and a source/artifact mismatch warning must not be swallowed.
{
  const r = spawnSync('node', [join(checkoutRoot, 'tools/stage-engine.mjs'), '--if-stale'],
    { cwd: checkoutRoot, stdio: 'inherit' });
  if (r.status !== 0)
    console.warn('src/engine: not staged (no engine artifacts?) — tier2/smokes unavailable, tiers 0-1 fine');
}

log(`ports: block ${PORT_BASE}-${PORT_BASE + 15} (fixtures http ${HTTP_PORT} / https ${HTTPS_PORT})`);
