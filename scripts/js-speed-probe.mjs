#!/usr/bin/env node
// JS-speed probe: run the same small benchmark bodies in the nested engine
// (JSC CLoop) and in the host page (V8 with JIT), timed identically — host
// wall clock around one eval per bench, guest-reported ms printed alongside as
// a check on the guest clock. Prints native/engine/ratio.
//
// Same shape as the firefox-wasm demo probe used in experiment-log.md
// (2026-08-14), so numbers from the two are directly comparable: keep the
// bodies and the best-of-2 protocol identical if you change anything.
//
// Usage: node scripts/js-speed-probe.mjs
import { chromium } from 'playwright-core';
import { startDevServer, waitForServers } from './lib/dev-harness.mjs';
import { PORT_BASE } from '../test/harness/ports.mjs';

const PORT = PORT_BASE + 6;

const BODIES = {
  'prop-mono': `function Pt(x,y){this.x=x;this.y=y} var o=new Pt(1,2),s=0; for(var i=0;i<2000000;i++) s+=o.x+o.y; return s;`,
  'prop-poly': `var os=[{a:1,x:1},{b:1,x:2},{c:1,x:3},{d:1,x:4}],s=0; for(var i=0;i<1000000;i++) s+=os[i&3].x; return s;`,
  'call': `function addf(a,b){return a+b} var s=0; for(var i=0;i<2000000;i++) s=addf(s,1); return s;`,
  'arith-int': `var s=0; for(var i=0;i<5000000;i++) s=(s+i*3)|0; return s;`,
  'arith-float': `var s=0.5; for(var i=0;i<2000000;i++) s=s*1.000001+0.5; return s;`,
  'array-dense': `var a=[],s=0; for(var i=0;i<500000;i++) a.push(i); for(var i=0;i<a.length;i++) s+=a[i]; return s;`,
  'alloc': `function Pt(x,y){this.x=x;this.y=y} var s=0; for(var i=0;i<500000;i++){var p=new Pt(i,i+1); s+=p.x} return s;`,
  'string-scan': `var base='the quick brown fox jumps over the lazy dog 0123456789 ',str=''; for(var i=0;i<200;i++) str+=base; var s=0; for(var r=0;r<20;r++) for(var i=0;i<str.length;i++) s+=str.charCodeAt(i); return s;`,
  'string-build': `var parts=[]; for(var i=0;i<100000;i++) parts.push('k'+i+'='+(i*7)); var joined=parts.join('&'); return joined.split('&').length;`,
  'json': `var o=[]; for(var i=0;i<20000;i++) o.push({id:i,name:'n'+i,tags:['a','b'],v:i*1.5}); var s=JSON.stringify(o); return JSON.parse(s).length;`,
};

// console-reporting wrapper (the guest can only answer via console)
function wrap(name, body, reps, tag) {
  return `(function(){var f=function(){${body}};var best=1e9,chk=0;` +
    `try{for(var r=0;r<${reps};r++){var t0=Date.now();chk=f();var dt=Date.now()-t0;if(dt<best)best=dt}}` +
    `catch(e){console.log('BX|${name}|${tag}|-1|'+e);return}` +
    `console.log('BX|${name}|${tag}|'+best+'|'+chk)})()`;
}

const server = startDevServer({ port: PORT });
await waitForServers([`http://127.0.0.1:${PORT}/browser.html`], server);
const browser = await chromium.launch({
  executablePath: process.env.BS_CHROMIUM ?? '/usr/bin/chromium',
  headless: true,
});
const page = await browser.newPage();
const seen = [];
page.on('console', (m) => {
  const t = m.text();
  const i = t.indexOf('BX|');
  if (i < 0) return;
  const [name, tag, ms, chk] = t.slice(i + 3).replace(/ \(:\d+\)\s*$/, '').split('|');
  seen.push({ name, tag, ms: Number(ms), chk });
});
const waitFor = async (name, tag, timeoutMs) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = seen.find((s) => s.name === name && s.tag === tag);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${name}/${tag}`);
};

await page.goto(`http://127.0.0.1:${PORT}/browser.html`);
await page.waitForFunction(() => window.__bib && window.__bib.ready, { timeout: 120000 });

const results = {};
for (const tag of ['native', 'engine']) {
  const run = async (code) =>
    tag === 'native'
      ? page.evaluate(code)
      : page.evaluate((c) => window.__bib.eval(c), code);
  // round-trip overhead
  let overhead = 1e9;
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await run(`console.log('BX|ping${i}|${tag}|0|0')`);
    await waitFor(`ping${i}`, tag, 60000);
    overhead = Math.min(overhead, Date.now() - t0);
  }
  console.log(`--- ${tag} (eval round-trip overhead ${overhead} ms) ---`);
  for (const [name, body] of Object.entries(BODIES)) {
    const code = wrap(name, body, 2, tag);
    const t0 = Date.now();
    await run(code);
    const hit = await waitFor(name, tag, 600000);
    const wall = Date.now() - t0 - overhead;
    (results[name] ??= {})[tag] = { inner: hit.ms, wall, chk: hit.chk };
    console.log(`  ${name.padEnd(14)} inner=${String(hit.ms).padStart(7)}  wall=${String(wall).padStart(7)}  chk=${hit.chk}`);
  }
}
console.log('\nbench            native   engine    ratio');
for (const [name, r] of Object.entries(results))
  console.log(
    `${name.padEnd(14)} ${String(r.native.inner).padStart(7)}  ${String(r.engine.inner).padStart(7)}  ` +
    `${(r.engine.inner / Math.max(r.native.inner, 0.5)).toFixed(0).padStart(6)}x` +
    (r.native.chk === r.engine.chk ? '' : `   MISMATCH ${r.native.chk} vs ${r.engine.chk}`),
  );
await browser.close();
server.kill();
process.exit(0);
