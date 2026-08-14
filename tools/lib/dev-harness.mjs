// Shared dev-harness launcher for tools/smoke-*.mjs.
//
// Everything comes from THIS checkout: the dev server, the web/ harness, and
// the engine staged into src/engine (a hardlinked snapshot whose source_hash
// matches this checkout's engine sources). Nothing is served out of the main
// checkout's live build tree — it holds whichever checkout built last, and a
// relink rewrites it in place mid-run. See notes/worktrees.md.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutRoot } from './paths.mjs';
import { stagedEngineIdentity, engineBuildInProgress } from './engine-id.mjs';

const W = join(checkoutRoot, 'engine/WebkitWasm');
const ENGINE = join(checkoutRoot, 'src/engine');

/** Spawn the dev server for this checkout. Caller awaits waitForServers(). */
export function startDevServer({ port, env = {} }) {
  // Silent no-op when what's staged is already right; warns loudly when no
  // artifact matches these engine sources — exactly what you want to see
  // before a smoke run attributes someone else's engine to your branch.
  spawnSync('node', [join(checkoutRoot, 'tools/stage-engine.mjs'), '--if-stale'], {
    cwd: checkoutRoot,
    stdio: 'inherit',
  });
  if (!existsSync(join(ENGINE, 'embedder.wasm')))
    throw new Error(`no engine staged at ${ENGINE} — run: bash tools/build-engine.sh`);
  console.log(stagedEngineIdentity(ENGINE));
  const busy = engineBuildInProgress();
  if (busy) console.warn(`WARNING: engine build running [${busy}] — timing numbers will be noisy`);

  const server = spawn(
    'node',
    [join(W, 'tools/dev-server.mjs'), join(W, 'web'), '--mount', `/engine=${ENGINE}`],
    { cwd: W, env: { ...process.env, PORT: String(port), ...env }, stdio: 'inherit' },
  );
  process.on('exit', () => server.kill());
  server.on('exit', (code) => {
    // Nothing else can be trusted after this: whatever answers on the port now
    // is some other checkout's dev server (or nothing at all).
    if (code !== null && code !== 0 && !server.killed) {
      console.error(`dev server exited (${code}) — port ${port} taken? see the message above`);
      process.exit(1);
    }
  });
  server.__port = port;
  return server;
}

/** Throw unless the dev server on `port` is the one we just started. */
async function assertOwnDevServer(port) {
  const r = await fetch(`http://127.0.0.1:${port}/__whoami`);
  // A dev server predating /__whoami answers 404 — still not ours.
  const who = r.ok ? await r.json().catch(() => ({})) : {};
  const want = join(W, 'web');
  if (who.root !== want)
    throw new Error(
      `dev server on :${port} serves ${who.root ?? 'an unidentified tree'} (pid ${who.pid ?? '?'}),` +
      ` not ${want}` +
      ` — derived port blocks collided; set BS_PORT_BASE in one of them`,
    );
}

/**
 * Poll until every url answers, then verify the dev server is `server`'s own.
 * Pass the handle from startDevServer to get the identity check.
 */
export async function waitForServers(urls, server, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    try {
      for (const u of urls) await fetch(u);
      break;
    } catch {
      if (Date.now() - t0 > timeoutMs) throw new Error(`servers did not start: ${urls.join(' ')}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (server?.__port) await assertOwnDevServer(server.__port);
}

/** Where smoke artifacts (screenshots) go — this checkout, not main's. */
export const LOGS = join(checkoutRoot, 'engine/logs');
