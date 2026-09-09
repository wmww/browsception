import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPlan,
  desiredRuleState,
  catchallRules,
  entryRegex,
  shouldSandbox,
  sweepAction,
  tabUrl,
  PRIORITY,
  CATCHALL_RULESET_ID,
  CATCHALL_RULE_ID,
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

// Firefox: no static ruleset can name the per-profile moz-extension UUID, so
// the catch-all rides in the dynamic set — same rule, same id and priority.
test('whitelist mode without a static catchall: the catch-all is a dynamic rule', () => {
  const s = desiredRuleState(
    { active: true, mode: 'whitelist', whitelist: ['trusted.com'] },
    VIEWER,
    { staticCatchall: false },
  );
  assert.deepEqual(s.enabledStaticRulesets, []);
  assert.deepEqual(s.dynamicRules[0], catchallRules(VIEWER)[0]);
  assert.equal(s.dynamicRules[0].id, CATCHALL_RULE_ID);
  assert.equal(s.dynamicRules[1].id, 1000);
  assert.equal(s.dynamicRules.length, 2);
  // Inactive / blacklist mode carry no catch-all either way.
  assert.deepEqual(
    desiredRuleState({ active: true, mode: 'blacklist', blacklist: ['x.com'] }, VIEWER, { staticCatchall: false })
      .dynamicRules.map((r) => r.id),
    [2000],
  );
  // applyPlan then never touches the static ruleset.
  assert.deepEqual(applyPlan([], s), [{ op: 'dynamic', rules: s.dynamicRules }]);
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

test('shouldSandbox mirrors rule semantics (sweep + badge disposition)', () => {
  const base = { active: true, whitelist: ['trusted.com'], blacklist: ['bad.com'] };
  const wl = { ...base, mode: 'whitelist' };
  const bl = { ...base, mode: 'blacklist' };
  // whitelist mode: sandbox-by-default
  assert.equal(shouldSandbox(wl, 'https://random.example/'), true);
  assert.equal(shouldSandbox(wl, 'https://trusted.com/x'), false);
  assert.equal(shouldSandbox(wl, 'https://sub.trusted.com/'), false);
  // blacklist mode: native-by-default
  assert.equal(shouldSandbox(bl, 'https://random.example/'), false);
  assert.equal(shouldSandbox(bl, 'http://bad.com/'), true);
  assert.equal(shouldSandbox(bl, 'https://deep.sub.bad.com/'), true);
  // never sandbox non-http(s), unparsable, or when inactive
  assert.equal(shouldSandbox(wl, 'chrome-extension://abc/x.html'), false);
  assert.equal(shouldSandbox(wl, 'about:blank'), false);
  assert.equal(shouldSandbox(wl, 'not a url'), false);
  assert.equal(shouldSandbox({ ...wl, active: false }, 'https://random.example/'), false);
});

// --- sweep decisions -------------------------------------------------------
const WL = { active: true, mode: 'whitelist', whitelist: ['trusted.com'], blacklist: [] };
const sweep = (tab, escape = null) => sweepAction(WL, tab, VIEWER, escape);

test('tabUrl prefers the in-flight navigation over the placeholder url', () => {
  // Chromium reports a pre-commit tab as url:'about:blank' + pendingUrl:target
  // — nullish-coalescing the two would keep 'about:blank' and miss exactly the
  // tab the sweep exists for (a navigation that raced ruleset registration).
  assert.equal(tabUrl({ url: 'about:blank', pendingUrl: 'https://x.example/' }), 'https://x.example/');
  assert.equal(tabUrl({ url: '', pendingUrl: 'https://x.example/' }), 'https://x.example/');
  assert.equal(tabUrl({ url: 'https://x.example/' }), 'https://x.example/');
  assert.equal(tabUrl({}), '');
});

test('sweepAction sandboxes a tab whose navigation is still in flight', () => {
  assert.deepEqual(sweep({ url: 'about:blank', pendingUrl: 'https://raced.example/x' }), {
    op: 'sandbox',
    url: `${VIEWER}?url=https://raced.example/x`,
  });
  assert.equal(sweep({ url: 'about:blank', pendingUrl: 'https://trusted.com/x' }), null);
  assert.equal(sweep({ url: 'about:blank' }), null);
});

test('sweepAction is symmetric and idempotent', () => {
  // viewer tab on a now-trusted target leaves the sandbox; one still untrusted
  // stays put (or the sweep would fight the rules every reconcile).
  assert.deepEqual(sweep({ url: `${VIEWER}?url=https://trusted.com/a` }), {
    op: 'native',
    url: 'https://trusted.com/a',
  });
  assert.equal(sweep({ url: `${VIEWER}?url=https://other.example/a` }), null);
  assert.equal(sweep(sweep({ url: 'https://other.example/a' })), null); // {url} of the redirect
});

test('sweepAction reads an ENCODED viewer target like the viewer does', () => {
  // Regression: viewerTarget used to hand the raw 'https%3A…' slice to
  // shouldSandbox, which can't parse it → "not sandboxable" → tabs.update
  // with a relative-looking string → chrome-extension://<id>/https%3A… →
  // ERR_FILE_NOT_FOUND on a tab that was perfectly fine.
  const enc = (u) => encodeURIComponent(u);
  assert.equal(sweep({ url: `${VIEWER}?url=${enc('https://other.example/a?q=1')}` }), null);
  // still-native target: taken native with the DECODED url
  assert.deepEqual(sweep({ url: `${VIEWER}?url=${enc('https://trusted.com/a?q=1')}` }), {
    op: 'native',
    url: 'https://trusted.com/a?q=1',
  });
});

test('sweepAction never sends a non-http(s) viewer target to tabs.update', () => {
  // The viewer already refuses these ("blocked: only http(s) URLs"); the
  // sweep's job is to leave the tab alone, not to navigate it to garbage.
  for (const target of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,x',
    'javascript%3Aalert(1)',
    'not a url',
    '',
  ])
    assert.equal(sweep({ url: `${VIEWER}?url=${target}` }), null, `target ${target}`);
});

test('sweepAction leaves an escaped tab native (the grant outranks the sweep)', () => {
  const tab = { url: 'https://escaped.example/page' };
  assert.equal(sweep(tab, 'escaped.example'), null);
  // mirrors escapeSessionRule's regex: a bare entry covers subdomains
  assert.equal(sweep({ url: 'https://sub.escaped.example/' }, 'escaped.example'), null);
  assert.deepEqual(sweep({ url: 'https://other.example/' }, 'escaped.example'), {
    op: 'sandbox',
    url: `${VIEWER}?url=https://other.example/`,
  });
  // grant follows the host, not the URL: same-host navigation stays native
  assert.equal(sweep({ url: 'https://escaped.example/elsewhere' }, 'escaped.example'), null);
});

// Every reconcile is two DNR calls with a gap between them; a navigation that
// starts in the gap sees whatever half-applied state we left. The catch-all
// must therefore go on BEFORE the dynamic swap and off AFTER it — the other
// order left whitelist->blacklist momentarily un-intercepted (a real escape,
// which also aborted the racing navigation when the sweep rescued it).
test('applyPlan never opens an un-intercepted window', () => {
  const states = [
    { active: false, mode: 'whitelist', whitelist: [], blacklist: [] },
    { active: true, mode: 'whitelist', whitelist: [], blacklist: [] },
    { active: true, mode: 'whitelist', whitelist: ['a.com'], blacklist: [] },
    { active: true, mode: 'blacklist', whitelist: [], blacklist: [] },
    { active: true, mode: 'blacklist', whitelist: [], blacklist: ['a.com'] },
  ];
  const label = (s) => (s.active ? `${s.mode}(${[...s.whitelist, ...s.blacklist].join()})` : 'off');
  for (const from of states)
    for (const to of states) {
      const enabled = desiredRuleState(from, VIEWER).enabledStaticRulesets;
      const plan = applyPlan(enabled, desiredRuleState(to, VIEWER));
      const dyn = plan.findIndex((s) => s.op === 'dynamic');
      assert.equal(dyn >= 0, true, 'the dynamic swap always happens');
      for (const [i, step] of plan.entries())
        if (step.op === 'catchall')
          assert.equal(
            step.enable,
            i < dyn,
            `${label(from)}->${label(to)}: catchall ${step.enable ? 'on' : 'off'} on the wrong side`,
          );
      // Nothing to do for the catch-all when both states agree about it.
      assert.equal(
        plan.length,
        enabled.includes(CATCHALL_RULESET_ID) ===
          desiredRuleState(to, VIEWER).enabledStaticRulesets.includes(CATCHALL_RULESET_ID)
          ? 1
          : 2,
      );
    }
});
