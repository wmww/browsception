// Tier 0: bridge DNR rule generation (notes/bridge-probe.md decisions 3–4).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDGE_RULE,
  CLIENT_HINT_HEADERS,
  DNR_REQUEST_HEADERS,
  baseSessionRules,
  perRequestHeaderRule,
} from '../../src/ext/bridge-rules.mjs';

const EXT = 'abcdefghijklmnop';

test('base rule sets UA, strips client hints and origin/referer, scoped to bridge fetches', () => {
  const [rule] = baseSessionRules(EXT, { userAgent: 'UA/1' });
  assert.equal(rule.id, BRIDGE_RULE.BASE_ID);
  assert.deepEqual(rule.condition, {
    initiatorDomains: [EXT],
    resourceTypes: ['xmlhttprequest'],
  });
  const ops = rule.action.requestHeaders;
  assert.deepEqual(ops[0], { header: 'user-agent', operation: 'set', value: 'UA/1' });
  const removed = ops.filter((o) => o.operation === 'remove').map((o) => o.header);
  assert.deepEqual(removed, ['origin', 'referer', ...CLIENT_HINT_HEADERS]);
});

test('base rule without a UA leaves user-agent alone (host string rides)', () => {
  const [rule] = baseSessionRules(EXT);
  assert.ok(!rule.action.requestHeaders.some((o) => o.header === 'user-agent'));
});

test('per-request rule carries a differing engine UA', () => {
  const rule = perRequestHeaderRule(10001, 'https://a.bstest/', { 'user-agent': 'Quirk/1' }, EXT);
  assert.deepEqual(rule.action.requestHeaders, [
    { header: 'user-agent', operation: 'set', value: 'Quirk/1' },
  ]);
});

test('per-request rule carries exactly the engine-sent forbidden headers, exact-URL scoped', () => {
  const url = 'https://app.bstest/a?b=c&d=e';
  const rule = perRequestHeaderRule(10001, url, { cookie: 'a=1; b=2', origin: 'https://x.y' }, EXT);
  assert.equal(rule.priority, BRIDGE_RULE.PER_REQUEST_PRIORITY);
  assert.ok(rule.priority > BRIDGE_RULE.BASE_PRIORITY, 'set must beat base strip');
  assert.equal(rule.condition.urlFilter, `|${url}|`);
  assert.deepEqual(rule.condition.initiatorDomains, [EXT]);
  assert.deepEqual(rule.action.requestHeaders, [
    { header: 'cookie', operation: 'set', value: 'a=1; b=2' },
    { header: 'origin', operation: 'set', value: 'https://x.y' },
  ]);
});

test('no forbidden headers → no rule', () => {
  assert.equal(perRequestHeaderRule(10001, 'https://a.bstest/', {}, EXT), null);
});

test('per-request rule carries engine fetch metadata in DNR_REQUEST_HEADERS order', () => {
  const h = {
    'sec-fetch-user': '?1',
    'sec-fetch-dest': 'document',
    cookie: 'a=1',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
  };
  const rule = perRequestHeaderRule(10001, 'https://a.bstest/', h, EXT);
  assert.deepEqual(
    rule.action.requestHeaders.map((o) => o.header),
    DNR_REQUEST_HEADERS.filter((n) => n in h),
  );
  assert.ok(rule.action.requestHeaders.every((o) => o.operation === 'set' && o.value === h[o.header]));
});

test('base rule leaves the host\'s Sec-Fetch-* alone (the engine omits it only for http)', () => {
  const [rule] = baseSessionRules(EXT, { userAgent: 'UA/1' });
  assert.ok(!rule.action.requestHeaders.some((o) => o.header.startsWith('sec-fetch-')));
  // Cache headers are stamped below DNR (probe 2026-09-10): no rule touches them.
  assert.ok(!rule.action.requestHeaders.some((o) => o.header === 'pragma' || o.header === 'cache-control'));
});
