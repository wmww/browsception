// Tier 0: popup per-site action matrix (notes/ui.md § Toolbar UI).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primaryActions } from '../../src/ext/actions.mjs';

const ops = (...args) => primaryActions(...args).map((a) => a.op);

const base = { active: true, whitelist: ['trusted.com'], blacklist: ['bad.com'] };
const wl = { ...base, mode: 'whitelist' };
const bl = { ...base, mode: 'blacklist' };

test('whitelist mode matrix', () => {
  assert.deepEqual(ops(wl, 'sandboxed', 'random.example'), ['trust', 'open-native-once']);
  assert.deepEqual(ops(wl, 'native', 'trusted.com'), ['untrust']);
  assert.deepEqual(ops(wl, 'native', 'sub.trusted.com'), ['untrust']); // entry covers subdomain
  assert.equal(primaryActions(wl, 'native', 'sub.trusted.com')[0].entry, 'trusted.com');
  assert.deepEqual(ops(wl, 'native', 'unlisted.example'), []); // escape-hatch native
});

test('blacklist mode matrix', () => {
  assert.deepEqual(ops(bl, 'native', 'random.example'), ['sandbox']);
  assert.deepEqual(ops(bl, 'sandboxed', 'bad.com'), ['unsandbox', 'open-native-once']);
  // sandboxed without a covering entry (stale tab after list edit): still escapable
  assert.deepEqual(ops(bl, 'sandboxed', 'unlisted.example'), ['open-native-once']);
});

test('inactive / hostless / other produce no actions', () => {
  assert.deepEqual(ops({ ...wl, active: false }, 'sandboxed', 'x.com'), []);
  assert.deepEqual(ops(wl, 'other', null), []);
  assert.deepEqual(ops(wl, 'sandboxed', ''), []);
});

test('trust entry is the normalized registrable host', () => {
  const [trust] = primaryActions(wl, 'sandboxed', 'WWW.Example.COM');
  assert.equal(trust.entry, 'www.example.com');
});
