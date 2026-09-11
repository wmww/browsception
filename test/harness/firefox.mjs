// Headless system-Firefox launch harness (Firefox counterpart of launch.mjs).
//
// Dependency-free: a hand-rolled WebDriver BiDi client over Node's built-in
// WebSocket. Firefox 155 implements `webExtension.install` with
// `{type:'path'}` (temporary, unsigned OK on release), so an unpacked
// extension loads without user interaction. Playwright's Firefox build can't
// install extensions and puppeteer-core would be a new dependency.
//
// Fixture mapping: Firefox has no --host-resolver-rules. Instead
//   network.dns.localDomains = "grid.bstest,…"   (resolve to 127.0.0.1)
//   network.socket.forcePort = "443=<HTTPS>;80=<HTTP>" (rewrite dial ports)
// go into the disposable profile's user.js, and the self-signed fixture cert
// is accepted via the BiDi `acceptInsecureCerts` capability.
//
// moz-extension pages: `--remote-allow-system-access` is required to navigate
// or evaluate on them. The internal UUID is per-profile; pin it by passing
// profilePrefs {'extensions.webextensions.uuids': JSON.stringify({[geckoId]: uuid})}
// (Firefox honours a pre-seeded map) so static DNR rules can name the viewer.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HTTP_PORT, HTTPS_PORT } from './ports.mjs';

export const FIREFOX_BIN = process.env.BS_FIREFOX ?? '/usr/bin/firefox';
const FIXTURE_CERT = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/ca/bstest-ca.crt');

// Import the fixture CA into the profile's NSS db as a trust anchor. The
// BiDi session's acceptInsecureCerts only silences the cert error, and
// Firefox ignores Strict-Transport-Security on a connection that needed an
// override — so HSTS scenarios need real trust. Needs NSS's certutil (and the
// cert, which the fixture server generates on first start); false otherwise,
// and tests that depend on it skip.
function trustFixtureCert(profile) {
  if (!existsSync(FIXTURE_CERT)) return false;
  try {
    execFileSync('certutil', ['-N', '-d', `sql:${profile}`, '--empty-password'], { stdio: 'ignore' });
    execFileSync('certutil', ['-A', '-d', `sql:${profile}`, '-n', 'bstest fixture', '-t', 'C,,', '-i', FIXTURE_CERT], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export { FIXTURE_HOSTS } from '../fixtures/hosts.mjs';
import { FIXTURE_HOSTS } from '../fixtures/hosts.mjs';

export function fixturePrefs(hosts = FIXTURE_HOSTS) {
  return {
    'network.dns.localDomains': hosts.join(','),
    'network.socket.forcePort': `443=${HTTPS_PORT};80=${HTTP_PORT}`,
  };
}

const BASE_PREFS = {
  // Remote agent: BiDi only, no CDP.
  'remote.active-protocols': 1,
  'remote.log.level': 'Info',
  // Quiet profile: no first-run UI, updates, telemetry, captive-portal, etc.
  'browser.shell.checkDefaultBrowser': false,
  'browser.startup.homepage': 'about:blank',
  'browser.startup.page': 0,
  'browser.aboutwelcome.enabled': false,
  'browser.newtabpage.enabled': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'toolkit.telemetry.enabled': false,
  'app.update.enabled': false,
  'app.update.auto': false,
  'network.captive-portal-service.enabled': false,
  'network.connectivity-service.enabled': false,
  'browser.safebrowsing.enabled': false,
  'browser.safebrowsing.malware.enabled': false,
  'extensions.update.enabled': false,
  'extensions.blocklist.enabled': false,
  'extensions.getAddons.cache.enabled': false,
  // Temporary (unsigned, unpacked) add-ons install fine on release without
  // this; kept so a non-temporary xpi path would too.
  'xpinstall.signatures.required': false,
};

function userJs(prefs) {
  return Object.entries(prefs)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join('\n') + '\n';
}

// ----------------------------------------------------------------- BiDi
class Bidi {
  #ws;
  #next = 1;
  #pending = new Map();
  #handlers = [];
  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'event') {
        for (const h of this.#handlers) h(msg.method, msg.params);
        return;
      }
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.type === 'success') p.resolve(msg.result);
      else p.reject(new Error(`${msg.error}: ${msg.message}${msg.stacktrace ? `\n${msg.stacktrace}` : ''}`));
    });
  }
  send(method, params = {}) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(handler) {
    this.#handlers.push(handler);
  }
  close() {
    this.#ws.close();
  }
}

