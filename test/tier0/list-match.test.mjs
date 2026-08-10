import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEntry, entryMatches, listMatches } from '../../src/ext/list-match.mjs';

test('normalizeEntry', () => {
  const CASES = [
    ['example.com', 'example.com'],
    ['  Example.COM  ', 'example.com'],
    ['example.com.', 'example.com'],
    ['https://www.example.com/path?q=1', 'www.example.com'],
    ['example.com/path', 'example.com'],
    ['=host.example.com', '=host.example.com'],
    ['=HOST.example.com', '=host.example.com'],
    ['192.168.0.1', '192.168.0.1'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['', null],
    ['   ', null],
    ['not a domain', null],
    ['http://', null],
  ];
  for (const [input, expected] of CASES)
    assert.equal(normalizeEntry(input), expected, `normalizeEntry(${JSON.stringify(input)})`);
});

test('entryMatches: domain covers itself and subdomains', () => {
  assert.ok(entryMatches('example.com', 'example.com'));
  assert.ok(entryMatches('example.com', 'www.example.com'));
  assert.ok(entryMatches('example.com', 'a.b.example.com'));
  assert.ok(entryMatches('example.com', 'EXAMPLE.com'));
  assert.ok(entryMatches('example.com', 'example.com.')); // trailing dot
  assert.ok(!entryMatches('example.com', 'badexample.com')); // no suffix confusion
  assert.ok(!entryMatches('example.com', 'example.com.evil.net'));
  assert.ok(!entryMatches('example.com', 'example.org'));
  assert.ok(!entryMatches('www.example.com', 'example.com')); // parent not covered
});

test('entryMatches: exact-host entries', () => {
  assert.ok(entryMatches('=host.example.com', 'host.example.com'));
  assert.ok(!entryMatches('=host.example.com', 'sub.host.example.com'));
  assert.ok(!entryMatches('=host.example.com', 'example.com'));
});

test('entryMatches: IP literals are exact', () => {
  assert.ok(entryMatches('192.168.0.1', '192.168.0.1'));
  assert.ok(!entryMatches('192.168.0.1', '1.192.168.0.1'));
});

test('listMatches', () => {
  const list = ['example.com', '=only.this.net'];
  assert.ok(listMatches(list, 'www.example.com'));
  assert.ok(listMatches(list, 'only.this.net'));
  assert.ok(!listMatches(list, 'sub.only.this.net'));
  assert.ok(!listMatches([], 'example.com'));
});
