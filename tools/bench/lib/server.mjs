#!/usr/bin/env node
// Bench fixture server: serves tools/bench/fixtures over http+https on this
// checkout's bench port lane (test/harness/ports.mjs +10/+11).
//
// Separate from the test fixture server on purpose. The bench suite is
// decoupled from the code under test (notes/perf-measurement.md § Contract):
// fixtures are served by the BENCH checkout no matter which extension
// directory is being measured, and a bench run must not disturb, or be
// disturbed by, a tier-1/2 run's oracle.
//
// Usage: node tools/bench/lib/server.mjs [--http PORT] [--https PORT]

import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKOUT, BENCH_HTTP_PORT, BENCH_HTTPS_PORT } from '../../../test/harness/ports.mjs';
import { ensureCert } from '../../../test/harness/cert.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, '../fixtures');
const CA_DIR = join(HERE, '../../../test/fixtures/ca');
export const BENCH_HOST = 'bench.bsbench';
export const BENCH_ORIGIN = `https://${BENCH_HOST}`;
// Chromium needs this appended to --host-resolver-rules to reach us.
export const benchResolverRule = (port = BENCH_HTTPS_PORT) =>
  `MAP ${BENCH_HOST} 127.0.0.1:${port}`;

const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8' };

function handle(req, res) {
  const path = new URL(req.url, 'https://x').pathname;
  if (path === '/__health')
    return send(res, 200, JSON.stringify({ ok: true, checkout: CHECKOUT, pid: process.pid }), 'application/json');
  // No directory escape, no directory listings, no fetching outside fixtures/.
  const rel = normalize(path).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '');
  const file = join(FIXTURE_DIR, rel);
  if (!file.startsWith(FIXTURE_DIR) || !rel || !existsSync(file))
    return send(res, 404, `no bench fixture at ${path}`, 'text/plain');
  const ext = rel.slice(rel.lastIndexOf('.') + 1);
  // no-store: a warm HTTP cache would make the boot scenario measure the
  // cache instead of the engine.
  send(res, 200, readFileSync(file), MIME[ext] ?? 'application/octet-stream');
}

function send(res, status, body, type) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

/** Start both listeners. Resolves once bound. */
export async function startBenchServer({ http: hp = BENCH_HTTP_PORT, https: sp = BENCH_HTTPS_PORT } = {}) {
  const servers = [
    https.createServer(ensureCert({ dir: CA_DIR, name: 'bsbench', sans: 'DNS:bsbench,DNS:*.bsbench' }), handle),
    http.createServer(handle),
  ];
  await Promise.all(servers.map((s, i) => new Promise((resolve, reject) => {
    s.on('error', reject).listen(i === 0 ? sp : hp, resolve);
  })));
  return {
    httpPort: hp,
    httpsPort: sp,
    close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
  const s = await startBenchServer({ http: flag('http', BENCH_HTTP_PORT), https: flag('https', BENCH_HTTPS_PORT) });
  console.log(`bench fixtures: https :${s.httpsPort}, http :${s.httpPort} (${FIXTURE_DIR})`);
}
