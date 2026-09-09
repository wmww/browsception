#!/usr/bin/env node
// Phase-1 exit-gate runner: browse the four target sites in the dev harness
// with real mouse+keyboard input for >= 10 minutes total, without a crash or
// wedge. REAL SITES — manual/agent smoke only (notes/testing.md), never CI,
// run sparingly. Usage: node scripts/smoke-browse.mjs [--headed] [--minutes N]
//
// Input targeting is DOM-informed but event-real: element coordinates come
// from guest getBoundingClientRect via __bib.eval, and the interaction is
// then injected as host mouse/keyboard events on the canvas (the same
// capture -> bib_* -> EventHandler path a human exercises).

import { chromium } from 'playwright-core';

import { startDevServer, waitForServers } from './lib/dev-harness.mjs';
import { PORT_BASE } from '../test/harness/ports.mjs';

const PORT = PORT_BASE + 6;
const headed = process.argv.includes('--headed');
const minutesArg = process.argv.indexOf('--minutes');
const MINUTES = minutesArg >= 0 ? Number(process.argv[minutesArg + 1]) : 10;

const server = startDevServer({ port: PORT });
await waitForServers([`http://127.0.0.1:${PORT}/browser.html`], server);

const browser = await chromium.launch({
  executablePath: process.env.BS_CHROMIUM ?? '/usr/bin/chromium',
  headless: !headed,
});
const page = await browser.newPage();
const consoleLines = [];
page.on('console', (m) => consoleLines.push(m.text()));

const t0 = Date.now();
const elapsed = () => (Date.now() - t0) / 1000;
const log = (s) => console.log(`[${elapsed().toFixed(0).padStart(4)}s] ${s}`);
let failures = 0;
const fail = (s) => {
  console.log(`FAIL ${s}`);
  failures++;
};

await page.goto(`http://127.0.0.1:${PORT}/browser.html`);
await page.waitForFunction(() => window.__bib && window.__bib.ready, { timeout: 120000 });
const box = await (await page.$('#screen')).boundingBox();
const at = (x, y) => [box.x + x, box.y + y];

const dead = () => page.evaluate(() => window.__bib.dead);

// Guest-JS answer via the console forwarder.
async function ask(js, tries = 30) {
  for (let t = 0; t < tries; t++) {
    if (await dead()) throw new Error('engine died');
    const marker = `BRW${t}_${Math.random().toString(36).slice(2, 8)}`;
    await page.evaluate(
      ([m, code]) =>
        window.__bib.eval(
          `try { console.log(${JSON.stringify(m)} + ':' + (${code})) } catch (e) { console.log(${JSON.stringify(m)} + ':ERR:' + e) }`,
        ),
      [marker, js],
    );
    await new Promise((r) => setTimeout(r, 1000));
    const hit = consoleLines.find((l) => l.includes(`${marker}:`));
    if (hit) return hit.slice(hit.indexOf(`${marker}:`) + marker.length + 1).replace(/ \(:\d+\)\s*$/, '');
  }
  throw new Error(`no answer: ${js.slice(0, 80)}`);
}

