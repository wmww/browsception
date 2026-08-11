// Per-checkout port block so parallel worktrees' test runs never collide (a
// fixed port would make one worktree's harness silently talk to another
// worktree's fixture server). Deterministic from the checkout path — stable
// across runs, distinct across worktrees. Override with BS_PORT_BASE.
// Dependency-free: imported before node_modules exists (tools/wt-setup.mjs).

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

export const PORT_BASE = process.env.BS_PORT_BASE
  ? Number(process.env.BS_PORT_BASE)
  : 21000 + 16 * (createHash('sha256').update(root).digest().readUInt16BE(0) % 500);

// Lanes within the 16-port block:
//   +0/+1  tier-1/2 fixture server http/https (launch.mjs)
//   +2/+3  smoke-fixtures' own fixture server http/https, +4 its dev server
//   +5/+6  smoke-bridge / smoke-browse dev servers
//   +7     smoke-leak dev server, +8/+9 its fixture server http/https
export const HTTP_PORT = PORT_BASE;
export const HTTPS_PORT = PORT_BASE + 1;
