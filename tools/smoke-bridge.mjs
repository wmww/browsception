#!/usr/bin/env node
// 1.2b milestone check: the engine loads real sites through the host-fetch
// bridge — the engine's only transport — in the dev harness page, with redirects
// and cookies working. Usage: node tools/smoke-bridge.mjs [--headed]
//
// Not CI (touches real websites — see notes/testing.md); run manually or as
// the sparing real-site smoke at the end of an engine work session.

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { engineRoot } from './lib/paths.mjs';
import { PORT_BASE } from '../test/harness/ports.mjs';

const W = join(engineRoot, 'WebkitWasm');
const PORT = PORT_BASE + 5;
const headed = process.argv.includes('--headed');

// --- dev server (serves harness + /__bibproxy) ---------------------------
const server = spawn('node', ['tools/dev-server.mjs', 'web', '--mount', '/engine=build/webcore/bin'], {
  cwd: W,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
process.on('exit', () => server.kill());
await new Promise((resolve, reject) => {
  const t0 = Date.now();
  (async function poll() {
    try {
      await fetch(`http://127.0.0.1:${PORT}/browser.html`);
      resolve();
    } catch {
      Date.now() - t0 > 5000 ? reject(new Error('dev server did not start')) : setTimeout(poll, 100);
    }
  })();
});

const browser = await chromium.launch({ executablePath: process.env.BS_CHROMIUM ?? '/usr/bin/chromium', headless: !headed });

let failures = 0;

async function loadAndProbe(name, target, probeJs, expect, timeoutMs = 120000) {
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  try {
    await page.goto(`http://127.0.0.1:${PORT}/browser.html?url=${encodeURIComponent(target)}`);
    await page.waitForFunction(() => window.__bib && window.__bib.ready, { timeout: timeoutMs });
    // Boot page's blue div at (50,126) replaced => target painted.
    await page.waitForFunction(() => {
      const p = window.__bib.probeSync(50, 126);
      return p && !(p[0] === 0x00 && p[1] === 0x66 && p[2] === 0xcc);
    }, { polling: 250, timeout: timeoutMs });
    // Ask the guest page for proof-of-execution text via the console
    // forwarder, retrying while the site is still loading.
    let lastPayload = '(no probe response)';
    for (let tries = 0; tries < 60; tries++) {
      const marker = `SMOKE${tries}_${Math.random().toString(36).slice(2, 8)}`;
      await page.evaluate(
        ([m, js]) => window.__bib.eval(`console.log(${JSON.stringify(m)} + ':' + (${js}))`),
        [marker, probeJs],
      );
      await new Promise((r) => setTimeout(r, 1000));
      const hit = consoleLines.find((l) => l.includes(`${marker}:`));
      if (!hit) continue;
      const payload = hit.slice(hit.indexOf(`${marker}:`) + marker.length + 1);
      lastPayload = payload;
      if (expect.test(payload)) {
        console.log(`PASS ${name}: ${payload.slice(0, 120).replaceAll('\n', ' ')}`);
        return;
      }
    }
    console.log(`FAIL ${name}: probe returned: ${lastPayload.slice(0, 300)}`);
    failures++;
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    failures++;
    try {
      await page.screenshot({ path: join(W, `../logs/smoke-bridge-${name}.png`) });
    } catch {}
  } finally {
    await page.close();
  }
}

// 1. Plain page, no redirects.
await loadAndProbe('example.com', 'https://example.com/', 'document.title', /Example Domain/);

// 1b. Viewport resize (1.3): bib_set_viewport reflows the guest and the
//     harness canvas follows the pushed framebuffer size.
{
  const page = await browser.newPage();
  const lines = [];
  page.on('console', (m) => lines.push(m.text()));
  try {
    await page.goto(`http://127.0.0.1:${PORT}/browser.html?url=${encodeURIComponent('https://example.com/')}`);
    await page.waitForFunction(() => window.__bib && window.__bib.ready, { timeout: 120000 });
    await new Promise((r) => setTimeout(r, 5000));
    await page.evaluate(() => Module._bib_set_viewport(1024, 768, 1.0));
    let guest = '(none)';
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => window.__bib.eval("console.log('RSZ:' + innerWidth + 'x' + innerHeight)"));
      await new Promise((r) => setTimeout(r, 1000));
      const hit = lines.findLast?.((l) => l.includes('RSZ:')) ?? lines.filter((l) => l.includes('RSZ:')).at(-1);
      if (hit) guest = hit.slice(hit.indexOf('RSZ:') + 4).split(' ')[0];
      if (guest.startsWith('1024x768')) break;
    }
    const canvas = await page.evaluate(() => {
      const c = document.getElementById('screen');
      return `${c.width}x${c.height}`;
    });
    if (canvas === '1024x768' && guest.startsWith('1024x768')) {
      console.log(`PASS resize: canvas ${canvas}, guest ${guest}`);
    } else {
      console.log(`FAIL resize: canvas ${canvas}, guest ${guest}`);
      failures++;
    }
  } catch (e) {
    console.log(`FAIL resize: ${e.message}`);
    failures++;
  } finally {
    await page.close();
  }
}

// 2. Redirect chain (wikipedia.org -> www.wikipedia.org) + a real site.
await loadAndProbe(
  'wikipedia-redirect',
  'https://wikipedia.org/',
  "document.title + '@' + location.href",
  /[Ww]ikipedia.*@https:\/\/www\.wikipedia\.org/,
);

// 3. Cookie set on a 302 leg, re-attached on the redirected hop
//    (dev-server /cookie-test endpoints, loaded through the bridge).
await loadAndProbe(
  'cookie-redirect',
  `http://127.0.0.1:${PORT}/cookie-test/redirect-set`,
  'document.body.innerText',
  /bibredir=9/,
);

await browser.close();
server.kill();
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
