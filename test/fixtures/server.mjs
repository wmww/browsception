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
// Usage: node test/fixtures/server.mjs [--https 8443] [--http 8081]

import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, 'pages');
const CA_DIR = join(HERE, 'ca');

// ---------------------------------------------------------------- TLS cert
function ensureCert() {
  const key = join(CA_DIR, 'bstest.key');
  const crt = join(CA_DIR, 'bstest.crt');
  if (!existsSync(key) || !existsSync(crt)) {
    mkdirSync(CA_DIR, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-keyout', key, '-out', crt, '-days', '3650', '-nodes',
      '-subj', '/CN=bstest fixture',
      '-addext', 'subjectAltName=DNS:bstest,DNS:*.bstest',
    ]);
  }
  return { key: readFileSync(key), cert: readFileSync(crt) };
}

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
  return readFileSync(join(PAGES, name));
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
  if (path === '/__health') return send(res, 200, '{"ok":true}', 'json');

  record(req, scheme);

  // Dynamic endpoints, available on every host.
  if (path.startsWith('/status/')) return send(res, Number(path.slice(8)) || 500, 'status fixture', 'txt');
  if (path === '/redirect') {
    const to = url.searchParams.get('to') ?? '/';
    const code = Number(url.searchParams.get('code') ?? 302);
    return send(res, code, '', 'txt', { location: to });
  }
  if (path === '/set-cookie') {
    // /set-cookie?n=name&v=value&attrs=;Path=/;SameSite=None;Secure&then=/cookie-echo
    const n = url.searchParams.get('n') ?? 'bs';
    const v = url.searchParams.get('v') ?? 'test';
    const attrs = url.searchParams.get('attrs') ?? '; Path=/';
    const then = url.searchParams.get('then');
    const hdrs = { 'set-cookie': `${n}=${v}${attrs}` };
    if (then) return send(res, 302, '', 'txt', { ...hdrs, location: then });
    return send(res, 200, `<title>set-cookie</title>set ${n}`, 'html', hdrs);
  }
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
const HTTPS_PORT = flag('https', 8443);
const HTTP_PORT = flag('http', 8081);

https.createServer(ensureCert(), (q, s) => handle(q, s, 'https')).listen(HTTPS_PORT);
http.createServer((q, s) => handle(q, s, 'http')).listen(HTTP_PORT);
console.log(`fixture server: https :${HTTPS_PORT}, http :${HTTP_PORT} (oracle at /__requests)`);
