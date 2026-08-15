// Who produced these numbers: engine artifact, extension under test, runner,
// machine. A measurement record without this is worthless a week later — an
// A/B once measured a neighbour's engine (tools/stage-engine.mjs header).

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus, hostname, totalmem, platform, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { engineBuildInProgress } from '../../lib/engine-id.mjs';
import { checkoutRoot } from '../../lib/paths.mjs';

const git = (cwd, args) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
  catch { return null; }
};

function repoState(dir) {
  if (!existsSync(dir)) return { root: dir, rev: null, branch: null, dirty: null };
  return {
    root: dir,
    rev: git(dir, ['rev-parse', '--short', 'HEAD']),
    branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: (git(dir, ['status', '--porcelain']) ?? '') !== '',
  };
}

/** @param {string} extDir unpacked extension dir under test (…/src) */
export function collectProvenance(extDir) {
  const meta = (() => {
    try { return JSON.parse(readFileSync(join(extDir, 'engine/.staged-meta.json'), 'utf8')); }
    catch { return { stamp: null, note: 'no .staged-meta.json — unattributed engine' }; }
  })();
  let chromium = null;
  try {
    chromium = execFileSync(process.env.BS_CHROMIUM ?? '/usr/bin/chromium', ['--version'],
      { encoding: 'utf8' }).trim();
  } catch { /* recorded as unknown */ }
  return {
    machine: {
      hostname: hostname(),
      cpu: cpus()[0]?.model ?? null,
      cores: cpus().length,
      memGB: +(totalmem() / 2 ** 30).toFixed(1),
      platform: platform(),
      node: process.version,
      chromium,
      load1: +loadavg()[0].toFixed(2),
    },
    engine: meta,
    // The extension under test may be another checkout entirely (--ext).
    target: repoState(resolve(dirname(extDir))),
    runner: repoState(checkoutRoot),
    engineBuildRunning: engineBuildInProgress(),
  };
}

/** One-line summaries printed before a run and stored with the record. */
export function provenanceLines(p) {
  const t = p.target, r = p.runner;
  return [
    `engine:  ${p.engine.stamp ?? '?'}${p.engine.pinned ? ' [PINNED]' : ''}` +
      ` (source_hash ${p.engine.source_hashes?.[0] ?? '?'})`,
    `target:  ${t.root} @ ${t.rev ?? '?'} (${t.branch ?? '?'})${t.dirty ? ' DIRTY' : ''}`,
    `runner:  ${r.root} @ ${r.rev ?? '?'} (${r.branch ?? '?'})${r.dirty ? ' DIRTY' : ''}`,
    `machine: ${p.machine.hostname} ${p.machine.cpu} x${p.machine.cores}` +
      ` load ${p.machine.load1} | ${p.machine.chromium ?? 'chromium ?'} | node ${p.machine.node}`,
  ];
}
