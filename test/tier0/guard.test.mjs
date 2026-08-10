import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRequest, CAPS } from '../../src/shim/guard.mjs';

// The security-critical table (notes/testing.md tier 0 #1).
// Grows only with real bypass finds.
const CASES = [
  // scheme allowlist
  ['https://example.com/', true, 'ok'],
  ['http://example.com/', true, 'ok'],
  ['ftp://example.com/', false, 'scheme:ftp'],
  ['file:///etc/passwd', false, 'scheme:file'],
  ['chrome-extension://abc/x', false, 'scheme:chrome-extension'],
  ['ws://example.com/', false, 'scheme:ws'],
  ['wss://example.com/', false, 'scheme:wss'],
  ['data:text/html,hi', false, 'scheme:data'],
  ['javascript:alert(1)', false, 'scheme:javascript'],
  ['blob:https://example.com/x', false, 'scheme:blob'],
  ['not a url', false, 'unparseable-url'],
  // userinfo smuggling
  ['https://user:pass@example.com/', false, 'userinfo'],
  ['https://example.com%2F@evil.com/', false, 'userinfo'],
  // localhost & special hostnames
  ['http://localhost/', false, 'private-network'],
  ['http://localhost:8080/', false, 'private-network'],
  ['https://LOCALHOST/', false, 'private-network'],
  ['http://foo.localhost/', false, 'private-network'],
  ['http://printer.local/', false, 'private-network'],
  ['http://db.internal/', false, 'private-network'],
  ['http://localhost./', false, 'private-network'],
  // IPv4 literals, incl. normalization of shorthand/hex/octal by URL parser
  ['http://127.0.0.1/', false, 'private-network'],
  ['http://127.1/', false, 'private-network'],
  ['http://0x7f.0.0.1/', false, 'private-network'],
  ['http://017700000001/', false, 'private-network'],
  ['http://0.0.0.0/', false, 'private-network'],
  ['http://10.0.0.5/', false, 'private-network'],
  ['http://172.16.0.1/', false, 'private-network'],
  ['http://172.31.255.255/', false, 'private-network'],
  ['http://172.32.0.1/', true, 'ok'], // just outside RFC1918
  ['http://192.168.1.1/', false, 'private-network'],
  ['http://169.254.169.254/', false, 'private-network'], // cloud metadata
  ['http://100.64.0.1/', false, 'private-network'], // CGNAT
  ['http://8.8.8.8/', true, 'ok'],
  // IPv6 literals
  ['http://[::1]/', false, 'private-network'],
  ['http://[::]/', false, 'private-network'],
  ['http://[fe80::1]/', false, 'private-network'],
  ['http://[fc00::1]/', false, 'private-network'],
  ['http://[fd12:3456::1]/', false, 'private-network'],
  ['http://[::ffff:127.0.0.1]/', false, 'private-network'], // v4-mapped
  ['http://[::ffff:192.168.0.1]/', false, 'private-network'],
  ['http://[::ffff:7f00:1]/', false, 'private-network'], // hex-form mapped
  ['http://[2606:4700::1111]/', true, 'ok'],
  // bad ports
  ['https://example.com:25/', false, 'bad-port:25'],
  ['https://example.com:6379/', false, 'bad-port:6379'],
  ['http://example.com:22/', false, 'bad-port:22'],
  ['https://example.com:8443/', true, 'ok'],
  ['https://example.com:443/', true, 'ok'], // default port normalizes to ''
];

test('guard list table', () => {
  for (const [url, allow, reason] of CASES) {
    const r = evaluateRequest(url);
    assert.equal(r.allow, allow, `${url} → allow should be ${allow} (got ${r.reason})`);
    assert.equal(r.reason, reason, `${url} → reason`);
  }
});

test('private-network override opens private but not schemes/ports', () => {
  const opts = { allowPrivateNetwork: true };
  assert.equal(evaluateRequest('http://192.168.1.1/', opts).allow, true);
  assert.equal(evaluateRequest('http://localhost:8080/', opts).allow, true);
  assert.equal(evaluateRequest('file:///x', opts).allow, false);
  assert.equal(evaluateRequest('http://192.168.1.1:6379/', opts).allow, false);
});

test('size/time caps are plumbed', () => {
  assert.ok(CAPS.MAX_RESPONSE_BYTES > 1024 * 1024);
  assert.ok(CAPS.IDLE_TIMEOUT_MS >= 1000);
});
