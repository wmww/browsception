import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sliceTarget,
  viewerTarget,
  viewerParams,
  viewerURLFor,
  isHttpUrl,
} from '../../src/ext/viewer-url.mjs';

const VIEWER = 'chrome-extension://abcdefghijklmnop/ext/viewer.html';

test('sliceTarget takes everything after the first [?&]url= raw', () => {
  assert.equal(sliceTarget('?url=https://a.example/'), 'https://a.example/');
  // the target's own query and fragment belong to the target, not to us
  assert.equal(sliceTarget('?url=https://a.example/?x=1&y=2'), 'https://a.example/?x=1&y=2');
  assert.equal(sliceTarget('?blit=2d&url=https://a.example/#frag'), 'https://a.example/#frag');
  // a second url= inside the target is part of the target
  assert.equal(sliceTarget('?url=https://a.example/?url=https://b.example/'), 'https://a.example/?url=https://b.example/');
  assert.equal(sliceTarget('?url='), '');
  assert.equal(sliceTarget('?stub=1'), null);
  assert.equal(sliceTarget(''), null);
});

test('sliceTarget requires a [?&] boundary: favurl= is not url=', () => {
  assert.equal(sliceTarget('?favurl=https://a.example/'), null);
  // ...but a real url= later in the string still wins
  assert.equal(sliceTarget('?favurl=x&url=https://a.example/'), 'https://a.example/');
});

test('sliceTarget decodes the tolerated percent-encoded absolute form', () => {
  assert.equal(sliceTarget(`?url=${encodeURIComponent('https://a.example/')}`), 'https://a.example/');
  assert.equal(
    sliceTarget(`?url=${encodeURIComponent('https://a.example/?x=1&y=2#f')}`),
    'https://a.example/?x=1&y=2#f',
  );
  assert.equal(sliceTarget('?url=HTTP%3A%2F%2Fa.example%2F'), 'HTTP://a.example/');
  // malformed escape: the raw slice is all we have, no throw
  assert.equal(sliceTarget('?url=https%3A%2F%2Fa.example%2F%ZZ'), 'https%3A%2F%2Fa.example%2F%ZZ');
});

test('sliceTarget never decodes a non-http(s) target', () => {
  // nothing but an encoded absolute http(s) URL is decoded — everything else
  // passes through raw and dies at an isHttpUrl gate
  assert.equal(sliceTarget('?url=javascript:alert(1)'), 'javascript:alert(1)');
  assert.equal(sliceTarget('?url=file:///etc/passwd'), 'file:///etc/passwd');
  assert.equal(sliceTarget('?url=javascript%3Aalert(1)'), 'javascript%3Aalert(1)');
  assert.equal(sliceTarget('?url=data%3Atext%2Fhtml%2Cx'), 'data%3Atext%2Fhtml%2Cx');
});

test('sliceTarget glues the caller-supplied fragment onto a RAW target only', () => {
  // location.search excludes the hash, so a raw target's #frag arrives as ours
  assert.equal(sliceTarget('?url=https://a.example/p', '#frag'), 'https://a.example/p#frag');
  // an encoded target carries its fragment inside the decoded string
  assert.equal(sliceTarget('?url=https%3A%2F%2Fa.example%2Fp', '#frag'), 'https://a.example/p');
  // full tab URLs already include the fragment in the slice (no arg)
  assert.equal(sliceTarget(`${VIEWER}?url=https://a.example/p#frag`), 'https://a.example/p#frag');
});

test('viewerTarget gates on the viewer base', () => {
  assert.equal(viewerTarget(`${VIEWER}?url=https://a.example/?q=1`, VIEWER), 'https://a.example/?q=1');
  assert.equal(viewerTarget(`${VIEWER}?dpr=2&url=https://a.example/`, VIEWER), 'https://a.example/');
  // the sweep-bug case: an encoded target must parse, not reach tabs.update raw
  assert.equal(
    viewerTarget(`${VIEWER}?url=${encodeURIComponent('https://a.example/?q=1')}`, VIEWER),
    'https://a.example/?q=1',
  );
  assert.equal(viewerTarget('https://a.example/', VIEWER), null);
  assert.equal(viewerTarget(`${VIEWER}`, VIEWER), null);
  assert.equal(viewerTarget(`${VIEWER}?stub=1`, VIEWER), null);
  // a hostile page cannot fake a viewer tab by embedding the base in its query
  assert.equal(viewerTarget(`https://evil.example/?x=${VIEWER}?url=https://a.example/`, VIEWER), null);
});

test('viewerParams returns our own params, never the target', () => {
  assert.equal(viewerParams('?blit=2d&url=https://a.example/?blit=webgl'), 'blit=2d');
  assert.equal(viewerParams('?url=https://a.example/'), '');
  assert.equal(viewerParams('?stub=1'), 'stub=1');
  assert.equal(viewerParams(''), '');
  // round-trips through URLSearchParams without seeing the target's query
  assert.equal(new URLSearchParams(viewerParams('?blit=2d&url=https://a/?blit=webgl')).get('blit'), '2d');
});

test('viewerURLFor builds the canonical raw form', () => {
  assert.equal(viewerURLFor(VIEWER, 'https://a.example/?q=1'), `${VIEWER}?url=https://a.example/?q=1`);
  assert.equal(viewerURLFor(VIEWER, 'https://a.example/', 'blit=2d'), `${VIEWER}?blit=2d&url=https://a.example/`);
  // what it builds, it parses back
  const round = viewerURLFor(VIEWER, 'https://a.example/?x=1#f', 'persist=0');
  assert.equal(viewerTarget(round, VIEWER), 'https://a.example/?x=1#f');
  assert.equal(viewerParams(round.slice(VIEWER.length)), 'persist=0');
});

test('isHttpUrl passes only absolute http(s)', () => {
  assert.equal(isHttpUrl('https://a.example/'), true);
  assert.equal(isHttpUrl('http://a.example:8080/x?y#z'), true);
  assert.equal(isHttpUrl('file:///etc/passwd'), false);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('data:text/html,x'), false);
  assert.equal(isHttpUrl('chrome-extension://abc/x.html'), false);
  assert.equal(isHttpUrl('https%3A%2F%2Fa.example%2F'), false); // still-encoded
  assert.equal(isHttpUrl('/relative'), false);
  assert.equal(isHttpUrl('not a url'), false);
  assert.equal(isHttpUrl(''), false);
});
