#!/usr/bin/env node
// Fixture server + assertion oracle (notes/testing.md § Fixture server).
//
// Serves hand-written fixture pages on *.bstest domains (mapped into Chromium
// via --host-resolver-rules) over HTTPS (self-signed, harness launches Chromium
// with --ignore-certificate-errors; see open-questions #20) and HTTP (scheme-
// handling fixture). Doubles as the oracle: records every request it receives
// and exposes them at /__requests for tests to assert on (e.g. "no Cookie from
// the host jar ever arrived", "the blocked fetch never hit the wire").
//
// Usage: node test/fixtures/server.mjs [--https PORT] [--http PORT]
// (defaults: this checkout's derived port block — test/harness/ports.mjs)

import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKOUT, HTTP_PORT as DEFAULT_HTTP, HTTPS_PORT as DEFAULT_HTTPS } from '../harness/ports.mjs';
import { ensureCert } from '../harness/cert.mjs';
import { FIXTURE_SANS } from './hosts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, 'pages');
const CA_DIR = join(HERE, 'ca');

// ------------------------------------------------------------------ oracle
const requests = [];
function record(req, scheme) {
  requests.push({
    ts: Date.now(),
    scheme,
    host: req.headers.host ?? '',
    method: req.method,
    path: req.url,
    headers: { ...req.headers },
  });
}

// -------------------------------------------------------------- responses
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript', json: 'application/json', txt: 'text/plain' };

