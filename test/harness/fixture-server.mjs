// Spawn the fixture server as a child process (for tests that want to own
// its lifecycle). No-ops if one is already listening.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HTTP_PORT, HTTPS_PORT, waitForFixtureServer } from './launch.mjs';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/server.mjs');

export async function ensureFixtureServer() {
  try {
    await waitForFixtureServer(300);
    return { stop: async () => {} }; // externally managed
  } catch (e) {
    // A foreign server on our port is fatal: spawning ours would just lose the
    // bind and leave the tests asserting against someone else's oracle.
    if (e.foreign) throw e;
  }
  const child = spawn(process.execPath, [SERVER, '--https', String(HTTPS_PORT), '--http', String(HTTP_PORT)], {
    stdio: 'ignore',
  });
  await waitForFixtureServer();
  return {
    stop: async () => {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    },
  };
}