async function navigate(url, readyProbe, timeoutMs = 180000) {
  log(`navigate: ${url}`);
  await page.evaluate((target) => Module.ccall('bib_load_url', null, ['string'], [target]), url);
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    if (await dead()) throw new Error('engine died during load');
    try {
      const answer = await ask(readyProbe, 1);
      if (answer && !answer.startsWith('ERR:') && answer !== 'false') {
        log(`loaded: ${answer.slice(0, 90).replaceAll('\n', ' ')}`);
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`load timed out: ${url}`);
}

// Click a guest element: rect via eval, host mouse through the canvas.
// Elements above the fold only (the harness viewport is 800x600).
async function clickEl(selector) {
  const rect = await ask(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});` +
      ` if (!el) return 'none'; el.scrollIntoView({block:'center'});` +
      ` const r = el.getBoundingClientRect();` +
      ` return Math.round(r.x + r.width/2) + ',' + Math.round(r.y + r.height/2); })()`,
  );
  if (rect === 'none') throw new Error(`no element ${selector}`);
  const [x, y] = rect.split(',').map(Number);
  if (x < 0 || y < 0 || x >= 800 || y >= 600) throw new Error(`${selector} off-viewport @${rect}`);
  log(`click ${selector} @${rect}`);
  await page.mouse.click(...at(x, y));
}

async function typeText(text) {
  log(`type "${text}"`);
  await page.keyboard.type(text, { delay: 200 });
}

async function scrollAround(rounds = 4) {
  await page.mouse.move(...at(400, 300));
  for (let i = 0; i < rounds; i++) {
    await page.mouse.wheel(0, 600);
    await new Promise((r) => setTimeout(r, 1500));
  }
  for (let i = 0; i < rounds; i++) {
    await page.mouse.wheel(0, -600);
    await new Promise((r) => setTimeout(r, 800));
  }
}

// --- Site 1: Wikipedia — load, search by typing, follow the result --------
try {
  await navigate('https://www.wikipedia.org/', "document.title.includes('Wikipedia') && document.readyState");
  await scrollAround(2);
  await clickEl('#searchInput');
  await typeText('WebKit');
  await page.keyboard.press('Enter');
  // Poll until the search actually lands (form submit + redirect can take
  // a while) — ask() itself returns the first answer, not a matching one.
  let where = '';
  for (let i = 0; i < 30 && !/[Ww]ebKit/.test(where); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    where = await ask("location.href + ' | ' + document.title", 5);
  }
  log(`after search: ${where.slice(0, 100)}`);
  if (!/[Ww]ebKit/.test(where)) fail(`wikipedia search did not land: ${where.slice(0, 120)}`);
  await scrollAround(3);
  await clickEl('#bodyContent a[href^="/wiki/"]');
  await new Promise((r) => setTimeout(r, 5000));
  log(`followed link: ${(await ask('document.title')).slice(0, 80)}`);
} catch (e) {
  fail(`wikipedia: ${e.message}`);
}

// --- Site 2: Hacker News — front page, open comments, back ----------------
try {
  await navigate('https://news.ycombinator.com/', "document.title + '|' + document.querySelectorAll('.athing').length");
  await scrollAround(2);
  await clickEl('.athing:nth-of-type(1) ~ tr .subline a[href^="item"]');
  await new Promise((r) => setTimeout(r, 4000));
  const title = await ask('document.title', 60);
  log(`comments page: ${title.slice(0, 80)}`);
  await scrollAround(3);
  // history.back() from guest JS (bib_go is unimplemented until 2.3's
  // navigation chrome). Informational — traversal isn't gated here.
  await ask("(history.back(), 'back-requested')", 10).catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));
  log(`back to: ${(await ask('location.href', 60)).slice(0, 80)}`);
} catch (e) {
  fail(`hackernews: ${e.message}`);
}

// --- Site 3: MDN — article, in-page nav ------------------------------------
try {
  await navigate(
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
    "document.title.includes('JavaScript') && document.readyState === 'complete'",
  );
  await scrollAround(4);
  await clickEl('main a[href*="/docs/Web/JavaScript/"]');
  await new Promise((r) => setTimeout(r, 5000));
  log(`mdn link: ${(await ask('document.title', 60)).slice(0, 80)}`);
  await scrollAround(2);
} catch (e) {
  fail(`mdn: ${e.message}`);
}

// --- Site 4: TodoMVC (JS SPA) — add/complete todos by typing+clicking ------
try {
  await navigate(
    'https://todomvc.com/examples/javascript-es6/dist/',
    "!!document.querySelector('.new-todo') && document.readyState",
  );
  await clickEl('.new-todo');
  await typeText('nested browsing');
  await page.keyboard.press('Enter');
  await typeText('ship the mvp');
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 2000));
  const count = await ask("document.querySelectorAll('.todo-list li').length", 30);
  if (!/2/.test(count)) fail(`todomvc: expected 2 todos, got ${count}`);
  else log('todomvc: 2 todos added');
  await clickEl('.todo-list li:first-child .toggle');
  await new Promise((r) => setTimeout(r, 1500));
  const done = await ask("document.querySelectorAll('.todo-list li.completed').length", 30);
  if (!/1/.test(done)) fail(`todomvc: expected 1 completed, got ${done}`);
  else log('todomvc: toggle works');
} catch (e) {
  fail(`todomvc: ${e.message}`);
}

// --- Fill remaining time with mixed browsing until the gate duration ------
const FILLER = [
  ['https://en.wikipedia.org/wiki/WebAssembly', "document.title.includes('WebAssembly')"],
  ['https://news.ycombinator.com/newest', "document.title + ''"],
  ['https://en.wikipedia.org/wiki/Special:Random', 'document.readyState'],
];
let f = 0;
while (elapsed() < MINUTES * 60 && !(await dead())) {
  const [url, probe] = FILLER[f++ % FILLER.length];
  try {
    await navigate(url, probe);
    await scrollAround(3);
  } catch (e) {
    fail(`filler ${url}: ${e.message}`);
    break;
  }
}

if (await dead()) fail('engine dead at end of session');
const mins = (elapsed() / 60).toFixed(1);
console.log(
  failures
    ? `${failures} FAILURE(S) after ${mins} min`
    : `ALL PASS — ${mins} min of real-site mouse+keyboard browsing, no crash`,
);
await browser.close();
server.kill();
process.exit(failures ? 1 : 0);
