#!/usr/bin/env node
// Release build: a fresh clone in, installable extension packages out.
//
//   node scripts/release.mjs [chrome|firefox|all] [--skip-engine] [--no-zip]
//   npm run release            # both
//   npm run release:chrome     # dist/browsception-<version>-chrome.zip
//   npm run release:firefox    # dist/browsception-<version>-firefox.xpi
//
// Every step delegates to the script that already owns it — nothing here
// duplicates build, stage or pack logic, and each of those has its own
// "already done" fast path, so a re-run after a JS-only change costs seconds
// and never rebuilds the engine:
//
//   1. engine    scripts/build-engine.sh   no-op when a snapshot already
//                matches this checkout's engine sources (~1.5 h + ~12 GB on a
//                truly fresh clone, seconds otherwise). --skip-engine to skip
//                even that check.
//   2. deps      scripts/wt-setup.mjs      npm ci when node_modules is absent.
//   3. stage     scripts/stage-engine.mjs  hardlinks the matching artifact and
//                the host-root assets into src/. Unpins an A/B pin on purpose:
//                a release ships the engine built from these sources.
//   4. manifest  scripts/gen-ext.mjs       chrome only — src/manifest.json.
//   5. pack      scripts/pack-ext.mjs      dist/<target>/, hardlinks into src/.
//   6. zip       scripts/lib/zip.mjs       the uploadable archive.
//
// Not run here: tests. `npm test` (tiers 0-1) and `npm run test:tier2` stay
// separate — a release build is a build, not a gate.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkoutRoot } from './lib/paths.mjs';
import { packExt, TARGETS } from './pack-ext.mjs';
import { writeZip } from './lib/zip.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const targetArg = args.find((a) => !a.startsWith('--')) ?? 'all';
const targets = targetArg === 'all' ? TARGETS : [targetArg];
for (const t of targets) {
  if (!TARGETS.includes(t)) {
    console.error(`unknown target ${t} — usage: node scripts/release.mjs [${[...TARGETS, 'all'].join('|')}]` +
      ' [--skip-engine] [--no-zip]');
    process.exit(2);
  }
}
for (const f of flags) {
  if (!['--skip-engine', '--no-zip'].includes(f)) { console.error(`unknown flag ${f}`); process.exit(2); }
}

let step = 0;
const heading = (what) => console.log(`\n[${++step}] ${what}`);
const run = (cmd, cmdArgs) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: checkoutRoot, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\nrelease failed: ${cmd} ${cmdArgs.join(' ')} exited ${r.status ?? r.signal}`);
    process.exit(1);
  }
};
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

// Every file in dir, as zip entries rooted at the dir.
function entries(dir, rel = '') {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...entries(p, `${rel}${name.name}/`));
    else out.push({ name: rel + name.name, source: p });
  }
  return out;
}

if (flags.has('--skip-engine')) {
  console.log('[-] engine build skipped (--skip-engine)');
} else {
  heading('engine — scripts/build-engine.sh');
  run('bash', ['scripts/build-engine.sh']);
}

heading('deps — scripts/wt-setup.mjs');
run('node', ['scripts/wt-setup.mjs', '--quiet']);

heading('stage — scripts/stage-engine.mjs');
run('node', ['scripts/stage-engine.mjs']);

if (targets.includes('chrome')) {
  heading('manifest — scripts/gen-ext.mjs');
  run('node', ['scripts/gen-ext.mjs']);
}

for (const target of targets) {
  heading(`pack ${target} — scripts/pack-ext.mjs`);
  const dir = packExt(target);
  const files = entries(dir);
  const raw = files.reduce((n, f) => n + statSync(f.source).size, 0);
  console.log(`${relative(checkoutRoot, dir)}: ${files.length} files, ${mb(raw)}`);

  if (flags.has('--no-zip')) continue;
  const { version } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const ext = target === 'firefox' ? 'xpi' : 'zip';
  const zip = join(checkoutRoot, 'dist', `browsception-${version}-${target}.${ext}`);
  const { bytes } = await writeZip(zip, files);
  console.log(`${relative(checkoutRoot, zip)}: ${mb(bytes)}`);
}

console.log(`\nrelease build complete${flags.has('--no-zip') ? '' : ' — archives in dist/'}`);
