import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  desiredRuleState,
  catchallRules,
  entryRegex,
  PRIORITY,
  CATCHALL_RULESET_ID,
} from '../../src/ext/dnr-rules.mjs';

const VIEWER = 'chrome-extension://abcdefghijklmnop/viewer.html';

test('entryRegex matches per list semantics', () => {
  const re = (e) => new RegExp(entryRegex(e));
  assert.match('https://example.com/', re('example.com'));
  assert.match('http://www.example.com/x?y#z', re('example.com'));
  assert.match('https://example.com:8443/', re('example.com'));
  assert.match('https://example.com', re('example.com')); // no path
  assert.doesNotMatch('https://badexample.com/', re('example.com'));
  assert.doesNotMatch('https://example.com.evil.net/', re('example.com'));
  assert.doesNotMatch('https://evil.com/?u=example.com', re('example.com'));
  assert.doesNotMatch('https://evil.com/#https://example.com/', re('example.com'));
  assert.doesNotMatch('https://user@evil.com/a.example.com', re('example.com'));
  // exact-host
  assert.match('https://host.example.com/', re('=host.example.com'));
  assert.doesNotMatch('https://sub.host.example.com/', re('=host.example.com'));
  // IP literal
  assert.match('http://203.0.113.7/', re('203.0.113.7'));
  assert.doesNotMatch('http://1.203.0.113.7/', re('203.0.113.7'));
});

test('inactive: everything empty', () => {
  assert.deepEqual(
    desiredRuleState({ active: false, mode: 'whitelist', whitelist: ['a.com'] }, VIEWER),
    { enabledStaticRulesets: [], dynamicRules: [], sessionRules: [] },
  );
});

test('whitelist mode: catchall enabled + allow rule per entry', () => {
  const s = desiredRuleState(
    { active: true, mode: 'whitelist', whitelist: ['trusted.com', '=exact.net'], blacklist: ['ignored.com'] },
    VIEWER,
  );
  assert.deepEqual(s.enabledStaticRulesets, [CATCHALL_RULESET_ID]);
  assert.equal(s.dynamicRules.length, 2);
  assert.deepEqual(s.dynamicRules[0], {
    id: 1000,
    priority: PRIORITY.ALLOW,
    action: { type: 'allow' },
    condition: { regexFilter: entryRegex('trusted.com'), resourceTypes: ['main_frame'] },
  });
  assert.equal(s.dynamicRules[1].id, 1001);
  assert.deepEqual(s.sessionRules, []);
  // allow must beat the catch-all
  assert.ok(PRIORITY.ALLOW > PRIORITY.CATCHALL);
});

test('blacklist mode: no catchall, redirect rule per entry', () => {
  const s = desiredRuleState(
    { active: true, mode: 'blacklist', whitelist: ['ignored.com'], blacklist: ['sketchy.com'] },
    VIEWER,
  );
  assert.deepEqual(s.enabledStaticRulesets, []);
  assert.deepEqual(s.dynamicRules, [
    {
      id: 2000,
      priority: PRIORITY.LIST_REDIRECT,
      action: {
        type: 'redirect',
        redirect: { regexSubstitution: `${VIEWER}?url=\\0` },
      },
      condition: { regexFilter: entryRegex('sketchy.com'), resourceTypes: ['main_frame'] },
    },
  ]);
});

test('escape hatch: session allow scoped to tab + entry, beats all', () => {
  const s = desiredRuleState(
    {
      active: true,
      mode: 'whitelist',
      whitelist: [],
      escapeHatches: [{ tabId: 42, entry: 'once.com' }],
    },
    VIEWER,
  );
  assert.deepEqual(s.sessionRules, [
    {
      id: 100042,
      priority: PRIORITY.ESCAPE,
      action: { type: 'allow' },
      condition: {
        regexFilter: entryRegex('once.com'),
        resourceTypes: ['main_frame'],
        tabIds: [42],
      },
    },
  ]);
  assert.ok(PRIORITY.ESCAPE > PRIORITY.ALLOW);
});

test('catchall ruleset shape', () => {
  const rules = catchallRules(VIEWER);
  assert.equal(rules.length, 1);
  const r = rules[0];
  assert.equal(r.action.type, 'redirect');
  assert.equal(r.action.redirect.regexSubstitution, `${VIEWER}?url=\\0`);
  assert.deepEqual(r.condition.resourceTypes, ['main_frame']);
  // must never match the extension origin (no interception loops)
  assert.doesNotMatch('chrome-extension://abc/viewer.html', new RegExp(r.condition.regexFilter));
  assert.match('https://anything.example/', new RegExp(r.condition.regexFilter));
  // regexSubstitution rules must stay under DNR's 2KB compiled-rule limit; keep source small
  assert.ok(JSON.stringify(r).length < 1000);
});