function send(res, status, body, type = 'html', extra = {}) {
  res.writeHead(status, { 'content-type': MIME[type] ?? type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}

function page(name) {
  // Ports are per-checkout (harness/ports.mjs), so pages that must hit the
  // LIVE fixture ports (e.g. hostile.html's localhost probe) use placeholders.
  return readFileSync(join(PAGES, name), 'utf8')
    .replaceAll('__HTTP_PORT__', String(HTTP_PORT))
    .replaceAll('__HTTPS_PORT__', String(HTTPS_PORT));
}

function handle(req, res, scheme) {
  const url = new URL(req.url, `${scheme}://${req.headers.host ?? 'unknown.bstest'}`);
  const host = url.hostname;
  const path = url.pathname;

  // Oracle endpoints (never recorded).
  if (path === '/__requests') {
    if (req.method === 'DELETE' || url.searchParams.has('clear')) {
      requests.length = 0;
      return send(res, 200, '{"cleared":true}', 'json');
    }
    return send(res, 200, JSON.stringify(requests, null, 1), 'json');
  }
  // The checkout stamp lets a harness reject a neighbouring worktree's server
  // (ports.mjs § waitForOwnFixtureServer).
  if (path === '/__health')
    return send(res, 200, JSON.stringify({ ok: true, checkout: CHECKOUT, pid: process.pid }), 'json');

  record(req, scheme);

  // Dynamic endpoints, available on every host.
  if (path.startsWith('/status/')) return send(res, Number(path.slice(8)) || 500, 'status fixture', 'txt');
  if (path === '/redirect') {
    const to = url.searchParams.get('to') ?? '/';
    const code = Number(url.searchParams.get('code') ?? 302);
    return send(res, code, '', 'txt', { location: to });
  }
  // Scheme-gate fixture: a 302 to a non-http(s) URL. The engine re-issues a
  // redirect hop as a fresh main request, so this is the "guest steers the
  // top level at file: without a link" case.
  if (path === '/redir-file')
    return send(res, 302, '', 'txt', { location: 'file:///etc/passwd' });
  if (path === '/set-cookie') {
    // /set-cookie?n=name&v=value&attrs=;Path=/;SameSite=None;Secure&then=/cookie-echo
    // Repeat n/v for several Set-Cookie headers (one header line each).
    const ns = url.searchParams.getAll('n');
    const vs = url.searchParams.getAll('v');
    if (!ns.length) ns.push('bs');
    const attrs = url.searchParams.get('attrs') ?? '; Path=/';
    const then = url.searchParams.get('then');
    const hdrs = { 'set-cookie': ns.map((n, i) => `${n}=${vs[i] ?? 'test'}${attrs}`) };
    if (then) return send(res, 302, '', 'txt', { ...hdrs, location: then });
    return send(res, 200, `<title>set-cookie</title>set ${ns.join(',')}`, 'html', hdrs);
  }
  // HSTS seed: a page whose (https) response carries Strict-Transport-Security,
  // so the NEXT http:// load of this host is upgraded by the browser itself.
  if (path === '/hsts')
    return send(res, 200, '<title>hsts</title>HSTS-SEEDED', 'html', {
      'strict-transport-security': `max-age=${url.searchParams.get('max-age') ?? 300}`,
    });
  if (path === '/cookie-echo')
    return send(res, 200, JSON.stringify({ cookie: req.headers.cookie ?? null }), 'json', {
      'access-control-allow-origin': '*',
    });
  if (path === '/echo-body') {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      send(res, 200, JSON.stringify({ len: body.length, text: body.toString('utf8') }), 'json');
    });
    return;
  }
  if (path === '/echo-headers')
    return send(res, 200, JSON.stringify(req.headers), 'json', { 'access-control-allow-origin': '*' });
  if (path === '/download')
    return send(res, 200, 'attachment-bytes', 'application/octet-stream', {
      'content-disposition': 'attachment; filename="f.bin"',
    });
  if (path === '/api/data')
    return send(res, 200, '{"data":"FETCH-PAYLOAD"}', 'json');
  if (path === '/api/cors')
    return send(res, 200, '{"data":"XFETCH-PAYLOAD"}', 'json', {
      'access-control-allow-origin': '*',
    });
  if (path === '/big') {
    // Streams ~64 MiB unless the client aborts first (size-cap tests).
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    const chunk = Buffer.alloc(1024 * 1024, 0x42);
    let sent = 0;
    const pump = () => {
      while (sent < 64) {
        sent++;
        if (!res.write(chunk)) return void res.once('drain', pump);
      }
      res.end();
    };
    return pump();
  }
  if (path === '/slow') {
    // Headers now, one byte, then silence (idle-timeout tests). Never completes.
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.write('x');
    return;
  }

  // Per-host fixture pages.
  const fixture = {
    'grid.bstest': 'grid.html',
    'input.bstest': 'input.html',
    'app.bstest': 'app.html',
    'hostile.bstest': 'hostile.html',
    'scroll.bstest': 'scroll.html',
    'scroll-sticky.bstest': 'scroll-sticky.html',
  }[host];
  try {
    if (path === '/' && fixture) return send(res, 200, page(fixture));
    if (path === '/final') return send(res, 200, '<title>final</title><h1 id="sentinel">REDIRECT-FINAL</h1>');
    // input.bstest's #nav link target (any host).
    if (path === '/final.html') return send(res, 200, page('final.html'));
    // Anything else on any *.bstest host: a generic identifiable page
    // (interception-matrix tests navigate to arbitrary hosts/paths).
    return send(
      res,
      200,
      `<title>${host}</title><h1>GENERIC ${host}${path}</h1><p>BSTEST-GENERIC-SENTINEL</p>`,
    );
  } catch (e) {
    return send(res, 500, String(e), 'txt');
  }
}

// ------------------------------------------------------------------- main
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const HTTPS_PORT = flag('https', DEFAULT_HTTPS);
const HTTP_PORT = flag('http', DEFAULT_HTTP);

// Spawners run this with stdio:'ignore', so an unhandled EADDRINUSE would be a
// silent death followed by the harness talking to whoever DOES hold the port.
// Exit non-zero with a named reason; the health check catches the rest.
const bail = (what) => (e) => {
  console.error(`fixture server: ${what} — ${e.code === 'EADDRINUSE' ? `port already in use` : e.message}`);
  process.exit(1);
};
https.createServer(ensureCert({ dir: CA_DIR, sans: FIXTURE_SANS }), (q, s) => handle(q, s, 'https'))
  .on('error', bail(`https :${HTTPS_PORT}`)).listen(HTTPS_PORT);
http.createServer((q, s) => handle(q, s, 'http'))
  .on('error', bail(`http :${HTTP_PORT}`))
  // Announce only once actually bound — the old unconditional log claimed
  // success a tick before an EADDRINUSE killed the process.
  .listen(HTTP_PORT, () =>
    console.log(`fixture server: https :${HTTPS_PORT}, http :${HTTP_PORT} (oracle at /__requests)`));
