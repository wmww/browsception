// Per-checkout port block so parallel worktrees' test runs never collide (a
// fixed port would make one worktree's harness silently talk to another
// worktree's fixture server). Deterministic from the checkout path — stable
// across runs, distinct across worktrees. Override with BS_PORT_BASE.
// Dependency-free: imported before node_modules exists (scripts/wt-setup.mjs).

import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '../..'));

// Identity of this checkout, stamped into /__health so a harness can tell its
// own fixture server from a neighbouring worktree's (port blocks are derived,
// so distinct-but-not-guaranteed: two checkouts CAN hash to the same block).
export const CHECKOUT = root;

export const PORT_BASE = process.env.BS_PORT_BASE
  ? Number(process.env.BS_PORT_BASE)
  : 21000 + 16 * (createHash('sha256').update(root).digest().readUInt16BE(0) % 500);

// Lanes within the 16-port block:
//   +0/+1  tier-1/2 fixture server http/https (launch.mjs)
//   +2/+3  smoke-fixtures' own fixture server http/https, +4 its dev server
//   +5/+6  smoke-bridge / smoke-browse dev servers
//   +7     smoke-leak dev server, +8/+9 its fixture server http/https
//   +10/+11 bench fixture server http/https (scripts/bench)
export const HTTP_PORT = PORT_BASE;
export const HTTPS_PORT = PORT_BASE + 1;
export const BENCH_HTTP_PORT = PORT_BASE + 10;
export const BENCH_HTTPS_PORT = PORT_BASE + 11;

/**
 * Poll until a fixture server answers on `port` AND it is this checkout's.
 * A foreign one means the derived port blocks collided: adopting it would
 * cross-contaminate the oracle, so fail loudly instead. The rejection carries
 * `.foreign = true` so callers can tell it from "nothing is listening yet".
 */
export async function waitForOwnFixtureServer(port = HTTP_PORT, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const health = await (await fetch(`http://127.0.0.1:${port}/__health`)).json();
      if (health.checkout === CHECKOUT) return health;
      const e = new Error(
        `fixture server on :${port} belongs to ${health.checkout ?? 'an unidentified checkout'}` +
        ` (pid ${health.pid ?? '?'}), not ${CHECKOUT}` +
        ` — derived port blocks collided; set BS_PORT_BASE in one of them`,
      );
      e.foreign = true;
      throw e;
    } catch (e) {
      if (e.foreign) throw e;
      if (Date.now() >= deadline)
        throw new Error(`fixture server not reachable on :${port} — start test/fixtures/server.mjs`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
