// Path resolution for tools that need the MAIN checkout's engine/ tree
// (gitignored, ~12 GB — exists only there). From an ephemeral worktree the
// shared .git common dir points back at the main checkout, so engine work
// from a worktree reuses the one engine tree instead of re-cloning/rebuilding.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Root of the checkout this file lives in (worktree or main).
export const checkoutRoot = join(HERE, '../..');

function resolveMainRoot() {
  try {
    const common = execFileSync(
      'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: HERE, encoding: 'utf8' },
    ).trim();
    return dirname(common);
  } catch {
    return checkoutRoot;
  }
}

// Root of the main checkout (== checkoutRoot when not in a worktree).
export const mainRoot = resolveMainRoot();
export const engineRoot = join(mainRoot, 'engine');
