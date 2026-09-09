// Identity of the staged engine, for self-attributing test/probe output.
// A measurement log that doesn't say which engine ran can't be trusted after
// the fact — an A/B run once measured a neighbour's build (2026-08-14).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { engineRoot } from './paths.mjs';

/** One-line provenance of the engine staged at engineDir (…/src/engine). */
export function stagedEngineIdentity(engineDir) {
  try {
    const m = JSON.parse(readFileSync(join(engineDir, '.staged-meta.json'), 'utf8'));
    return `engine: ${m.stamp}${m.pinned ? ' [PINNED]' : ''} (source_hash ${m.source_hashes?.[0] ?? '?'})`;
  } catch {
    return 'engine: unknown provenance — restage with node scripts/stage-engine.mjs';
  }
}

/** The build-lock owner line if an engine build is running right now, else null.
 *  A concurrent ninja invalidates timing numbers even when the right artifact
 *  is staged. */
export function engineBuildInProgress() {
  const r = spawnSync('flock', ['-n', join(engineRoot, '.build.lock'), 'true']);
  if (r.status === 0 || r.error) return null;
  try { return readFileSync(join(engineRoot, '.build.owner'), 'utf8').trim(); }
  catch { return 'unknown owner'; }
}