async function connect(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const ws = new WebSocket(url);
      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', rej, { once: true });
      });
      return new Bidi(ws);
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`BiDi endpoint ${url} unreachable: ${e.message}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

// Deserialize the subset of BiDi RemoteValues we produce (we always return
// JSON strings from evaluate, so this is mostly for error surfaces).
function unwrap(rv) {
  if (!rv || typeof rv !== 'object') return rv;
  switch (rv.type) {
    case 'string': case 'number': case 'boolean': return rv.value;
    case 'null': case 'undefined': return null;
    case 'array': return (rv.value ?? []).map(unwrap);
    case 'object': return Object.fromEntries((rv.value ?? []).map(([k, v]) => [unwrap(k), unwrap(v)]));
    default: return rv.value ?? `<${rv.type}>`;
  }
}

/**
 * @param {{extensionDir?: string, headless?: boolean, profilePrefs?: object,
 *   hosts?: string[]}} opts
 */
export async function launchFirefox(opts = {}) {
  const { extensionDir, headless = true, profilePrefs = {}, hosts } = opts;
  const profile = mkdtempSync(join(tmpdir(), 'bs-ffprofile-'));
  writeFileSync(join(profile, 'user.js'), userJs({ ...BASE_PREFS, ...fixturePrefs(hosts), ...profilePrefs }));
  const trustsFixtureCert = trustFixtureCert(profile);

  const args = [
    ...(headless ? ['--headless'] : []),
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    // Without this BiDi refuses to navigate/evaluate on moz-extension:// (and
    // other privileged) pages: "Navigation to … is not allowed in this context".
    '--remote-allow-system-access',
    '--profile', profile,
    '--no-remote',
    '--new-instance',
    'about:blank',
  ];
  // Firefox tests these for presence, not value: an empty MOZ_HEADLESS still
  // means headless, so unset rather than blank them.
  const env = { ...process.env };
  delete env.MOZ_HEADLESS;
  delete env.MOZ_DISABLE_CONTENT_SANDBOX;
  if (headless) env.MOZ_HEADLESS = '1';
  const proc = spawn(FIREFOX_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  const stderrLines = [];
  const stdoutLines = [];
  let wsUrl = null;
  let resolveWs;
  const wsReady = new Promise((r) => (resolveWs = r));
  const onLine = (buf) => (line) => {
    buf.push(line);
    if (buf.length > 2000) buf.shift();
    const m = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(line);
    if (m && !wsUrl) {
      wsUrl = m[1];
      resolveWs(wsUrl);
    }
  };
  for (const [stream, buf] of [[proc.stderr, stderrLines], [proc.stdout, stdoutLines]]) {
    let acc = '';
    stream.on('data', (d) => {
      acc += d;
      const parts = acc.split('\n');
      acc = parts.pop();
      parts.forEach(onLine(buf));
    });
  }
  const exited = new Promise((r) => proc.on('exit', r));
  const url = await Promise.race([
    wsReady,
    exited.then((c) => { throw new Error(`firefox exited (${c}) before BiDi came up:\n${stderrLines.join('\n')}`); }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`no BiDi banner in 30s:\n${stderrLines.join('\n')}`)), 30000)),
  ]);
  const bidi = await connect(`${url.replace(/\/$/, '')}/session`);
  const session = await bidi.send('session.new', {
    capabilities: { alwaysMatch: { acceptInsecureCerts: true, webSocketUrl: true } },
  });

  // Console + errors, per browsing context. log.entryAdded covers web pages
  // only: Firefox 155's BiDi log module (and its preload scripts) are silent
  // for moz-extension pages, so extension pages get an in-page hook instead
  // (page.hookConsole / drainConsole).
  const consoleByContext = new Map();
  const consoleAll = [];
  bidi.on((method, params) => {
    if (method !== 'log.entryAdded') return;
    const ctx = params.source?.context;
    const line = {
      level: params.level,
      type: params.type,
      text: params.text ?? (params.args ? params.args.map(unwrap).join(' ') : ''),
      method: params.method,
      ts: params.timestamp,
    };
    consoleAll.push(line);
    if (ctx) (consoleByContext.get(ctx) ?? consoleByContext.set(ctx, []).get(ctx)).push(line);
  });
  await bidi.send('session.subscribe', { events: ['log.entryAdded'] });

  let extensionId = null;
  let extensionBaseUrl = null;
  if (extensionDir) {
    const r = await bidi.send('webExtension.install', {
      extensionData: { type: 'path', path: extensionDir },
    });
    extensionId = r.extension;
    extensionBaseUrl = await discoverExtensionBase(profile, extensionId, bidi);
  }

  async function newPage() {
    const { context } = await bidi.send('browsingContext.create', { type: 'tab' });
    const lines = consoleByContext.get(context) ?? consoleByContext.set(context, []).get(context);
    const page = {
      context,
      consoleLines: lines,
      async goto(u, { wait = 'complete', timeout = 30000 } = {}) {
        return Promise.race([
          bidi.send('browsingContext.navigate', { context, url: u, wait }),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`goto ${u}: timeout`)), timeout)),
        ]);
      },
      async url() {
        const tree = await bidi.send('browsingContext.getTree', { root: context });
        return tree.contexts[0]?.url ?? null;
      },
      /**
       * Run `fn` in the page: a function (called with the JSON-cloneable
       * `arg`) or a string (evaluated as an expression); result is JSON
       * round-tripped, promises awaited.
       */
      async evaluate(fn, arg) {
        // Args and results cross as JSON strings: BiDi RemoteValue
        // (de)serialization is strict (NaN, undefined, nested objects) and we
        // only ever need JSON-cloneable data.
        const decl =
          typeof fn === 'function'
            ? `async (s) => JSON.stringify(await (${fn.toString()})(JSON.parse(s))) ?? 'null'`
            : `async () => JSON.stringify(await (${String(fn)})) ?? 'null'`;
        const r = await bidi.send('script.callFunction', {
          functionDeclaration: decl,
          arguments: [{ type: 'string', value: JSON.stringify(arg ?? null) }],
          target: { context },
          awaitPromise: true,
          resultOwnership: 'none',
        });
        if (r.type === 'exception') {
          const ex = r.exceptionDetails;
          throw new Error(`evaluate: ${ex?.text ?? JSON.stringify(unwrap(ex?.exception))}`);
        }
        const v = unwrap(r.result);
        return typeof v === 'string' ? JSON.parse(v) : v;
      },
      async waitForFunction(fnSrc, { timeout = 10000, interval = 100 } = {}) {
        const deadline = Date.now() + timeout;
        for (;;) {
          const v = await page.evaluate(fnSrc);
          if (v) return v;
          if (Date.now() > deadline) throw new Error(`waitForFunction timeout: ${fnSrc}`);
          await new Promise((r) => setTimeout(r, interval));
        }
      },
      /** Wrap console.* + error events in the page (needed on moz-extension pages). */
      async hookConsole() {
        await page.evaluate(() => {
          if (globalThis.__bsConsole) return;
          const buf = (globalThis.__bsConsole = []);
          const str = (a) => (typeof a === 'string' ? a : (JSON.stringify(a) ?? String(a)));
          for (const [m, level] of Object.entries({ log: 'info', info: 'info', debug: 'debug', warn: 'warn', error: 'error' })) {
            const orig = console[m];
            console[m] = (...args) => {
              buf.push({ level, type: 'console', text: args.map(str).join(' '), ts: Date.now() });
              return orig.apply(console, args);
            };
          }
          addEventListener('error', (e) => buf.push({ level: 'error', type: 'javascript', text: `uncaught: ${e.message}`, ts: Date.now() }));
          addEventListener('unhandledrejection', (e) =>
            buf.push({ level: 'error', type: 'javascript', text: `unhandledrejection: ${e.reason?.message ?? e.reason}`, ts: Date.now() }),
          );
        });
      },
      /** Entries recorded by hookConsole since the last drain; also appended to consoleLines. */
      async drainConsole() {
        const got = await page.evaluate(() => globalThis.__bsConsole?.splice(0) ?? []);
        lines.push(...got);
        return got;
      },
      async close() {
        await bidi.send('browsingContext.close', { context }).catch(() => {});
      },
    };
    return page;
  }

  return {
    bidi,
    session,
    proc,
    profile,
    extensionId,
    extensionBaseUrl,
    trustsFixtureCert,
    consoleLines: consoleAll,
    stderr: stderrLines,
    stdout: stdoutLines,
    newPage,
    async close() {
      try { await bidi.send('browser.close'); } catch {}
      bidi.close();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

// Internal UUID of an installed extension → "moz-extension://<uuid>/".
// Firefox stores it in extensions.webextensions.uuids (prefs.js), flushed
// asynchronously; fall back to any moz-extension tab the extension opened.
async function discoverExtensionBase(profile, id, bidi, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  const prefsPath = join(profile, 'prefs.js');
  for (;;) {
    if (existsSync(prefsPath)) {
      const m = /user_pref\("extensions\.webextensions\.uuids",\s*"((?:[^"\\]|\\.)*)"\)/.exec(
        readFileSync(prefsPath, 'utf8'),
      );
      if (m) {
        const map = JSON.parse(JSON.parse(`"${m[1]}"`));
        if (map[id]) return `moz-extension://${map[id]}/`;
      }
    }
    const tree = await bidi.send('browsingContext.getTree', {});
    for (const c of tree.contexts) {
      const mm = /^moz-extension:\/\/[^/]+\//.exec(c.url ?? '');
      if (mm) return mm[0];
    }
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Oracle helpers (same as launch.mjs; duplicated so this file stays free of
// playwright-core's import).
export async function oracleRequests() {
  return (await fetch(`http://127.0.0.1:${HTTP_PORT}/__requests`)).json();
}
export async function oracleClear() {
  await fetch(`http://127.0.0.1:${HTTP_PORT}/__requests`, { method: 'DELETE' });
}
