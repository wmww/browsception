#!/usr/bin/env node
// Benchmark driver: starts the static server, drives Chromium over raw CDP
// (node's built-in WebSocket, no deps), runs every (res x path x mode) config,
// and prints a results table plus JSON.
//
//   node bench/bench.mjs                    # spawns headless chromium itself
//   node bench/bench.mjs --connect PORT     # attach to an already-running
//                                           # chromium --remote-debugging-port=PORT
//                                           # (e.g. a windowed guibox session)
//   node bench/bench.mjs --seconds 5 --label headless

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
}
const CONNECT = argVal('connect', null);
const SECONDS = Number(argVal('seconds', 5));
const LABEL = argVal('label', CONNECT ? 'windowed' : 'headless');
const PORT = Number(argVal('port', 8940));
const CHROMIUM = argVal('chromium', '/usr/bin/chromium');

const spikeDir = dirname(dirname(fileURLToPath(import.meta.url)));

// --- minimal CDP client ----------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

async function connectBrowser(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = await r.json();
      const ws = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      return { cdp: new Cdp(ws), version: info };
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('cannot connect to chromium devtools on port ' + port);
}

// --- run one config --------------------------------------------------------

async function runConfig(cdp, sessionId, url) {
  await cdp.send('Page.navigate', { url }, sessionId);
  const expr = `(async () => {
    while (!globalThis.__benchReady) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 1000));      // warm-up
    __blitStats.reset();
    const inj = setInterval(() => __injectTestInput(3), 100);
    await new Promise(r => setTimeout(r, ${SECONDS * 1000}));
    clearInterval(inj);
    return JSON.stringify(__blitStats.snapshot());
  })()`;
  const r = await cdp.send('Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return JSON.parse(r.result.value);
}

// --- main ------------------------------------------------------------------

const server = spawn(process.execPath, [join(spikeDir, 'server.mjs'), String(PORT)],
                     { stdio: 'inherit' });
let chrome = null;
const debugPort = CONNECT ? Number(CONNECT) : 9222 + Math.floor(Math.random() * 500);

if (!CONNECT) {
  const profile = mkdtempSync(join(tmpdir(), 'blit-bench-'));
  chrome = spawn(CHROMIUM, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--window-size=1920,1200',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', () => {});
}

try {
  const { cdp, version } = await connectBrowser(debugPort);
  console.log(`# ${LABEL}: ${version.Browser} / ${version['User-Agent']}`);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  const configs = [];
  for (const res of ['1080', '1440'])
    for (const path of ['webgl2', '2d'])
      for (const mode of ['full', 'dirty'])
        configs.push({ res, path, mode, sync: false });
  // Extra: webgl2 with gl.finish() to bound GPU-side cost (full frame only).
  configs.push({ res: '1080', path: 'webgl2', mode: 'full', sync: true });
  configs.push({ res: '1440', path: 'webgl2', mode: 'full', sync: true });

  const results = [];
  for (const c of configs) {
    const url = `http://127.0.0.1:${PORT}/?res=${c.res}&path=${c.path}&mode=${c.mode}` +
                (c.sync ? '&sync=1' : '');
    const snap = await runConfig(cdp, sessionId, url);
    results.push({ config: c, snap });
    const f = (x) => x.toFixed(2).padStart(7);
    console.log(
      `${c.res}p ${c.path.padEnd(6)} ${c.mode.padEnd(5)}${c.sync ? ' sync' : '     '}` +
      ` | blit${f(snap.blit.avg)}${f(snap.blit.p95)} (p95)` +
      ` | copy${f(snap.copy.avg)} | fps ${snap.fps.toFixed(1).padStart(5)}` +
      ` | lat${f(snap.latency.avg)}${f(snap.latency.p95)} (p95)` +
      ` | sabDirect=${snap.sabDirect}`);
  }

  console.log('\nrenderer: ' + results[0].snap.renderer);
  console.log('\nJSON:\n' + JSON.stringify({
    label: LABEL,
    browser: version.Browser,
    date: new Date().toISOString(),
    results,
  }, null, 1));
  await cdp.send('Target.closeTarget', { targetId });
  cdp.ws.close(); // otherwise the open socket keeps node alive in --connect mode
} finally {
  chrome?.kill();
  server.kill();
}
