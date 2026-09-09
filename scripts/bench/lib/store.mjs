// Result files live in the MAIN checkout's bench/ (gitignored) so every
// worktree shares one pool — cross-branch comparison shouldn't mean hunting
// through per-worktree directories. Results are per-machine and NEVER
// committed (notes/perf-measurement.md § Bench suite).

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mainRoot } from '../../lib/paths.mjs';

export const BENCH_DIR = join(mainRoot, 'bench');

const file = (name) => join(BENCH_DIR, `${String(name).replace(/\.json$/, '')}.json`);

export function saveRun(name, record) {
  mkdirSync(BENCH_DIR, { recursive: true });
  const path = file(name);
  writeFileSync(path, JSON.stringify(record, null, 1));
  return path;
}

export function loadRun(name) {
  const path = file(name);
  if (!existsSync(path)) throw new Error(`no saved run at ${path} — see: node scripts/bench/run.mjs --list`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function listRuns() {
  if (!existsSync(BENCH_DIR)) return [];
  return readdirSync(BENCH_DIR).filter((n) => n.endsWith('.json')).map((n) => {
    const path = join(BENCH_DIR, n);
    let rec = {};
    try { rec = JSON.parse(readFileSync(path, 'utf8')); } catch { /* keep the row */ }
    return {
      name: n.replace(/\.json$/, ''),
      mtime: statSync(path).mtime,
      savedAt: rec.savedAt ?? null,
      engine: rec.provenance?.engine?.stamp ?? null,
      target: rec.provenance?.target?.rev ?? null,
      scenarios: Object.keys(rec.scenarios ?? {}).length,
    };
  }).sort((a, b) => b.mtime - a.mtime);
}

/** Fixture identity: a changed fixture invalidates comparisons against old runs. */
export function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}
