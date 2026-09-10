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
import { HTTP_PORT, HTTPS_PORT, waitForOwnFixtureServer } from './ports.mjs';
export { HTTP_PORT, HTTPS_PORT, PORT_BASE } from './ports.mjs';

// plain-http.bstest maps to the fixture http port; everything else *.bstest to
// the https port. Order matters only if Chromium applies first-match — the
// parity test verifies both mappings actually work.
export const RESOLVER_RULES = `MAP plain-http.bstest 127.0.0.1:${HTTP_PORT}, MAP *.bstest 127.0.0.1:${HTTPS_PORT}`;

export const CHROMIUM_BIN = process.env.BS_CHROMIUM ?? '/usr/bin/chromium';

// The engine wasm is gitignored and staged per checkout (scripts/stage-engine.mjs,
// run for you by scripts/wt-setup.mjs). Without it every engine-backed scenario
// dies on a boot timeout with no hint — fail here instead. Prints which engine
// this run will attribute its results to (once per process).
import { stagedEngineIdentity, engineBuildInProgress } from '../../scripts/lib/engine-id.mjs';
let saidEngine = false;
export function requireStagedEngine(extensionDir) {
  if (!existsSync(join(extensionDir, 'engine/embedder.wasm')))
    throw new Error(
      `no engine staged at ${join(extensionDir, 'engine')} — run: node scripts/wt-setup.mjs`,
    );
  // Host-root assets the engine worker's pre-js fetches (engine-build.md
  // § Host-root asset contract). Missing ones only warn worker-side, so
  // without this the failure surfaces as one puzzling guest-realm scenario.
  const missing = ['wasm-polyfill.js', 'media-stub.js', 'vendor/binaryen/index.js']
    .filter((f) => !existsSync(join(extensionDir, f)));
  if (missing.length)
    throw new Error(
      `extension root is missing ${missing.join(', ')} — run: node scripts/stage-engine.mjs`,
    );
  if (saidEngine) return;
  saidEngine = true;
  console.log(stagedEngineIdentity(join(extensionDir, 'engine')));
  const busy = engineBuildInProgress();
  if (busy) console.warn(`WARNING: engine build running [${busy}] — timing numbers will be noisy`);
}

/**
 * @param {{extensionDir?: string, headless?: boolean, args?: string[],
 *   needsEngine?: boolean, extraResolverRules?: string}} opts
 * @returns {Promise<{context: import('playwright-core').BrowserContext,
 *   userDataDir: string, close: () => Promise<void>}>}
 */
export async function launch(opts = {}) {
  const { extensionDir, headless = true, args = [], needsEngine = false, extraResolverRules = '' } = opts;
  if (needsEngine) requireStagedEngine(extensionDir);
  const userDataDir = mkdtempSync(join(tmpdir(), 'bs-profile-'));
  const allArgs = [
    // Extra rules first: a caller's specific MAP must win if Chromium
    // first-matches (the bench server owns its own domain — scripts/bench).
    `--host-resolver-rules=${[extraResolverRules, RESOLVER_RULES].filter(Boolean).join(', ')}`,
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

/**
 * The id Chromium assigned the loaded extension, read from its service
 * worker's URL (chrome-extension://<id>/ext/sw.mjs). An unpacked extension
 * with no manifest "key" gets an id hashed from its load path, so it differs
 * per checkout/worktree and nothing may hard-code one.
 */
export async function extensionId(context) {
  const url = (
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 30000 }))
  ).url();
  const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(url)?.[1];
  if (!id) throw new Error(`not an extension service worker URL: ${url}`);
  return id;
}

// Compute the extension id from the "key" field of an unpacked extension's
// manifest (sha256 of the DER pubkey, first 16 bytes, nibbles mapped a-p).
// Only the probe extension (test/fixtures/probe-ext*) still pins a key — the
// shipping extension's id is dynamic, use extensionId() above.
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
  await waitForOwnFixtureServer(HTTP_PORT, timeoutMs);
}

// Oracle helpers.
export async function oracleRequests() {
  const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/__requests`);
  return r.json();
}
export async function oracleClear() {
  await fetch(`http://127.0.0.1:${HTTP_PORT}/__requests`, { method: 'DELETE' });
}
