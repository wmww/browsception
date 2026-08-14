// Headless-Chromium launch harness (notes/testing.md § Launch recipes).
//
// Launches the system Chromium (--headless=new era: plain --headless IS new
// headless in v132+) with an unpacked extension, a disposable profile, and
// *.bstest host mapping into the local fixture server. Returns a
// playwright-core BrowserContext.
//
// TLS: fixtures use a self-signed cert; we launch with
// --ignore-certificate-errors for tier 1 (accepted per open-questions #20;
// one real-TLS test lives in tier 2).

import { chromium } from 'playwright-core';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Per-checkout ports (parallel worktrees must not share a fixture server —
// the oracle would cross-contaminate). See ports.mjs.
import { HTTP_PORT, HTTPS_PORT } from './ports.mjs';
export { HTTP_PORT, HTTPS_PORT, PORT_BASE } from './ports.mjs';

// plain-http.bstest maps to the fixture http port; everything else *.bstest to
// the https port. Order matters only if Chromium applies first-match — the
// parity test verifies both mappings actually work.
export const RESOLVER_RULES = `MAP plain-http.bstest 127.0.0.1:${HTTP_PORT}, MAP *.bstest 127.0.0.1:${HTTPS_PORT}`;

export const CHROMIUM_BIN = process.env.BS_CHROMIUM ?? '/usr/bin/chromium';

// The engine wasm is gitignored and staged per checkout (tools/stage-engine.mjs,
// run for you by tools/wt-setup.mjs). Without it every engine-backed scenario
// dies on a boot timeout with no hint — fail here instead.
export function requireStagedEngine(extensionDir) {
  if (existsSync(join(extensionDir, 'engine/embedder.wasm'))) return;
  throw new Error(
    `no engine staged at ${join(extensionDir, 'engine')} — run: node tools/wt-setup.mjs`,
  );
}

/**
 * @param {{extensionDir?: string, headless?: boolean, args?: string[],
 *   needsEngine?: boolean}} opts
 * @returns {Promise<{context: import('playwright-core').BrowserContext,
 *   userDataDir: string, close: () => Promise<void>}>}
 */
export async function launch(opts = {}) {
  const { extensionDir, headless = true, args = [], needsEngine = false } = opts;
  if (needsEngine) requireStagedEngine(extensionDir);
  const userDataDir = mkdtempSync(join(tmpdir(), 'bs-profile-'));
  const allArgs = [
    `--host-resolver-rules=${RESOLVER_RULES}`,
    '--ignore-certificate-errors',
    '--no-first-run',
    '--disable-background-networking',
    ...(extensionDir
      ? [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
      : []),
    ...args,
  ];
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROMIUM_BIN,
    headless,
    args: allArgs,
    ignoreHTTPSErrors: true,
  });
  return {
    context,
    userDataDir,
    close: async () => {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

// Compute the extension id from the "key" field of an unpacked extension's
// manifest (sha256 of the DER pubkey, first 16 bytes, nibbles mapped a-p).
export function extensionIdFromManifest(extensionDir) {
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
  if (!manifest.key) throw new Error('manifest has no "key" — id is not pinned');
  const der = Buffer.from(manifest.key, 'base64');
  const hash = createHash('sha256').update(der).digest();
  let id = '';
  for (const byte of hash.subarray(0, 16))
    id += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15));
  return id;
}

// Wait until the fixture server oracle is reachable (undici fetch ignores our
// self-signed cert only with NODE_TLS_REJECT_UNAUTHORIZED=0; use http port).
export async function waitForFixtureServer(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/__health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('fixture server not reachable — start test/fixtures/server.mjs');
}

// Oracle helpers.
export async function oracleRequests() {
  const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/__requests`);
  return r.json();
}
export async function oracleClear() {
  await fetch(`http://127.0.0.1:${HTTP_PORT}/__requests`, { method: 'DELETE' });
}
